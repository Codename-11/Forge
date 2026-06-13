import "server-only";
import { AgentRunStatus, EventKind, Prisma } from "@prisma/client";
import type { AgentProvider } from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import {
  openOrTouchRun,
  appendRunEvent,
  finishRun,
  postAgentRunComment,
} from "@/server/services/agent-run";
import { FORGE_RUN_CONTRACT_VERSION, forgeRunInstruction } from "@/server/services/engagement-mode";
import { buildRuntimePolicySnapshot } from "@/lib/runtime-enforcement";
import { getRunsConnectorForAgent, resolveRunEngine, type AgentRuntimeRef } from "./registry";

/**
 * Dispatch-via-runs ingestion (worker-hosted, poll-based).
 *
 * Phase 2 of the pluggable-engine work. When an issue wakes work for a
 * RUNS-engine agent, Forge drives the work through the provider's
 * structured agent-run API (Hermes `/v1/runs`) rather than a webhook.
 * Assignment events and comment/watcher-created AgentRuns share this path:
 *
 *   1. `startNewRuns` — find recent AGENT_ASSIGNED events and unbacked ACTIVE
 *      AgentRuns whose agent is RUNS-capable; call `startRun` on the
 *      connector and stash `externalRunId`.
 *   2. `pollActiveRuns` — for ACTIVE AgentRuns with an `externalRunId`, poll
 *      `getStatus` and mirror it onto the AgentRun (currentStep / token
 *      usage / terminal finish) so Mission Control reflects live progress.
 *
 * Polling (vs a live SSE subscription) fits the worker's short-job model
 * and is trivially restart-safe — there's no in-memory subscription state
 * to lose. The webhook path remains for COMPLETIONS / legacy agents; a
 * RUNS agent simply shouldn't also carry a dispatch `webhookUrl` (that
 * would double-dispatch).
 */

const RUN_START_LOOKBACK_MS = 15 * 60_000;
const UNBACKED_RUN_RECOVERY_LOOKBACK_MS = 60 * 60_000;
// A paused run can sit WAITING for days before the operator replies, so the
// resume scan reaches back much further than the unbacked-recovery window —
// correctness is gated on the reply being newer than the pause, not on pause
// age. Bounded only so we don't scan runs the stale-run watchdog has long
// since flagged for abandonment.
const RESUME_WAITING_LOOKBACK_MS = 14 * 24 * 60 * 60_000;
const START_BATCH = 10;
const POLL_BATCH = 25;
const TERMINAL_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  AgentRunStatus.COMPLETED,
  AgentRunStatus.ABANDONED,
  AgentRunStatus.STALLED,
]);

function hasForgeCompletionMeta(value: Prisma.JsonValue | null | undefined): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).contractVersion === "string"
  );
}

function issueMessage(
  issue: {
    id: string;
    key: string;
    title: string;
    description: string | null;
  },
  engagementInstruction?: string | null,
  runId?: string | null,
): string {
  const body = issue.description?.trim();
  return (
    (engagementInstruction ? `${engagementInstruction}\n\n` : "") +
    `You are dispatched for Forge issue ${issue.key}: ${issue.title}.\n` +
    `Issue id: ${issue.id}.\n` +
    (runId ? `Current AgentRun id: ${runId}.\n` : "") +
    "\n" +
    (body ? `${body}\n\n` : "") +
    `Handle the issue according to the engagement mode and Forge run protocol above.`
  );
}

/** Issue keys are derived (`<workspace.key>-<number>`), not a column. */
function issueKey(workspaceKey: string, number: number): string {
  return `${workspaceKey}-${number}`;
}

function shouldUseRunsEngine(agent: {
  runEngine: "COMPLETIONS" | "RUNS" | null;
  provider: AgentProvider;
  runtime?: AgentRuntimeRef;
}): boolean {
  if (!agent.runtime?.adapterKey && agent.runEngine !== "RUNS") return false;
  return (
    resolveRunEngine({
      runEngine: agent.runEngine,
      provider: agent.provider,
      runtime: agent.runtime,
    }) === "RUNS"
  );
}

/** Open AgentRuns + start provider runs for fresh RUNS-engine assignments. */
async function startNewRuns(): Promise<number> {
  const events = await db.activityEvent.findMany({
    where: {
      kind: EventKind.AGENT_ASSIGNED,
      subjectType: "issue",
      createdAt: { gte: new Date(Date.now() - RUN_START_LOOKBACK_MS) },
    },
    orderBy: { createdAt: "desc" },
    take: START_BATCH * 3,
    select: { id: true, workspaceId: true, subjectId: true, payload: true },
  });

  let started = 0;
  for (const evt of events) {
    if (started >= START_BATCH) break;
    if (!evt.subjectId) continue;
    // Dedup: one provider run per assignment event. The durable inbox creates
    // a canonical AgentRun in the same transaction as AGENT_ASSIGNED, before
    // this worker dials the provider; that precreated row must be reused, not
    // treated as already-dispatched.
    const already = await db.agentRun.findFirst({
      where: { assignmentEventId: evt.id },
      select: { id: true, status: true, externalRunId: true },
    });
    if (already?.externalRunId || (already && TERMINAL_RUN_STATUSES.has(already.status))) {
      continue;
    }

    const issue = await db.issue.findUnique({
      where: { id: evt.subjectId },
      select: {
        id: true,
        number: true,
        title: true,
        description: true,
        assignedAgentId: true,
        workspace: { select: { key: true } },
        assignedAgent: {
          select: {
            id: true,
            provider: true,
            runEngine: true,
            runtime: {
              select: {
                adapterKey: true,
                endpoint: true,
                secret: true,
                config: true,
                disabledAt: true,
                name: true,
              },
            },
          },
        },
      },
    });
    const agent = issue?.assignedAgent;
    if (!issue || !agent) continue;
    // Paused runtime: skip dispatch entirely (don't open a run that the
    // disabled-sentinel connector would only fail). The assignment stays
    // queued and dispatches once the runtime is re-enabled.
    if (agent.runtime?.disabledAt) continue;
    if (!shouldUseRunsEngine(agent)) {
      continue;
    }
    const connector = getRunsConnectorForAgent({
      provider: agent.provider,
      runtime: agent.runtime,
    });
    if (!connector) continue;

    // Engagement mode (AXI-53): the assignment payload carries the resolved
    // mode; inject its instruction block so the agent knows whether to execute,
    // research, review, or just discuss. Default EXECUTE when absent (legacy).
    const evtPayload =
      evt.payload && typeof evt.payload === "object" && !Array.isArray(evt.payload)
        ? (evt.payload as Record<string, unknown>)
        : {};
    const engagementMode =
      (evtPayload.engagementMode as "EXECUTE" | "RESEARCH" | "REVIEW" | "DISCUSS" | undefined) ??
      "EXECUTE";
    const instruction = forgeRunInstruction({
      mode: engagementMode,
      source: "surface-default",
      inferable: false,
    });
    const runtimePolicy = buildRuntimePolicySnapshot({
      contractVersion: FORGE_RUN_CONTRACT_VERSION,
      engagementMode,
      adapterKey: agent.runtime?.adapterKey ?? (agent.provider === "HERMES" ? "hermes" : null),
      runtimeName: agent.runtime?.name ?? null,
      config: agent.runtime?.config,
    });

    try {
      const { externalRunId } = await connector.startRun({
        message: issueMessage(
          {
            id: issue.id,
            key: issueKey(issue.workspace.key, issue.number),
            title: issue.title,
            description: issue.description,
          },
          instruction,
          already?.id ?? null,
        ),
        instructions: instruction,
        engagementMode,
        contractVersion: FORGE_RUN_CONTRACT_VERSION,
        toolPolicy: runtimePolicy,
      });
      await db.$transaction(async (tx) => {
        const { run } = await openOrTouchRun(tx, {
          workspaceId: evt.workspaceId,
          issueId: issue.id,
          agentId: agent.id,
          assignmentEventId: evt.id,
          currentStep: "starting run",
          engagementMode,
        });
        await tx.agentRun.update({
          where: { id: run.id },
          data: {
            externalRunId,
            acknowledgedAt: new Date(),
            runtimePolicy: runtimePolicy as unknown as Prisma.InputJsonValue,
          },
        });
        await appendRunEvent(tx, {
          runId: run.id,
          workspaceId: evt.workspaceId,
          issueId: issue.id,
          agentId: agent.id,
          kind: "DISPATCH_STARTED",
          currentStep: "running",
          payload: {
            externalRunId,
            engine: "RUNS",
            reusedCanonicalRun: already?.id ?? null,
            contractVersion: FORGE_RUN_CONTRACT_VERSION,
            runtimePolicy: {
              adapterKey: runtimePolicy.adapterKey,
              layers: runtimePolicy.layers.map((layer) => ({
                kind: layer.kind,
                enforced: layer.enforced,
              })),
              allowedHostTools: runtimePolicy.allowedHostTools,
            },
          },
        });
      });
      started++;
    } catch (err) {
      logger.warn({ err, eventId: evt.id, issueId: issue.id }, "runs-dispatch: start failed");
    }
  }
  if (started < START_BATCH) {
    started += await startUnbackedAgentRuns(START_BATCH - started);
  }
  return started;
}

/** Start structured provider sessions for non-assignment wakes, e.g. comments. */
async function startUnbackedAgentRuns(limit: number): Promise<number> {
  if (limit <= 0) return 0;
  const runs = await db.agentRun.findMany({
    where: {
      status: AgentRunStatus.ACTIVE,
      externalRunId: null,
      OR: [
        { startedAt: { gte: new Date(Date.now() - RUN_START_LOOKBACK_MS) } },
        { lastEventAt: { gte: new Date(Date.now() - UNBACKED_RUN_RECOVERY_LOOKBACK_MS) } },
        { lastWakeAt: { gte: new Date(Date.now() - UNBACKED_RUN_RECOVERY_LOOKBACK_MS) } },
      ],
    },
    orderBy: { lastEventAt: "desc" },
    take: limit * 3,
    select: {
      id: true,
      workspaceId: true,
      issueId: true,
      agentId: true,
      engagementMode: true,
      triggerKind: true,
      triggerEventId: true,
      issue: {
        select: {
          id: true,
          number: true,
          title: true,
          description: true,
          workspace: { select: { key: true } },
        },
      },
      agent: {
        select: {
          id: true,
          provider: true,
          runEngine: true,
          runtime: {
            select: {
              adapterKey: true,
              endpoint: true,
              secret: true,
              config: true,
              disabledAt: true,
              name: true,
            },
          },
        },
      },
    },
  });

  let started = 0;
  for (const run of runs) {
    if (started >= limit) break;
    if (run.agent.runtime?.disabledAt) continue;
    if (!shouldUseRunsEngine(run.agent)) {
      continue;
    }
    const connector = getRunsConnectorForAgent({
      provider: run.agent.provider,
      runtime: run.agent.runtime,
    });
    if (!connector) continue;

    const engagementMode = run.engagementMode;
    const instruction = forgeRunInstruction({
      mode: engagementMode,
      source: "surface-default",
      inferable: false,
    });
    const runtimePolicy = buildRuntimePolicySnapshot({
      contractVersion: FORGE_RUN_CONTRACT_VERSION,
      engagementMode,
      adapterKey:
        run.agent.runtime?.adapterKey ?? (run.agent.provider === "HERMES" ? "hermes" : null),
      runtimeName: run.agent.runtime?.name ?? null,
      config: run.agent.runtime?.config,
    });

    try {
      const { externalRunId } = await connector.startRun({
        message: issueMessage(
          {
            id: run.issue.id,
            key: issueKey(run.issue.workspace.key, run.issue.number),
            title: run.issue.title,
            description: run.issue.description,
          },
          instruction,
          run.id,
        ),
        instructions: instruction,
        engagementMode,
        contractVersion: FORGE_RUN_CONTRACT_VERSION,
        toolPolicy: runtimePolicy,
      });
      await db.$transaction(async (tx) => {
        await tx.agentRun.update({
          where: { id: run.id },
          data: {
            externalRunId,
            acknowledgedAt: new Date(),
            currentStep: "starting run",
            runtimePolicy: runtimePolicy as unknown as Prisma.InputJsonValue,
          },
        });
        await appendRunEvent(tx, {
          runId: run.id,
          workspaceId: run.workspaceId,
          issueId: run.issueId,
          agentId: run.agentId,
          kind: "DISPATCH_STARTED",
          currentStep: "running",
          payload: {
            externalRunId,
            engine: "RUNS",
            reusedCanonicalRun: run.id,
            triggerKind: run.triggerKind,
            triggerEventId: run.triggerEventId,
            contractVersion: FORGE_RUN_CONTRACT_VERSION,
            runtimePolicy: {
              adapterKey: runtimePolicy.adapterKey,
              layers: runtimePolicy.layers.map((layer) => ({
                kind: layer.kind,
                enforced: layer.enforced,
              })),
              allowedHostTools: runtimePolicy.allowedHostTools,
            },
          },
        });
      });
      started++;
    } catch (err) {
      logger.warn(
        { err, runId: run.id, issueId: run.issueId },
        "runs-dispatch: start unbacked run failed",
      );
    }
  }
  return started;
}

/**
 * Re-dispatch WAITING RUNS-engine runs that have a fresh operator reply.
 *
 * When an agent calls `runs.setWaiting({ blocking: true })` its provider turn
 * ends and the AgentRun goes WAITING with a stashed `externalRunId`. Nothing
 * else re-invokes it: `startUnbackedAgentRuns` only catches ACTIVE/unbacked
 * runs and `pollActiveRuns` only polls ACTIVE — so an operator reply (the
 * Nudge button or an `@agent` comment) had no effect for RUNS agents, even
 * though the issue panel invited one. Here we pick up a WAITING run once a
 * comment lands *after* it paused, fold the waiting reason + the reply(s) into
 * a fresh turn, and flip it back to ACTIVE (the provider connector opens a new
 * thread, so context travels in the message, same as initial dispatch).
 *
 * Dedup is the `lastEventAt` watermark: we only consider comments newer than
 * the moment the run paused, and flip `lastEventAt` on resume — so the same
 * reply can't re-trigger, and if the agent pauses again only newer replies
 * wake it.
 */
async function resumeWaitingRuns(limit: number): Promise<number> {
  if (limit <= 0) return 0;
  const waiting = await db.agentRun.findMany({
    where: {
      status: AgentRunStatus.WAITING,
      externalRunId: { not: null },
      lastEventAt: { gte: new Date(Date.now() - RESUME_WAITING_LOOKBACK_MS) },
    },
    orderBy: { lastEventAt: "desc" },
    take: limit * 3,
    select: {
      id: true,
      workspaceId: true,
      issueId: true,
      agentId: true,
      engagementMode: true,
      currentStep: true,
      summary: true,
      lastEventAt: true,
      issue: {
        select: {
          id: true,
          number: true,
          title: true,
          description: true,
          workspace: { select: { key: true } },
        },
      },
      agent: {
        select: {
          id: true,
          provider: true,
          runEngine: true,
          runtime: {
            select: {
              adapterKey: true,
              endpoint: true,
              secret: true,
              config: true,
              disabledAt: true,
              name: true,
            },
          },
        },
      },
    },
  });

  let resumed = 0;
  for (const run of waiting) {
    if (resumed >= limit) break;
    if (run.agent.runtime?.disabledAt) continue;
    if (!shouldUseRunsEngine(run.agent)) continue;
    const connector = getRunsConnectorForAgent({
      provider: run.agent.provider,
      runtime: run.agent.runtime,
    });
    if (!connector?.startRun) continue;

    // A reply that landed after the run paused wakes it. Any comment the agent
    // didn't author itself counts — the Nudge button and a plain `@agent`
    // comment both produce one. Skip the agent's own posts so its closing
    // status note doesn't self-resume.
    const replies = await db.comment.findMany({
      where: {
        issueId: run.issueId,
        createdAt: { gt: run.lastEventAt },
        deletedAt: null,
        // Anything the waiting agent didn't author itself. Must include human
        // comments (authoringAgentId IS NULL) — a bare `NOT: { authoringAgentId }`
        // drops NULLs under SQL three-valued logic, so spell out the OR.
        OR: [{ authoringAgentId: null }, { authoringAgentId: { not: run.agentId } }],
      },
      orderBy: { createdAt: "asc" },
      take: 10,
      select: {
        body: true,
        author: { select: { name: true } },
        authoringAgent: { select: { name: true } },
      },
    });
    if (replies.length === 0) continue;

    const engagementMode = run.engagementMode;
    const instruction = forgeRunInstruction({
      mode: engagementMode,
      source: "surface-default",
      inferable: false,
    });
    const runtimePolicy = buildRuntimePolicySnapshot({
      contractVersion: FORGE_RUN_CONTRACT_VERSION,
      engagementMode,
      adapterKey:
        run.agent.runtime?.adapterKey ?? (run.agent.provider === "HERMES" ? "hermes" : null),
      runtimeName: run.agent.runtime?.name ?? null,
      config: run.agent.runtime?.config,
    });

    const waitingReason = (run.currentStep || run.summary || "").trim();
    const replyBlock = replies
      .map(
        (r) =>
          `${r.authoringAgent?.name ?? r.author?.name ?? "Operator"}: ${r.body}`,
      )
      .join("\n\n");
    const message =
      issueMessage(
        {
          id: run.issue.id,
          key: issueKey(run.issue.workspace.key, run.issue.number),
          title: run.issue.title,
          description: run.issue.description,
        },
        instruction,
        run.id,
      ) +
      `\n\nYou paused this run earlier` +
      (waitingReason ? ` because: ${waitingReason}` : "") +
      `.\nThe operator has replied:\n\n${replyBlock}\n\n` +
      `Resume with this new context. Close the run via runs.complete when done, ` +
      `or pause again with runs.setWaiting if you're still blocked.`;

    try {
      const { externalRunId } = await connector.startRun({
        message,
        instructions: instruction,
        engagementMode,
        contractVersion: FORGE_RUN_CONTRACT_VERSION,
        toolPolicy: runtimePolicy,
      });
      await db.$transaction(async (tx) => {
        await tx.agentRun.update({
          where: { id: run.id },
          data: {
            status: AgentRunStatus.ACTIVE,
            externalRunId,
            currentStep: "resuming after reply",
            lastEventAt: new Date(),
            awaitingApprovalAt: null,
            runtimePolicy: runtimePolicy as unknown as Prisma.InputJsonValue,
          },
        });
        await appendRunEvent(tx, {
          runId: run.id,
          workspaceId: run.workspaceId,
          issueId: run.issueId,
          agentId: run.agentId,
          kind: "DISPATCH_STARTED",
          currentStep: "resuming after reply",
          payload: {
            externalRunId,
            engine: "RUNS",
            resumedFromWaiting: true,
            replyCount: replies.length,
            contractVersion: FORGE_RUN_CONTRACT_VERSION,
          },
        });
      });
      resumed++;
    } catch (err) {
      logger.warn(
        { err, runId: run.id, issueId: run.issueId },
        "runs-dispatch: resume waiting run failed",
      );
    }
  }
  return resumed;
}

/** Poll live provider runs and mirror status onto the AgentRun. */
async function pollActiveRuns(): Promise<number> {
  const runs = await db.agentRun.findMany({
    where: { status: AgentRunStatus.ACTIVE, externalRunId: { not: null } },
    orderBy: { lastEventAt: "asc" },
    take: POLL_BATCH,
    select: {
      id: true,
      workspaceId: true,
      issueId: true,
      agentId: true,
      externalRunId: true,
      currentStep: true,
      awaitingApprovalAt: true,
      summary: true,
      completionMeta: true,
      agent: {
        select: {
          provider: true,
          runtime: {
            select: {
              adapterKey: true,
              endpoint: true,
              secret: true,
              config: true,
              disabledAt: true,
              name: true,
            },
          },
        },
      },
    },
  });

  let polled = 0;
  for (const run of runs) {
    const connector = getRunsConnectorForAgent({
      provider: run.agent.provider,
      runtime: run.agent.runtime,
    });
    if (!connector?.getStatus || !run.externalRunId) continue;
    let status;
    try {
      status = await connector.getStatus(run.externalRunId);
    } catch (err) {
      logger.warn({ err, runId: run.id }, "runs-dispatch: poll failed");
      continue;
    }
    polled++;

    if (status.state === "waiting_for_approval") {
      // Transition into a blocked state (set the flag + a BLOCKED event)
      // only once, so we don't spam the timeline while it waits.
      if (!run.awaitingApprovalAt) {
        await db
          .$transaction(async (tx) => {
            await tx.agentRun.update({
              where: { id: run.id },
              data: { awaitingApprovalAt: new Date() },
            });
            await appendRunEvent(tx, {
              runId: run.id,
              workspaceId: run.workspaceId,
              issueId: run.issueId,
              agentId: run.agentId,
              kind: "BLOCKED",
              currentStep: "waiting for approval",
              payload: { lastEvent: status.lastEvent ?? null },
            });
          })
          .catch((err) =>
            logger.warn({ err, runId: run.id }, "runs-dispatch: block update failed"),
          );
      }
      continue;
    }

    if (status.state === "running") {
      const step = status.lastEvent ?? "running";
      // Clear a prior approval block (operator approved → agent resumed)
      // or just advance the step label.
      if (run.awaitingApprovalAt || step !== run.currentStep) {
        const hasLiveEventStream = Boolean(connector.subscribe);
        await db
          .$transaction(async (tx) => {
            if (hasLiveEventStream) {
              await tx.agentRun.update({
                where: { id: run.id },
                data: {
                  lastEventAt: new Date(),
                  currentStep: step,
                  ...(run.awaitingApprovalAt ? { awaitingApprovalAt: null } : {}),
                },
              });
              return;
            }
            await appendRunEvent(tx, {
              runId: run.id,
              workspaceId: run.workspaceId,
              issueId: run.issueId,
              agentId: run.agentId,
              kind: "STEP",
              currentStep: step,
              payload: { lastEvent: status.lastEvent ?? null, currentStep: step },
            });
          })
          .catch((err) => logger.warn({ err, runId: run.id }, "runs-dispatch: step update failed"));
      }
      continue;
    }

    // Terminal — finish the run and mirror usage. Provider-side
    // "completed" is not enough to complete a Forge issue run; agents must
    // close through runs.complete so mode-specific contracts are validated.
    let terminal: "COMPLETED" | "ABANDONED" | "STALLED" =
      status.state === "completed"
        ? "COMPLETED"
        : status.state === "cancelled"
          ? "ABANDONED"
          : "STALLED";
    let summary = status.output ?? run.summary ?? null;
    if (terminal === "COMPLETED" && !hasForgeCompletionMeta(run.completionMeta)) {
      terminal = "STALLED";
      summary =
        "Provider run ended without a valid Forge runs.complete contract. " +
        (status.output ? `Provider output: ${status.output}` : "No provider output was reported.");
    }
    await db
      .$transaction(async (tx) => {
        await finishRun(tx, {
          runId: run.id,
          workspaceId: run.workspaceId,
          issueId: run.issueId,
          agentId: run.agentId,
          status: terminal,
          summary,
        });
        // Surface a terminal *failure* on the issue itself. A clean
        // COMPLETED run closed through `runs.complete`, so the agent has
        // already posted its own comments via MCP — re-posting the summary
        // would duplicate. But a STALLED/ABANDONED run's output otherwise
        // lives only in `AgentRun.summary` (Mission Control overlay only),
        // so without this a failed dispatch is invisible on the issue. Post
        // it as an agent-authored comment so the timeline + watcher
        // notifications carry it like any other reply.
        if (terminal !== "COMPLETED" && run.issueId && summary) {
          await postAgentRunComment(tx, {
            workspaceId: run.workspaceId,
            issueId: run.issueId,
            agentId: run.agentId,
            body:
              `[dispatch · run ${terminal.toLowerCase()}]\n\n` +
              summary,
          });
        }
        const usage = status.usage;
        await tx.agentRun.update({
          where: { id: run.id },
          data: {
            awaitingApprovalAt: null,
            pendingApproval: Prisma.DbNull,
            ...(usage && (usage.tokensIn || usage.tokensOut || usage.costUsd)
              ? {
                  tokensIn: usage.tokensIn ?? null,
                  tokensOut: usage.tokensOut ?? null,
                  costUsd: usage.costUsd ?? null,
                }
              : {}),
          },
        });
      })
      .catch((err) => logger.warn({ err, runId: run.id }, "runs-dispatch: finish failed"));
  }
  return polled;
}

// ---------------------------------------------------------------------------
// Live `/events` enrichment.
//
// Polling (above) owns the run lifecycle: terminal finish, usage, and the
// awaitingApproval flag. This layer adds a *live* SSE subscription per run
// that enriches the timeline with per-tool / thinking steps and — crucially
// — captures the exact command behind an `approval.request` (the poll status
// can't see it). Subscriptions are tracked in-process and re-established by
// the sweep, so a worker restart self-heals (no durable subscription state).
// ---------------------------------------------------------------------------

const subscriptions = new Map<string, AbortController>();

function fireDb(p: Promise<unknown>, runId: string, what: string): void {
  void p.catch((err) => logger.warn({ err, runId }, `runs-dispatch: ${what} failed`));
}

async function subscribeRun(run: {
  id: string;
  workspaceId: string;
  issueId: string;
  agentId: string;
  externalRunId: string;
  provider: AgentProvider;
  runtime?: AgentRuntimeRef;
}): Promise<void> {
  if (subscriptions.has(run.id)) return;
  const connector = getRunsConnectorForAgent({ provider: run.provider, runtime: run.runtime });
  if (!connector?.subscribe) return;
  const ctrl = new AbortController();
  subscriptions.set(run.id, ctrl);
  const base = {
    runId: run.id,
    workspaceId: run.workspaceId,
    issueId: run.issueId,
    agentId: run.agentId,
  };
  try {
    await connector.subscribe(
      run.externalRunId,
      (e) => {
        switch (e.type) {
          case "tool_started":
            fireDb(
              db.$transaction((tx) =>
                appendRunEvent(tx, {
                  ...base,
                  kind: "TOOL_CALL",
                  currentStep: `running ${e.tool}`,
                  payload: { tool: e.tool, preview: e.preview ?? null },
                }),
              ),
              run.id,
              "tool step",
            );
            break;
          case "tool_completed":
            fireDb(
              db.$transaction((tx) =>
                appendRunEvent(tx, {
                  ...base,
                  kind: "TOOL_CALL",
                  payload: { tool: e.tool, done: true, error: e.isError ?? false },
                }),
              ),
              run.id,
              "tool done",
            );
            break;
          case "thinking":
            fireDb(
              db.$transaction((tx) =>
                appendRunEvent(tx, {
                  ...base,
                  kind: "STEP",
                  currentStep: "thinking",
                  payload: { thinking: e.text.slice(0, 280) },
                }),
              ),
              run.id,
              "thinking step",
            );
            break;
          case "approval_required":
            // Capture the command + set the block (whichever of poll/sub
            // is first wins via the awaitingApprovalAt guard).
            fireDb(
              db.agentRun.updateMany({
                where: { id: run.id, awaitingApprovalAt: null },
                data: {
                  awaitingApprovalAt: new Date(),
                  pendingApproval: {
                    command: typeof e.raw.command === "string" ? e.raw.command : null,
                    description: typeof e.raw.description === "string" ? e.raw.description : null,
                    choices: e.choices,
                  },
                },
              }),
              run.id,
              "approval capture",
            );
            break;
          case "approval_resolved":
            fireDb(
              db.agentRun.update({
                where: { id: run.id },
                data: { awaitingApprovalAt: null, pendingApproval: Prisma.DbNull },
              }),
              run.id,
              "approval clear",
            );
            break;
          // Terminal + content are owned by the poll loop / final summary.
          default:
            break;
        }
      },
      ctrl.signal,
    );
  } catch (err) {
    logger.warn({ err, runId: run.id }, "runs-dispatch: subscription error");
  } finally {
    subscriptions.delete(run.id);
  }
}

/** Ensure a live subscription exists for each active connector-driven run. */
async function ensureSubscriptions(): Promise<number> {
  const runs = await db.agentRun.findMany({
    where: { status: AgentRunStatus.ACTIVE, externalRunId: { not: null } },
    take: POLL_BATCH,
    select: {
      id: true,
      workspaceId: true,
      issueId: true,
      agentId: true,
      externalRunId: true,
      agent: {
        select: {
          provider: true,
          runtime: {
            select: {
              adapterKey: true,
              endpoint: true,
              secret: true,
              config: true,
              disabledAt: true,
              name: true,
            },
          },
        },
      },
    },
  });
  let n = 0;
  for (const run of runs) {
    if (subscriptions.has(run.id) || !run.externalRunId) continue;
    // Detached — runs for the lifetime of the run; self-removes on end.
    void subscribeRun({
      id: run.id,
      workspaceId: run.workspaceId,
      issueId: run.issueId,
      agentId: run.agentId,
      externalRunId: run.externalRunId,
      provider: run.agent.provider,
      runtime: run.agent.runtime,
    });
    n++;
  }
  return n;
}

/** One worker tick: start fresh runs, poll lifecycle, ensure live subs. */
export async function ingestRunsDispatch(): Promise<{
  started: number;
  resumed: number;
  polled: number;
  subscribed: number;
}> {
  const started = await startNewRuns();
  const resumed = await resumeWaitingRuns(START_BATCH);
  const subscribed = await ensureSubscriptions();
  const polled = await pollActiveRuns();
  if (started > 0 || resumed > 0 || polled > 0 || subscribed > 0) {
    logger.info({ started, resumed, polled, subscribed }, "runs-dispatch: tick");
  }
  return { started, resumed, polled, subscribed };
}
