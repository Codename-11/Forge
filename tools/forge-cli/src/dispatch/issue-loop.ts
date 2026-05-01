import os from "node:os";
import chalk from "chalk";
import { callTool, type AgentMe } from "../mcp.js";
import type { AuthFile } from "../auth.js";
import { runClaudeIssue, type ClaudeUsage } from "./claude-code.js";
import { inlineAttachments, loadIssueBundle } from "./context.js";
import type { IssueBundle } from "./types.js";

/**
 * AGENT_ASSIGNED handler — full agent loop.
 *
 * Flow:
 *   1. Read `payload.issueSnapshot` for fast initial framing (already
 *      enriched server-side in `audit.ts`).
 *   2. Bundle full context via `agent.context.bundle({ issueId })`.
 *   3. Inline attachments under the mime allowlist.
 *   4. Spawn the provider's adapter (only CLAUDE wired in v1) with
 *      the bundle + a starter prompt.
 *   5. Post progress comments at message boundaries (each assistant
 *      block boundary is a natural cut).
 *   6. Post a final summary comment on exit.
 *   7. Call `runs.recordUsage` if a runId is in scope.
 *
 * The server opens an `AgentRun` row when the daemon's first
 * `comments.create` lands (audit fan-out on AGENT_ASSIGNED →
 * DISPATCH_RECEIVED). We grab the runId from a follow-up
 * `agent.context.bundle` after the first comment posts.
 *
 * Auto-transition to IN_PROGRESS happens between Step 1 and Step 2: the
 * daemon calls `statuses.list({ category: "IN_PROGRESS" })`, picks the
 * first status the workspace exposes, and calls `issues.transition` to
 * flip the issue. Skipped when the issue is already in IN_PROGRESS or
 * IN_REVIEW. If the workspace has no IN_PROGRESS-category status the
 * step is a no-op (the agent still works the issue; status just stays).
 */

export interface IssueSnapshotPayload {
  id: string;
  number: number;
  title: string;
  priority: string;
  statusId: string;
  projectId: string | null;
  labelNames: string[];
}

export interface AgentAssignedPayload {
  agentId?: string;
  previousAgentId?: string | null;
  issueSnapshot?: IssueSnapshotPayload;
  runtimeId?: string;
  [key: string]: unknown;
}

export interface AgentAssignedEvent {
  id?: string;
  workspaceId: string;
  kind: string;
  subjectType?: string;
  subjectId?: string;
  payload?: AgentAssignedPayload | null;
}

export async function handleAgentAssigned(args: {
  auth: AuthFile;
  agent: AgentMe;
  evt: AgentAssignedEvent;
  foreground: boolean;
}): Promise<void> {
  const { auth, agent, evt, foreground } = args;
  const issueId = evt.subjectId;
  if (!issueId) return;

  const snap = evt.payload?.issueSnapshot;
  const ident = snap
    ? `issue #${snap.number} (${snap.title})`
    : `issue ${issueId}`;

  if (foreground) {
    console.log(
      chalk.cyan(`  → AGENT_ASSIGNED for ${agent.profileKey} on ${ident}`),
    );
  }

  // Provider gating — only CLAUDE has a real loop. Anything else falls
  // through to a placeholder comment that explains the situation.
  if (agent.provider !== "CLAUDE") {
    try {
      await callTool(auth, "comments.create", {
        issueId,
        body: `[forge-cli local daemon] Picked up assignment on ${os.hostname()}, but the \`${agent.provider}\` provider adapter isn't implemented yet. The full agent loop only runs for CLAUDE today.`,
      });
    } catch (err) {
      console.error(`[issue-loop] comments.create failed:`, err);
    }
    return;
  }

  // Step 1 — bundle context.
  const bundle = await loadIssueBundle(auth, issueId);
  if (!bundle) {
    if (foreground) {
      console.log(
        chalk.yellow(`  could not bundle context for ${ident}; aborting`),
      );
    }
    try {
      await callTool(auth, "comments.create", {
        issueId,
        body: `[forge-cli daemon on ${os.hostname()}] Picked up assignment but \`agent.context.bundle\` failed; check API key scopes (READ_ISSUES required).`,
      });
    } catch (err) {
      console.error(`[issue-loop] failure-comment failed:`, err);
    }
    return;
  }

  // Step 1.5 — auto-transition to IN_PROGRESS if the issue isn't already
  // started. Skipped on workspaces with no IN_PROGRESS-category status.
  await maybeTransitionToInProgress(auth, issueId, bundle, foreground);

  // Step 2 — inline attachments.
  const attachments = await inlineAttachments(
    auth,
    (bundle.attachments ?? []) as Array<{
      id: string;
      mimeType: string;
      filename?: string | null;
      sizeBytes?: number | null;
    }>,
  );

  // Step 3 — starter comment so the operator sees the daemon picked it up
  // AND so the audit fan-out opens the AgentRun (giving us a runId).
  let runId: string | null = bundle.currentRun?.id ?? null;
  try {
    await callTool(auth, "comments.create", {
      issueId,
      body: `[forge-cli daemon on ${os.hostname()}] Picked up assignment for ${agent.profileKey}. Bundling context (${bundle.comments?.length ?? 0} comments, ${bundle.attachments?.length ?? 0} attachments, ${attachments.length} inlined) and spawning Claude Code now.`,
    });
  } catch (err) {
    console.error(`[issue-loop] starter comment failed:`, err);
  }

  // Re-bundle to grab the runId the server opened on AGENT_ASSIGNED.
  if (!runId) {
    await delay(400);
    const fresh = await loadIssueBundle(auth, issueId);
    runId = fresh?.currentRun?.id ?? null;
    if (fresh) {
      // Use the freshest bundle (in case state changed during the gap).
      Object.assign(bundle, fresh);
    }
  }
  if (foreground && runId) {
    console.log(chalk.gray(`    runId=${runId}`));
  }

  // Step 4 — spawn claude with the bundle + attachments.
  const postedSet = new Set<string>(); // dedupe progress comments
  let progressCounter = 0;

  let lastUsage: ClaudeUsage = {};

  try {
    const result = await runClaudeIssue(
      {
        auth,
        agent: {
          id: agent.id,
          profileKey: agent.profileKey,
          name: agent.name,
          provider: agent.provider,
        },
        issueId,
        bundle: bundle as IssueBundle,
        attachments,
        workspaceSlug: auth.workspaceSlug,
        runId,
      },
      // onProgress — at each assistant message boundary, post a comment.
      // Cap at first ~12 progress messages per run so a chatty model
      // doesn't spam the comment thread.
      (text) => {
        if (progressCounter >= 12) return;
        const key = text.slice(0, 80);
        if (postedSet.has(key)) return;
        postedSet.add(key);
        progressCounter += 1;
        // Fire-and-forget; comment failures shouldn't block the loop.
        void callTool(auth, "comments.create", {
          issueId,
          body: text,
        }).catch((err) => {
          console.error(`[issue-loop] progress comments.create failed:`, err);
        });
      },
    );
    lastUsage = result.usage;

    // Step 5 — final summary comment if we have one and it wasn't posted
    // already by the progress callback (heuristic: assistant's last
    // message frequently equals the result; if it's already in
    // `postedSet`, skip to avoid the double-post).
    const finalKey = result.finalText.slice(0, 80);
    if (
      result.finalText &&
      !postedSet.has(finalKey) &&
      result.exitCode === 0
    ) {
      try {
        await callTool(auth, "comments.create", {
          issueId,
          body: result.finalText,
        });
      } catch (err) {
        console.error(`[issue-loop] final comments.create failed:`, err);
      }
    }
    if (result.exitCode !== 0) {
      try {
        await callTool(auth, "comments.create", {
          issueId,
          body: `[forge-cli daemon] Claude Code exited with code ${result.exitCode}. The run is left open for human intervention.${result.finalText ? `\n\nLast output:\n${result.finalText.slice(0, 2_000)}` : ""}`,
        });
      } catch (err) {
        console.error(`[issue-loop] error comments.create failed:`, err);
      }
    }
  } catch (err) {
    console.error(`[issue-loop] runClaudeIssue threw:`, err);
    try {
      await callTool(auth, "comments.create", {
        issueId,
        body: `[forge-cli daemon] Unexpected error while running Claude Code: ${err instanceof Error ? err.message : String(err)}. Run left open.`,
      });
    } catch (commentErr) {
      console.error(`[issue-loop] crash-comment failed:`, commentErr);
    }
  }

  // Step 6 — record usage if we have a runId AND any token counts.
  if (runId && (lastUsage.tokensIn || lastUsage.tokensOut || lastUsage.tokensCached || lastUsage.costUsd)) {
    try {
      await callTool(auth, "runs.recordUsage", {
        runId,
        ...lastUsage,
      });
      if (foreground) {
        console.log(
          chalk.gray(
            `    runs.recordUsage runId=${runId} ${JSON.stringify(lastUsage)}`,
          ),
        );
      }
    } catch (err) {
      console.error(`[issue-loop] runs.recordUsage failed:`, err);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StatusRow {
  id: string;
  name: string;
  category: string;
  position: number;
  isDefault: boolean;
}

/**
 * Discover the workspace's IN_PROGRESS status row via `statuses.list`
 * and call `issues.transition` if the issue isn't already started.
 * Best-effort: any failure logs and returns; we'd rather work the
 * issue with the wrong status than abort the whole assignment.
 */
async function maybeTransitionToInProgress(
  auth: AuthFile,
  issueId: string,
  bundle: IssueBundle,
  foreground: boolean,
): Promise<void> {
  const issue = bundle.issue as Record<string, unknown> & {
    status?: { id: string; category: string };
  };
  const currentCategory = issue.status?.category;
  if (currentCategory === "IN_PROGRESS" || currentCategory === "IN_REVIEW") {
    if (foreground) {
      console.log(
        chalk.gray(
          `    status already ${currentCategory}; skipping auto-transition`,
        ),
      );
    }
    return;
  }

  let started: StatusRow[] = [];
  try {
    const result = await callTool<StatusRow[]>(auth, "statuses.list", {
      category: "IN_PROGRESS",
    });
    started = result.data ?? [];
  } catch (err) {
    console.error(`[issue-loop] statuses.list failed:`, err);
    return;
  }

  if (started.length === 0) {
    if (foreground) {
      console.log(
        chalk.gray(
          `    no IN_PROGRESS-category status in workspace; leaving as-is`,
        ),
      );
    }
    return;
  }

  // Prefer the default status if it exists in the IN_PROGRESS category;
  // otherwise the first one by position.
  const target =
    started.find((s) => s.isDefault) ?? started[0];

  try {
    await callTool(auth, "issues.transition", {
      id: issueId,
      statusId: target.id,
    });
    if (foreground) {
      console.log(
        chalk.cyan(`    transitioned to "${target.name}" (${target.id})`),
      );
    }
    // Reflect the new status into the bundle so downstream code (system
    // prompt, comments) reads the post-transition state.
    if (issue.status) {
      issue.status.id = target.id;
      issue.status.category = target.category;
    }
  } catch (err) {
    console.error(`[issue-loop] issues.transition failed:`, err);
  }
}
