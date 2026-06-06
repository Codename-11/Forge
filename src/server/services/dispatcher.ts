import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { AgentStatus, AutoDispatchMode, EventKind } from "@prisma/client";
import { recordChange } from "@/server/audit";
import { presenceAvailability } from "@/lib/transport-display";
import { maybeApplyAgentTemplate } from "@/server/services/agent-template";
import { setIssueAgentWakeTarget } from "@/server/services/issue-watchers";
import { resolveEngagementMode } from "@/server/services/engagement-mode";

/**
 * Stamp a "manual assignment" `dispatchReason` blob onto an Issue row.
 * Called by manual-assignment paths (issue.create / issue.update /
 * issue.bulkAssignAgent / MCP issues.assign / reassign) so the
 * attribution chip on the issue detail can render the same shape
 * for both auto-dispatch and human picks. `actorId` is the user who
 * performed the assignment; null = system / API key / agent.
 *
 * Returns the blob the caller can also embed on the AGENT_ASSIGNED
 * payload if it wants the event mirror.
 */
export async function recordManualDispatchReason(
  tx: PrismaClient | Prisma.TransactionClient,
  args: {
    issueId: string;
    agentProfileKey: string;
    actorId: string | null;
  },
): Promise<Prisma.InputJsonObject> {
  const reasonBlob: Prisma.InputJsonObject = {
    mode: "MANUAL",
    candidatesConsidered: [args.agentProfileKey],
    picked: args.agentProfileKey,
    reasonText: args.actorId ? "manual assignment" : "manual assignment (system)",
    decidedAt: new Date().toISOString(),
  };
  await tx.issue.update({
    where: { id: args.issueId },
    data: { dispatchReason: reasonBlob },
  });
  return reasonBlob;
}

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
          assignmentEngagementMode: true,
          mentionEngagementPolicy: true,
          mentionDefaultMode: true,
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

  // Load candidate agents in the workspace. We pull all non-archived agents
  // (not just non-OFFLINE) because OFFLINE is only meaningful for
  // heartbeat-tracked agents (Hermes). An on-demand agent (managed app server
  // / completions / dispatch) never heartbeats, so it's OFFLINE by default yet
  // fully reachable — excluding it here is the dispatch twin of the chat
  // "offline" bug. We filter by availability in JS instead. Pagination is
  // unnecessary: agent counts per workspace are O(10s).
  const agents = await tx.agent.findMany({
    where: {
      workspaceId: issue.workspaceId,
      archivedAt: null,
    },
    select: {
      id: true,
      profileKey: true,
      capabilities: true,
      engagementMode: true,
      maxConcurrent: true,
      lastDispatchedAt: true,
      // Availability inputs (cheap base columns) + disabled-runtime guard.
      status: true,
      provider: true,
      runtimeMode: true,
      lastHeartbeatAt: true,
      webhookUrl: true,
      runtimeId: true,
      runtime: { select: { disabledAt: true } },
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

  // Eligible = reachable + under cap + not behind a disabled runtime.
  // Reachable: a heartbeat-tracked agent must be non-OFFLINE; an on-demand /
  // session agent is reachable regardless of heartbeat status.
  const isEligible = (a: (typeof agents)[number]): boolean => {
    if (a.runtime?.disabledAt) return false;
    const availability = presenceAvailability(a);
    if (availability === "heartbeat" && a.status === AgentStatus.OFFLINE) return false;
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
      lastDispatchedAt: target.lastDispatchedAt ? target.lastDispatchedAt.toISOString() : null,
      eligible: true,
    };
    const engagementMode = resolveEngagementMode({
      surface: "queue",
      explicit: null,
      workspace: {
        assignmentEngagementMode: issue.workspace.assignmentEngagementMode,
        assignmentAgentEngagementMode: target.engagementMode,
        mentionEngagementPolicy: issue.workspace.mentionEngagementPolicy,
        mentionDefaultMode: issue.workspace.mentionDefaultMode,
      },
    }).mode;
    return await assignAndEmit(tx, issue.workspaceId, issue.id, target.id, {
      reason: `rule:${rule.id}`,
      mode: "RULE",
      engagementMode,
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
      reason: ruleFallthroughReason ? `${ruleFallthroughReason},no-candidates` : "no-candidates",
    };
  }

  // Round-robin tie-break: oldest `lastDispatchedAt` wins. Null sorts first
  // (agent has never been picked) so new agents get work before veterans.
  const byRoundRobin = (list: typeof eligible): (typeof eligible)[number] => {
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
    const matches = eligible.filter((a) => a.capabilities.some((c) => c.toLowerCase() === tag));
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
    const labelNames = new Set(issue.labels.map((l) => l.label.name.toLowerCase()));
    const scored = eligible.map((a) => {
      const caps = a.capabilities.map((c) => c.toLowerCase());
      const score = caps.reduce((acc, c) => acc + (labelNames.has(c) ? 1 : 0), 0);
      matchCountByAgent.set(a.id, score);
      return { agent: a, score };
    });
    const topScore = Math.max(...scored.map((s) => s.score));
    // When nobody matches any label, the top score is 0 — fall through to
    // plain round-robin across all eligible agents (don't stall dispatch).
    const top = scored.filter((s) => s.score === topScore).map((s) => s.agent);
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
      lastDispatchedAt: a.lastDispatchedAt ? a.lastDispatchedAt.toISOString() : null,
      ...(matchCount !== undefined ? { matchCount } : {}),
      eligible: eligibleFlag,
    };
  });
  const chosenMatchCount = matchCountByAgent.get(picked.id);
  const chosen = {
    agentId: picked.id,
    profileKey: picked.profileKey,
    ...(chosenMatchCount !== undefined ? { matchCount: chosenMatchCount } : {}),
  };

  const engagementMode = resolveEngagementMode({
    surface: "queue",
    explicit: null,
    workspace: {
      assignmentEngagementMode: issue.workspace.assignmentEngagementMode,
      assignmentAgentEngagementMode: picked.engagementMode,
      mentionEngagementPolicy: issue.workspace.mentionEngagementPolicy,
      mentionDefaultMode: issue.workspace.mentionDefaultMode,
    },
  }).mode;

  return await assignAndEmit(tx, issue.workspaceId, issue.id, picked.id, {
    reason: finalReason,
    mode,
    engagementMode,
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
 *
 * Also persists a compact `Issue.dispatchReason` blob so consumers can
 * answer "why was X picked" without joining back to the AGENT_ASSIGNED
 * event row. Same shape mirrored on the event payload so ActivityEvent
 * subscribers can read it inline.
 */
async function assignAndEmit(
  tx: PrismaClient | Prisma.TransactionClient,
  workspaceId: string,
  issueId: string,
  agentId: string,
  meta: {
    reason: string;
    mode: string;
    engagementMode: string;
    ruleId?: string;
    dispatch?: Prisma.InputJsonObject;
  },
): Promise<{ agentId: string; reason: string }> {
  await tx.agent.update({
    where: { id: agentId },
    data: { lastDispatchedAt: new Date() },
  });

  // Build the compact `dispatchReason` blob. Mirrors a subset of the
  // event payload's `dispatch` field (mode + candidates + picked +
  // reasonText) so a single column read answers "who was considered
  // and who won". The full per-candidate detail still lives on the
  // event payload for forensics.
  const dispatchPayload = meta.dispatch as
    | {
        mode: string;
        candidates?: Array<{ agentId: string; profileKey: string }>;
        chosen?: { agentId: string; profileKey: string } | null;
        reason?: string;
      }
    | undefined;
  const candidatesConsidered = dispatchPayload?.candidates?.map((c) => c.profileKey) ?? [];
  const pickedProfile = dispatchPayload?.chosen?.profileKey ?? null;
  const reasonBlob: Prisma.InputJsonObject = {
    mode: meta.mode,
    candidatesConsidered,
    picked: pickedProfile ?? agentId,
    reasonText: dispatchPayload?.reason ?? meta.reason,
    decidedAt: new Date().toISOString(),
    ...(meta.ruleId ? { ruleId: meta.ruleId } : {}),
  };

  await tx.issue.update({
    where: { id: issueId },
    data: {
      assignedAgentId: agentId,
      dispatchReason: reasonBlob,
    },
  });

  // Keep watcher rows sticky but make only the current dispatched agent
  // eligible for generic activity wake fan-out. Prior picks remain
  // visible as watchers, not future ghost work.
  await setIssueAgentWakeTarget(tx, { workspaceId, issueId, agentId });

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
      engagementMode: meta.engagementMode,
      reason: meta.reason,
      ...(meta.ruleId ? { ruleId: meta.ruleId } : {}),
      ...(meta.dispatch ? { dispatch: meta.dispatch } : {}),
      // Mirror the row-level blob so consumers reading the event don't
      // have to re-query the issue.
      dispatchReason: reasonBlob,
    },
  });

  await maybeApplyAgentTemplate(tx, issueId, agentId);

  return { agentId, reason: meta.reason };
}
