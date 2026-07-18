import { z } from "zod";
import {
  ActionRequestKind,
  ActionRequestStatus,
  AgentRunStatus,
  GoalStatus,
  ReviewGateStatus,
  type PrismaClient,
} from "@prisma/client";
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

type AttentionAction = {
  id: string;
  label: string;
  description: string;
  tone: "PRIMARY" | "NEUTRAL" | "DANGER";
  requiresConfirmation: boolean;
  enabled: boolean;
  disabledReason: string | null;
};

async function actionRequestPresentation(
  db: PrismaClient,
  workspaceId: string,
  viewer: { userId: string | null; role: string },
  request: {
    id: string;
    kind: ActionRequestKind;
    title: string;
    body: string | null;
    payload: unknown;
    issueId: string | null;
    sourceType: string | null;
    sourceId: string | null;
    requestedByAgent: {
      id: string;
      name: string;
      profileKey: string;
      avatar: string | null;
    } | null;
  },
) {
  const openIssue: AttentionAction | null = request.issueId
    ? {
        id: "OPEN_ISSUE",
        label: "Open issue",
        description: "Review the issue and its current delivery state.",
        tone: "NEUTRAL",
        requiresConfirmation: false,
        enabled: true,
        disabledReason: null,
      }
    : null;
  const base = {
    summary: request.body ?? request.title,
    details: [] as Array<{ label: string; value: string }>,
    technicalDetails: [
      { label: "Action request", value: request.id },
      ...(request.sourceType ? [{ label: "Source type", value: request.sourceType }] : []),
      ...(request.sourceId ? [{ label: "Source", value: request.sourceId }] : []),
      ...(request.issueId ? [{ label: "Issue", value: request.issueId }] : []),
    ],
  };
  const dismiss: AttentionAction = {
    id: "DISMISS",
    label: "Dismiss",
    description: "Remove this stale request from the attention queue.",
    tone: "NEUTRAL",
    requiresConfirmation: false,
    enabled: true,
    disabledReason: null,
  };

  if (request.kind === ActionRequestKind.DELIVERY_CONNECTION_CONFLICT) {
    const raw =
      request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
        ? (request.payload as Record<string, unknown>)
        : {};
    const workSessionId = typeof raw.workSessionId === "string" ? raw.workSessionId : null;
    const expectedOwnerConnectionId =
      typeof raw.expectedOwnerConnectionId === "string" ? raw.expectedOwnerConnectionId : null;
    const candidateConnectionId =
      typeof raw.candidateConnectionId === "string" ? raw.candidateConnectionId : null;
    const queuedRunId = typeof raw.queuedRunId === "string" ? raw.queuedRunId : null;
    const validPayload =
      raw.version === 1 &&
      (raw.attemptedMode === "EXECUTE" || raw.attemptedMode === "REVIEW") &&
      workSessionId !== null &&
      expectedOwnerConnectionId !== null &&
      candidateConnectionId !== null &&
      queuedRunId !== null;
    const [session, run, candidate] = validPayload
      ? await Promise.all([
          db.workSession.findFirst({
            where: { id: workSessionId!, workspaceId },
            select: { endedAt: true, ownerConnectionId: true, ownerUserId: true },
          }),
          db.agentRun.findFirst({
            where: { id: queuedRunId!, workspaceId },
            select: {
              status: true,
              externalRunId: true,
              connectionId: true,
              engagementMode: true,
            },
          }),
          db.agentConnection.findFirst({
            where: {
              id: candidateConnectionId!,
              workspaceId,
              kind: "MANAGED_RUNTIME",
              revokedAt: null,
            },
            select: { displayName: true },
          }),
        ])
      : [null, null, null];
    const staleReason = !validPayload
      ? "This request has an unsupported or incomplete delivery payload."
      : !session || session.endedAt
        ? "The delivery session has ended."
        : session.ownerConnectionId !== expectedOwnerConnectionId
          ? "Primary delivery ownership changed after this request was created."
          : !candidate
            ? "The requesting runtime connection is no longer available."
            : !run ||
                run.externalRunId ||
                run.connectionId !== candidateConnectionId ||
                run.engagementMode !== raw.attemptedMode
              ? "The queued runtime attempt is no longer safely actionable."
              : run.status !== AgentRunStatus.WAITING && run.status !== AgentRunStatus.ACTIVE
                ? "The queued runtime attempt is already terminal."
                : null;
    const isAdmin = viewer.role === "OWNER" || viewer.role === "ADMIN";
    const canManage = isAdmin || (viewer.userId !== null && session?.ownerUserId === viewer.userId);
    const managerReason = canManage
      ? null
      : "Only the work-session owner or a workspace admin can choose this action.";
    const adminReason = isAdmin
      ? null
      : "Workspace admin authority is required to hand off primary ownership.";
    const attemptedMode = raw.attemptedMode === "REVIEW" ? "REVIEW" : "EXECUTE";
    const executeActions: AttentionAction[] = [
      {
        id: "JOIN_CONTRIBUTOR",
        label: "Continue as contributor",
        description:
          "Keep the current primary and let this runtime execute on the shared delivery session.",
        tone: "PRIMARY",
        requiresConfirmation: false,
        enabled: staleReason === null && canManage,
        disabledReason: staleReason ?? managerReason,
      },
      {
        id: "JOIN_REVIEWER",
        label: "Join as reviewer",
        description:
          "Keep the current primary and convert this queued attempt to read-only review mode.",
        tone: "NEUTRAL",
        requiresConfirmation: false,
        enabled: staleReason === null && canManage,
        disabledReason: staleReason ?? managerReason,
      },
      {
        id: "HANDOFF_PRIMARY",
        label: "Hand off primary",
        description:
          "Transfer delivery ownership to this runtime and continue the queued execution.",
        tone: "DANGER",
        requiresConfirmation: true,
        enabled: staleReason === null && isAdmin,
        disabledReason: staleReason ?? adminReason,
      },
      {
        id: "CANCEL_DISPATCH",
        label: "Cancel new dispatch",
        description:
          "Abandon only this queued runtime attempt; the current primary connection is untouched.",
        tone: "DANGER",
        requiresConfirmation: true,
        enabled: staleReason === null && canManage,
        disabledReason: staleReason ?? managerReason,
      },
    ];
    const reviewActions = executeActions.filter(
      (action) => action.id === "JOIN_REVIEWER" || action.id === "CANCEL_DISPATCH",
    );
    const conflictActions = attemptedMode === "REVIEW" ? reviewActions : executeActions;
    const visibleActions = staleReason
      ? [dismiss, ...(openIssue ? [openIssue] : [])]
      : [...conflictActions, dismiss, ...(openIssue ? [openIssue] : [])];
    return {
      ...base,
      category: "OWNERSHIP_CONFLICT",
      protocol: "DELIVERY_CONNECTION_CONFLICT",
      replyTarget: null,
      actions: visibleActions,
      details: [
        ...base.details,
        { label: "Requested mode", value: attemptedMode },
        { label: "Current state", value: staleReason ?? "Waiting for an ownership decision." },
        ...(candidate?.displayName
          ? [{ label: "Attempted connection", value: candidate.displayName }]
          : []),
      ],
      technicalDetails: [
        ...base.technicalDetails,
        ...(workSessionId ? [{ label: "Work session", value: workSessionId }] : []),
        ...(expectedOwnerConnectionId
          ? [{ label: "Expected primary connection", value: expectedOwnerConnectionId }]
          : []),
        ...(candidateConnectionId
          ? [{ label: "Candidate connection", value: candidateConnectionId }]
          : []),
        ...(queuedRunId ? [{ label: "Queued run", value: queuedRunId }] : []),
        { label: "Attempted mode", value: attemptedMode },
        ...(typeof raw.triggerEventId === "string"
          ? [{ label: "Trigger event", value: raw.triggerEventId }]
          : []),
      ],
    };
  }

  if (request.kind === ActionRequestKind.FREE_FORM) {
    const replyTarget =
      request.requestedByAgent && request.issueId
        ? {
            type: "ISSUE_AGENT_REPLY" as const,
            issueId: request.issueId,
            agentId: request.requestedByAgent.id,
            profileKey: request.requestedByAgent.profileKey,
          }
        : null;
    const actions: AttentionAction[] = replyTarget
      ? [
          {
            id: "RESPOND",
            label: "Respond",
            description: `Reply to @${replyTarget.profileKey} on the linked issue.`,
            tone: "PRIMARY",
            requiresConfirmation: false,
            enabled: true,
            disabledReason: null,
          },
          ...(openIssue ? [openIssue] : []),
        ]
      : openIssue
        ? [openIssue]
        : [];
    return {
      ...base,
      category: "INFORMATION_REQUIRED",
      protocol: replyTarget ? "TEXT_REPLY" : "GENERIC_FALLBACK",
      replyTarget: replyTarget?.profileKey ?? null,
      actions,
    };
  }

  const decisionActions: AttentionAction[] = [
    {
      id: "ACCEPT",
      label: "Accept",
      description: "Apply the typed action attached to this request.",
      tone: "PRIMARY",
      requiresConfirmation: false,
      enabled: true,
      disabledReason: null,
    },
    {
      id: "DECLINE",
      label: "Decline",
      description: "Reject this request without applying its action.",
      tone: "NEUTRAL",
      requiresConfirmation: false,
      enabled: true,
      disabledReason: null,
    },
    ...(openIssue ? [openIssue] : []),
  ];
  return {
    ...base,
    category: "DECISION_REQUIRED",
    protocol: "SINGLE_DECISION",
    replyTarget: null,
    actions: decisionActions,
  };
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
        actionRequestCount,
        reviewGates,
        reviewGateCount,
        activeRuns,
        activeRunCount,
        runtimeApprovalCount,
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
        userId
          ? ctx.db.actionRequest.count({ where: decisionAskWhere(ctx.workspaceId, userId) })
          : Promise.resolve(0),
        listReviewGatesWithContext(ctx.db, {
          workspaceId: ctx.workspaceId,
          status: ReviewGateStatus.PENDING,
          limit: input.limit,
        }),
        ctx.db.reviewGate.count({
          where: { workspaceId: ctx.workspaceId, status: ReviewGateStatus.PENDING },
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
        ctx.db.agentRun.count({
          where: {
            workspaceId: ctx.workspaceId,
            status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
            awaitingApprovalAt: null,
          },
        }),
        ctx.db.agentRun.count({
          where: {
            workspaceId: ctx.workspaceId,
            status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
            awaitingApprovalAt: { not: null },
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
      const presentedActionRequests = await Promise.all(
        groupedActionRequests.map(async (request) => ({
          ...request,
          presentation: await actionRequestPresentation(
            ctx.db,
            ctx.workspaceId,
            { userId, role: ctx.membership.role },
            request,
          ),
        })),
      );

      return {
        actionRequests: presentedActionRequests,
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
          actionRequests: actionRequestCount,
          reviewGates: reviewGateCount,
          activeRuns: activeRunCount,
          runtimeApprovals: runtimeApprovalCount,
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
