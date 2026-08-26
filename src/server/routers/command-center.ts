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
import { issueWhereForViewer } from "@/server/services/project-access";

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

type AttentionAction = {
  id: string;
  label: string;
  description: string;
  tone: "PRIMARY" | "NEUTRAL" | "DANGER";
  requiresConfirmation: boolean;
  enabled: boolean;
  disabledReason: string | null;
};

export async function actionRequestPresentation(
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
    dedupeKey: string | null;
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
    label: "Dismiss card",
    description:
      "Remove this card without resolving the underlying issue or Delivery state. It may return if the condition persists.",
    tone: "NEUTRAL",
    requiresConfirmation: false,
    enabled: true,
    disabledReason: null,
  };

  const isMcpQuiet =
    request.sourceType === "work-session" &&
    request.dedupeKey?.startsWith("work-session-mcp-quiet:") === true;
  const isStaleSession =
    request.sourceType === "work-session" &&
    request.dedupeKey?.startsWith("work-session-stale:") === true;
  if (request.kind === ActionRequestKind.FREE_FORM && (isMcpQuiet || isStaleSession)) {
    const session = request.sourceId
      ? await db.workSession.findFirst({
          where: { id: request.sourceId, workspaceId },
          select: {
            id: true,
            status: true,
            endedAt: true,
            repoFullName: true,
            branch: true,
            ownerUserId: true,
            operatorConfirmedAt: true,
            ownerConnection: {
              select: { status: true, confidence: true, displayName: true, lastSeenAt: true },
            },
          },
        })
      : null;
    const isAdmin = viewer.role === "OWNER" || viewer.role === "ADMIN";
    const canManage =
      Boolean(session && !session.endedAt) &&
      (isAdmin || (viewer.userId !== null && session?.ownerUserId === viewer.userId));
    const unavailableReason = !session
      ? "The delivery session no longer exists."
      : session.endedAt
        ? "The delivery session has already ended."
        : canManage
          ? null
          : "Only the work-session owner or a workspace admin can manage this session.";
    const primary: AttentionAction = {
      id: isStaleSession ? "RESUME_SESSION" : "CONFIRM_ACTIVE",
      label: isStaleSession ? "Resume session" : "Still working",
      description: isStaleSession
        ? "Resume this existing Delivery session and keep its ownership reserved."
        : "Record an audited operator confirmation and keep Delivery reserved without claiming the MCP client checked in.",
      tone: "PRIMARY",
      requiresConfirmation: false,
      enabled: unavailableReason === null,
      disabledReason: unavailableReason,
    };
    const abandon: AttentionAction = {
      id: "ABANDON_SESSION",
      label: "Abandon session",
      description:
        "End this Delivery session and release its ownership so replacement work can start.",
      tone: "DANGER",
      requiresConfirmation: true,
      enabled: unavailableReason === null,
      disabledReason: unavailableReason,
    };
    const respondInIssue: AttentionAction | null = request.issueId
      ? {
          id: "RESPOND_IN_ISSUE",
          label: "Respond in issue",
          description:
            "Open the issue composer with this request’s context so you can explain the intended next step.",
          tone: "NEUTRAL",
          requiresConfirmation: false,
          enabled: true,
          disabledReason: null,
        }
      : null;
    return {
      ...base,
      category: isMcpQuiet ? "DELIVERY_STATUS_REQUIRED" : "DELIVERY_RECOVERY",
      protocol: "WORK_SESSION_RECOVERY",
      replyTarget: null,
      actions: [
        primary,
        abandon,
        ...(respondInIssue ? [respondInIssue] : []),
        dismiss,
        ...(openIssue ? [openIssue] : []),
      ],
      details: [
        { label: "Delivery state", value: session?.status ?? "Unavailable" },
        ...(session
          ? [{ label: "Branch", value: `${session.repoFullName}:${session.branch}` }]
          : []),
        ...(session?.ownerConnection?.displayName
          ? [{ label: "Owning connection", value: session.ownerConnection.displayName }]
          : []),
        ...(session?.ownerConnection
          ? [
              {
                label: "Connection evidence",
                value: `${session.ownerConnection.status.toLowerCase()} · ${session.ownerConnection.confidence.toLowerCase()}`,
              },
            ]
          : []),
        ...(session?.operatorConfirmedAt
          ? [
              {
                label: "Last operator confirmation",
                value: session.operatorConfirmedAt.toISOString(),
              },
            ]
          : []),
      ],
      technicalDetails: [
        ...base.technicalDetails,
        ...(session ? [{ label: "Work session", value: session.id }] : []),
        ...(session?.ownerConnection?.lastSeenAt
          ? [
              {
                label: "Connection last seen",
                value: session.ownerConnection.lastSeenAt.toISOString(),
              },
            ]
          : []),
      ],
    };
  }

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
          dismiss,
          ...(openIssue ? [openIssue] : []),
        ]
      : openIssue
        ? [
            {
              id: "RESPOND_IN_ISSUE",
              label: "Respond in issue",
              description:
                "Open the issue composer with this request’s context when no structured operation is available.",
              tone: "PRIMARY",
              requiresConfirmation: false,
              enabled: true,
              disabledReason: null,
            },
            dismiss,
            openIssue,
          ]
        : [dismiss];
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
      const issueAccess = issueWhereForViewer(ctx);
      const actionRequestAccess = {
        AND: [
          decisionAskWhere(ctx.workspaceId, userId ?? ""),
          { OR: [{ issueId: null }, { issue: issueAccess }] },
        ],
      };
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
              where: actionRequestAccess,
              orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
              take: input.limit,
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
        userId ? ctx.db.actionRequest.count({ where: actionRequestAccess }) : Promise.resolve(0),
        listReviewGatesWithContext(ctx.db, {
          workspaceId: ctx.workspaceId,
          status: ReviewGateStatus.PENDING,
          limit: input.limit,
          membership: ctx.membership,
        }),
        listReviewGatesWithContext(ctx.db, {
          workspaceId: ctx.workspaceId,
          status: ReviewGateStatus.PENDING,
          limit: 1000,
          membership: ctx.membership,
        }).then((rows) => rows.length),
        ctx.db.agentRun.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
            issue: issueAccess,
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
            issue: issueAccess,
          },
        }),
        ctx.db.agentRun.count({
          where: {
            workspaceId: ctx.workspaceId,
            status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
            awaitingApprovalAt: { not: null },
            issue: issueAccess,
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
            AND: [issueAccess],
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
                issue: issueAccess,
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

      const recoveryIssueIds = new Set(
        (
          await ctx.db.issue.findMany({
            where: {
              id: { in: runRecovery.items.map((item) => item.run.issueId) },
              AND: [issueAccess],
            },
            select: { id: true },
          })
        ).map((issue) => issue.id),
      );
      runRecovery.items = runRecovery.items.filter((item) =>
        recoveryIssueIds.has(item.run.issueId),
      );
      runRecovery.counts = {
        total: runRecovery.items.length,
        activeStale: runRecovery.items.filter((item) => item.reason === "active-stale").length,
        terminalFailures: runRecovery.items.filter((item) => item.reason === "terminal-failure")
          .length,
        protocolFailed: runRecovery.items.filter((item) => item.reason === "protocol-failed")
          .length,
      };

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

      const presentedActionRequests = await Promise.all(
        actionRequests.map(async (request) => ({
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
    const issueAccess = issueWhereForViewer(ctx);
    const [actionRequests, reviewGates, runtimeApprovals] = await Promise.all([
      userId
        ? ctx.db.actionRequest.count({
            where: {
              AND: [
                decisionAskWhere(ctx.workspaceId, userId),
                { OR: [{ issueId: null }, { issue: issueAccess }] },
              ],
            },
          })
        : Promise.resolve(0),
      listReviewGatesWithContext(ctx.db, {
        workspaceId: ctx.workspaceId,
        status: ReviewGateStatus.PENDING,
        limit: 1000,
        membership: ctx.membership,
      }).then((rows) => rows.length),
      ctx.db.agentRun.count({
        where: {
          workspaceId: ctx.workspaceId,
          status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
          awaitingApprovalAt: { not: null },
          issue: issueAccess,
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
