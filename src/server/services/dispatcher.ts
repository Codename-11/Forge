import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { AgentStatus, AutoDispatchMode, EventKind } from "@prisma/client";
import { recordChange } from "@/server/audit";

/**
 * Auto-dispatcher for queued issues.
 *
 * Picks an eligible agent for an issue based on the workspace's
 * `autoDispatchMode`, writes the assignment, bumps the agent's
 * `lastDispatchedAt`, and emits an `AGENT_ASSIGNED` event. All work runs
 * against the Prisma client passed in — callers embed the call inside an
 * existing transaction (matching `recordChange`'s contract).
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
      assignedAgentId: true,
      labels: { select: { label: { select: { name: true } } } },
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
  const eligible = agents.filter((a) => {
    if (a.maxConcurrent === 0) return true;
    return a._count.assignedIssues < a.maxConcurrent;
  });
  if (eligible.length === 0) {
    return { agentId: null, reason: "no-candidates" };
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

  if (mode === AutoDispatchMode.ROUND_ROBIN) {
    picked = byRoundRobin(eligible);
  } else if (mode === AutoDispatchMode.PRIORITY_MATCH) {
    const tag = issue.priority.toLowerCase();
    const matches = eligible.filter((a) =>
      a.capabilities.some((c) => c.toLowerCase() === tag),
    );
    picked = matches.length ? byRoundRobin(matches) : byRoundRobin(eligible);
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
      return { agent: a, score };
    });
    const topScore = Math.max(...scored.map((s) => s.score));
    // When nobody matches any label, the top score is 0 — fall through to
    // plain round-robin across all eligible agents (don't stall dispatch).
    const top = scored
      .filter((s) => s.score === topScore)
      .map((s) => s.agent);
    picked = byRoundRobin(top);
  }

  const now = new Date();

  await tx.agent.update({
    where: { id: picked.id },
    data: { lastDispatchedAt: now },
  });
  await tx.issue.update({
    where: { id: issue.id },
    data: { assignedAgentId: picked.id },
  });

  await recordChange(tx, {
    workspaceId: issue.workspaceId,
    actorId: null,
    entity: "Issue",
    entityId: issue.id,
    action: "auto-dispatch",
    after: { assignedAgentId: picked.id },
    eventKind: EventKind.AGENT_ASSIGNED,
    subjectType: "issue",
    subjectId: issue.id,
    payload: {
      agentId: picked.id,
      previousAgentId: null,
      auto: true,
      mode,
    },
  });

  const modeLabel = mode.toLowerCase().replace(/_/g, "-");
  return { agentId: picked.id, reason: `${modeLabel} pick` };
}
