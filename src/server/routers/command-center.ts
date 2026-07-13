import { z } from "zod";
import { ActionRequestStatus, AgentRunStatus, GoalStatus, ReviewGateStatus } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { listRunRecoveryItems } from "@/server/services/agent-run-recovery";
import { listReviewGatesWithContext } from "@/server/services/review-gate-context";

/** Goal statuses that mean a goal is live and worth surfacing. */
const LIVE_GOAL_STATUSES = [GoalStatus.PLANNING, GoalStatus.ACTIVE];

/**
 * OPEN action requests the operator should see: ones explicitly
 * assigned to them, PLUS unassigned ones (plan-approval asks are
 * created with a null assignee, so an `assignedUserId: userId` filter
 * alone would hide the loop's most important decision).
 */
function decisionAskWhere(workspaceId: string, userId: string) {
  return {
    workspaceId,
    status: ActionRequestStatus.OPEN,
    OR: [{ assignedUserId: userId }, { assignedUserId: null }],
  };
}

/**
 * Collapse rows to one per issue (keeping the first — i.e. the highest-priority
 * by the caller's orderBy), tagging each survivor with `issueOpenCount` so the
 * UI can show "+N more on this issue" instead of stacking near-duplicate cards.
 * Null-issue (workspace-level) rows pass through individually. Applied to action
 * requests only — runs are intentionally NOT grouped (distinct agents' concurrent
 * runs on one issue are real, and same-agent stalled repeats already collapse via
 * AgentRun.supersededByRunId).
 */
function collapsePerIssue<T extends { issueId: string | null }>(
  rows: T[],
): (T & { issueOpenCount: number })[] {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.issueId) counts.set(r.issueId, (counts.get(r.issueId) ?? 0) + 1);
  const seen = new Set<string>();
  const out: (T & { issueOpenCount: number })[] = [];
  for (const r of rows) {
    if (r.issueId) {
      if (seen.has(r.issueId)) continue;
      seen.add(r.issueId);
    }
    out.push({ ...r, issueOpenCount: r.issueId ? (counts.get(r.issueId) ?? 1) : 1 });
  }
  return out;
}

/**
 * Command Center router — daily-operator aggregator. Single query that
 * stitches together the surfaces an operator wants before starting
 * their day:
 *
 *   - open ActionRequests assigned to me
 *   - pending ReviewGates targeting me (or unassigned)
 *   - active agent runs in this workspace (capped for sanity)
 *   - uncleared terminal run failures (status = STALLED / ABANDONED)
 *   - recently updated artifacts (top 10 most recent non-archived)
 *   - issues due soon (within 7 days, not DONE/CANCELED)
 *
 * Writes still land on the canonical detail pages — Command Center
 * is read-only. Mobile-first layout responsibility is on the page.
 */
export const commandCenterRouter = router({
  summary: workspaceProcedure
    .input(
      z
        .object({
          dueWindowDays: z.number().int().min(0).max(60).default(7),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .default({ dueWindowDays: 7, limit: 20 }),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session?.user?.id ?? null;
      const dueCutoff = new Date(Date.now() + input.dueWindowDays * 24 * 60 * 60 * 1000);

      const [
        actionRequests,
        reviewGates,
        activeRuns,
        runRecovery,
        recentArtifacts,
        dueIssues,
        runningTimer,
      ] = await Promise.all([
        userId
          ? ctx.db.actionRequest.findMany({
              where: decisionAskWhere(ctx.workspaceId, userId),
              orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
              // Over-fetch so the per-issue collapse + issueOpenCount below run
              // over the full open set, not a pre-truncated page; sliced to
              // input.limit after collapsing.
              take: 200,
              include: {
                requestedByAgent: {
                  select: { id: true, name: true, profileKey: true, avatar: true },
                },
                requestedByUser: { select: { id: true, name: true, image: true } },
                issue: {
                  select: {
                    id: true,
                    number: true,
                    title: true,
                    workspace: { select: { slug: true, key: true } },
                  },
                },
              },
            })
          : Promise.resolve([]),
        listReviewGatesWithContext(ctx.db, {
          workspaceId: ctx.workspaceId,
          status: ReviewGateStatus.PENDING,
          limit: input.limit,
        }),
        ctx.db.agentRun.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
          },
          orderBy: [
            { awaitingApprovalAt: { sort: "desc", nulls: "last" } },
            { lastEventAt: "desc" },
          ],
          take: input.limit,
          include: {
            agent: { select: { id: true, name: true, profileKey: true, avatar: true } },
            issue: {
              select: {
                id: true,
                number: true,
                title: true,
                workspace: { select: { slug: true, key: true } },
              },
            },
          },
        }),
        listRunRecoveryItems(ctx.db, {
          workspaceId: ctx.workspaceId,
          limit: input.limit,
        }),
        ctx.db.artifact.findMany({
          where: { workspaceId: ctx.workspaceId, archivedAt: null },
          orderBy: { updatedAt: "desc" },
          take: 10,
          select: {
            id: true,
            slug: true,
            title: true,
            type: true,
            status: true,
            updatedAt: true,
          },
        }),
        ctx.db.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            deletedAt: null,
            dueDate: { not: null, lte: dueCutoff },
            status: { category: { notIn: ["DONE", "CANCELED"] } },
          },
          orderBy: { dueDate: "asc" },
          take: input.limit,
          select: {
            id: true,
            number: true,
            title: true,
            dueDate: true,
            priority: true,
            status: { select: { name: true, category: true, color: true } },
            workspace: { select: { slug: true, key: true } },
          },
        }),
        userId
          ? ctx.db.timeEntry.findFirst({
              where: {
                workspaceId: ctx.workspaceId,
                userId,
                endedAt: null,
              },
              orderBy: { startedAt: "desc" },
              include: {
                issue: {
                  select: {
                    id: true,
                    number: true,
                    title: true,
                    workspace: { select: { slug: true, key: true } },
                  },
                },
              },
            })
          : Promise.resolve(null),
      ]);

      // Live goals — what the crews are actively driving right now.
      // Steps live under `Goal.plans[].steps` (no direct relation), so we
      // pull a thin status-only projection of every step, count DONE vs
      // total per goal, then DROP the heavy `plans` array from the
      // returned shape. Goals are capped (limit ~20) so the nested
      // fan-out is bounded.
      const liveGoalRows = await ctx.db.goal.findMany({
        where: { workspaceId: ctx.workspaceId, status: { in: LIVE_GOAL_STATUSES } },
        orderBy: { updatedAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          title: true,
          status: true,
          totalCostUsd: true,
          maxTotalCostUsd: true,
          crew: { select: { id: true, name: true } },
          _count: { select: { plans: true } },
          plans: { select: { steps: { select: { status: true } } } },
        },
      });
      const liveGoals = liveGoalRows.map(({ plans, ...rest }) => {
        const steps = plans.flatMap((p) => p.steps);
        const totalSteps = steps.length;
        const doneSteps = steps.filter((s) => s.status === "DONE").length;
        return { ...rest, doneSteps, totalSteps };
      });

      const stalledRuns = runRecovery.items.map((item) => ({
        ...item.run,
        recoveryReason: item.reason,
        recoveryTitle: item.title,
        recoveryDetail: item.detail,
        recommendedAction: item.recommendedAction,
        availableActions: item.availableActions,
        diagnostics: item.diagnostics,
      }));

      // Runtime permission pauses are durable human decisions, not merely
      // live-run metadata. Keep them out of the generic active-run module and
      // return them as a first-class Command Center attention group so the
      // command/reason and approval choices can be rendered inline.
      const runtimeApprovals = activeRuns.filter((run) => run.awaitingApprovalAt != null);
      const visibleActiveRuns = activeRuns.filter((run) => run.awaitingApprovalAt == null);

      // Collapse near-duplicate action-request cards to one per issue, then
      // slice to the requested limit (collapse runs over the full open set).
      const groupedActionRequests = collapsePerIssue(actionRequests).slice(0, input.limit);

      return {
        actionRequests: groupedActionRequests,
        reviewGates,
        activeRuns: visibleActiveRuns,
        runtimeApprovals,
        stalledRuns,
        runRecoveryCounts: runRecovery.counts,
        recentArtifacts,
        dueIssues,
        runningTimer,
        liveGoals,
        counts: {
          actionRequests: groupedActionRequests.length,
          reviewGates: reviewGates.length,
          activeRuns: visibleActiveRuns.length,
          runtimeApprovals: runtimeApprovals.length,
          stalledRuns: runRecovery.counts.total,
          recentArtifacts: recentArtifacts.length,
          dueIssues: dueIssues.length,
          liveGoals: liveGoals.length,
        },
      };
    }),

  /**
   * Lightweight count of decisions waiting on the operator — open
   * action requests (assigned to me or unassigned) plus pending review
   * gates. Drives the sidebar "Decisions" badge and the dashboard
   * "Needs you" tile without pulling the full summary payload.
   */
  decisionsCount: workspaceProcedure.query(async ({ ctx }) => {
    const userId = ctx.session?.user?.id ?? null;
    const [actionRequests, reviewGates, runtimeApprovals] = await Promise.all([
      userId
        ? ctx.db.actionRequest.count({ where: decisionAskWhere(ctx.workspaceId, userId) })
        : Promise.resolve(0),
      ctx.db.reviewGate.count({
        where: { workspaceId: ctx.workspaceId, status: ReviewGateStatus.PENDING },
      }),
      ctx.db.agentRun.count({
        where: {
          workspaceId: ctx.workspaceId,
          status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
          awaitingApprovalAt: { not: null },
        },
      }),
    ]);
    return {
      actionRequests,
      reviewGates,
      runtimeApprovals,
      total: actionRequests + reviewGates + runtimeApprovals,
    };
  }),
});
