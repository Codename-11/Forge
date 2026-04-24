import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { AgentStatus, AutoDispatchMode, EventKind } from "@prisma/client";
import { recordChange } from "@/server/audit";
import { maybeApplyAgentTemplate } from "@/server/services/agent-template";

/**
 * Auto-dispatcher for queued issues.
 *
 * Picks an eligible agent for an issue based on the workspace's
 * `autoDispatchMode`, writes the assignment, bumps the agent's
 * `lastDispatchedAt`, and emits an `AGENT_ASSIGNED` event. All work runs
 * against the Prisma client passed in — callers embed the call inside an
 * existing transaction (matching `recordChange`'s contract).
 *
 * Selection precedence:
 *   1. DispatchRule rows (ordered by `order ASC, createdAt ASC`). First
 *      rule whose conditions match wins. If the rule's target isn't
 *      eligible, fall through to mode-based selection rather than stall.
 *   2. `autoDispatchMode` — ROUND_ROBIN / PRIORITY_MATCH / CAPABILITY_MATCH.
 *
 * When `autoStartOnAssign && !requireApprovalBeforeStart`, no extra work is
 * needed on the Forge side — the webhook fan-out in `audit.ts` already
 * delivers `AGENT_ASSIGNED` to the agent's webhookUrl via the synthetic
 * agent-dispatch webhook row. See `AGENT_DISPATCH_WEBHOOK_URL` there.
 *
 * Idempotent: short-circuits on already-assigned / un-queued issues so a
 * double call from `create` + `setQueued` is a no-op.
 */
export async function maybeAutoDispatch(
  tx: PrismaClient | Prisma.TransactionClient,
  issueId: string,
): Promise<{ agentId: string | null; reason: string }> {
  const issue = await tx.issue.findUnique({
    where: { id: issueId },
    select: {
      id: true,
      workspaceId: true,
      queued: true,
      priority: true,
      projectId: true,
      assignedAgentId: true,
      labels: {
        select: {
          labelId: true,
          label: { select: { name: true } },
        },
      },
      workspace: {
        select: {
          autoDispatch: true,
          autoDispatchMode: true,
          autoStartOnAssign: true,
          requireApprovalBeforeStart: true,
        },
      },
    },
  });

  if (!issue) return { agentId: null, reason: "issue-not-found" };
  if (issue.assignedAgentId) {
    return { agentId: null, reason: "already-assigned" };
  }
  if (!issue.queued) return { agentId: null, reason: "not-queued" };
  if (!issue.workspace.autoDispatch) {
    return { agentId: null, reason: "auto-dispatch-off" };
  }
  if (issue.workspace.autoDispatchMode === AutoDispatchMode.MANUAL_ONLY) {
    return { agentId: null, reason: "manual-only" };
  }

  // Load candidate agents in the workspace. We pull all non-archived,
  // non-OFFLINE agents in one go; pagination is unnecessary because agent
  // counts per workspace are small (O(10s) realistically).
  const agents = await tx.agent.findMany({
    where: {
      workspaceId: issue.workspaceId,
      archivedAt: null,
      status: { not: AgentStatus.OFFLINE },
    },
    select: {
      id: true,
      profileKey: true,
      capabilities: true,
      maxConcurrent: true,
      lastDispatchedAt: true,
      _count: {
        select: {
          // Active = anything not terminal. We filter by status category on
          // the assignedIssues side so agents at their cap are skipped.
          assignedIssues: {
            where: {
              deletedAt: null,
              status: { category: { notIn: ["DONE", "CANCELED"] } },
            },
          },
        },
      },
    },
  });

  // Respect maxConcurrent: 0 means unlimited; otherwise active < cap.
  // Track eligibility per-agent so we can surface filtered-out agents in
  // the dispatch provenance payload (not just the winners).
  const isEligible = (a: (typeof agents)[number]): boolean => {
    if (a.maxConcurrent === 0) return true;
    return a._count.assignedIssues < a.maxConcurrent;
  };
  const eligible = agents.filter(isEligible);

  // --- Rules layer ------------------------------------------------------
  // Rules run before mode-based selection. A rule's conditions are ANDed;
  // null columns are wildcards. First match (by order asc, createdAt asc)
  // wins, but only if its target is currently eligible — otherwise we fall
  // through to the mode-based picker rather than stalling dispatch.
  const rules = await tx.dispatchRule.findMany({
    where: { workspaceId: issue.workspaceId, enabled: true },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      priority: true,
      labelId: true,
      projectId: true,
      targetAgentId: true,
    },
  });

  const issueLabelIds = new Set(issue.labels.map((l) => l.labelId));
  const eligibleById = new Map(eligible.map((a) => [a.id, a]));

  // Records the miss-reason when the first matching rule has an
  // ineligible target. Surfaced as a prefix on the mode-based reason so
  // callers can see "we *would* have picked via rule X, but fell through
  // to round-robin because X's target was OFFLINE".
  let ruleFallthroughReason: string | null = null;

  for (const rule of rules) {
    if (rule.priority !== null && rule.priority !== issue.priority) continue;
    if (rule.labelId !== null && !issueLabelIds.has(rule.labelId)) continue;
    if (rule.projectId !== null && rule.projectId !== issue.projectId) {
      continue;
    }

    const target = eligibleById.get(rule.targetAgentId);
    if (!target) {
      ruleFallthroughReason = `rule:${rule.id}:target-ineligible`;
      break;
    }

    const ruleCandidate = {
      agentId: target.id,
      profileKey: target.profileKey,
      capabilities: target.capabilities,
      activeCount: target._count.assignedIssues,
      maxConcurrent: target.maxConcurrent,
      lastDispatchedAt: target.lastDispatchedAt
        ? target.lastDispatchedAt.toISOString()
        : null,
      eligible: true,
    };
    return await assignAndEmit(tx, issue.workspaceId, issue.id, target.id, {
      reason: `rule:${rule.id}`,
      mode: "RULE",
      ruleId: rule.id,
      dispatch: {
        mode: "RULE",
        candidates: [ruleCandidate],
        chosen: { agentId: target.id, profileKey: target.profileKey },
        reason: `rule:${rule.id}`,
      },
    });
  }

  if (eligible.length === 0) {
    return {
      agentId: null,
      reason: ruleFallthroughReason
        ? `${ruleFallthroughReason},no-candidates`
        : "no-candidates",
    };
  }

  // Round-robin tie-break: oldest `lastDispatchedAt` wins. Null sorts first
  // (agent has never been picked) so new agents get work before veterans.
  const byRoundRobin = (
    list: typeof eligible,
  ): (typeof eligible)[number] => {
    const sorted = [...list].sort((a, b) => {
      const at = a.lastDispatchedAt ? a.lastDispatchedAt.getTime() : -1;
      const bt = b.lastDispatchedAt ? b.lastDispatchedAt.getTime() : -1;
      return at - bt;
    });
    return sorted[0];
  };

  const mode = issue.workspace.autoDispatchMode;
  let picked: (typeof eligible)[number];
  // `matchCount` is only meaningful under CAPABILITY_MATCH — for the
  // other modes we leave it per-agent `undefined` so the payload shape
  // stays consistent without lying about a score we didn't compute.
  const matchCountByAgent = new Map<string, number>();
  // Reason string surfaced on the event. Shape: `<mode-slug>[:detail]`.
  let reasonTag: string;

  if (mode === AutoDispatchMode.ROUND_ROBIN) {
    picked = byRoundRobin(eligible);
    reasonTag = "round-robin";
  } else if (mode === AutoDispatchMode.PRIORITY_MATCH) {
    const tag = issue.priority.toLowerCase();
    const matches = eligible.filter((a) =>
      a.capabilities.some((c) => c.toLowerCase() === tag),
    );
    if (matches.length) {
      picked = byRoundRobin(matches);
      reasonTag = `priority-match-${tag}+cap`;
    } else {
      picked = byRoundRobin(eligible);
      reasonTag = `priority-match-${tag}+fallback`;
    }
  } else {
    // CAPABILITY_MATCH — score by label-capability intersection, highest
    // wins; tie-break via round-robin.
    const labelNames = new Set(
      issue.labels.map((l) => l.label.name.toLowerCase()),
    );
    const scored = eligible.map((a) => {
      const caps = a.capabilities.map((c) => c.toLowerCase());
      const score = caps.reduce(
        (acc, c) => acc + (labelNames.has(c) ? 1 : 0),
        0,
      );
      matchCountByAgent.set(a.id, score);
      return { agent: a, score };
    });
    const topScore = Math.max(...scored.map((s) => s.score));
    // When nobody matches any label, the top score is 0 — fall through to
    // plain round-robin across all eligible agents (don't stall dispatch).
    const top = scored
      .filter((s) => s.score === topScore)
      .map((s) => s.agent);
    picked = byRoundRobin(top);
    reasonTag = `capability-match:${topScore}`;
  }

  const modeLabel = mode.toLowerCase().replace(/_/g, "-");
  const finalReason = ruleFallthroughReason
    ? `${ruleFallthroughReason},${modeLabel} pick`
    : `${modeLabel} pick`;

  const candidates = agents.map((a) => {
    const eligibleFlag = isEligible(a);
    const matchCount = matchCountByAgent.get(a.id);
    return {
      agentId: a.id,
      profileKey: a.profileKey,
      capabilities: a.capabilities,
      activeCount: a._count.assignedIssues,
      maxConcurrent: a.maxConcurrent,
      lastDispatchedAt: a.lastDispatchedAt
        ? a.lastDispatchedAt.toISOString()
        : null,
      ...(matchCount !== undefined ? { matchCount } : {}),
      eligible: eligibleFlag,
    };
  });
  const chosenMatchCount = matchCountByAgent.get(picked.id);
  const chosen = {
    agentId: picked.id,
    profileKey: picked.profileKey,
    ...(chosenMatchCount !== undefined
      ? { matchCount: chosenMatchCount }
      : {}),
  };

  return await assignAndEmit(tx, issue.workspaceId, issue.id, picked.id, {
    reason: finalReason,
    mode,
    dispatch: {
      mode,
      candidates,
      chosen,
      reason: reasonTag,
    },
  });
}

/**
 * Persist the assignment, bump agent round-robin bookkeeping, emit the
 * `AGENT_ASSIGNED` event, and return the caller-shaped result.
 *
 * `dispatch.mode` goes into the event payload alongside the rule id when
 * a rule fired — kept as a string literal so we don't have to extend the
 * `AutoDispatchMode` enum just to mark rule-driven dispatches.
 */
async function assignAndEmit(
  tx: PrismaClient | Prisma.TransactionClient,
  workspaceId: string,
  issueId: string,
  agentId: string,
  meta: {
    reason: string;
    mode: string;
    ruleId?: string;
    dispatch?: Prisma.InputJsonObject;
  },
): Promise<{ agentId: string; reason: string }> {
  await tx.agent.update({
    where: { id: agentId },
    data: { lastDispatchedAt: new Date() },
  });
  await tx.issue.update({
    where: { id: issueId },
    data: { assignedAgentId: agentId },
  });

  await recordChange(tx, {
    workspaceId,
    actorId: null,
    entity: "Issue",
    entityId: issueId,
    action: "auto-dispatch",
    after: { assignedAgentId: agentId },
    eventKind: EventKind.AGENT_ASSIGNED,
    subjectType: "issue",
    subjectId: issueId,
    payload: {
      agentId,
      previousAgentId: null,
      auto: true,
      mode: meta.mode,
      reason: meta.reason,
      ...(meta.ruleId ? { ruleId: meta.ruleId } : {}),
      ...(meta.dispatch ? { dispatch: meta.dispatch } : {}),
    },
  });

  await maybeApplyAgentTemplate(tx, issueId, agentId);

  return { agentId, reason: meta.reason };
}
