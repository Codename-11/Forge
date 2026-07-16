import { z } from "zod";
import {
  ActionRequestStatus,
  AgentRunStatus,
  EventKind,
  ReviewGateStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { presenceAvailability } from "@/lib/transport-display";
import { listRunRecoveryItems } from "@/server/services/agent-run-recovery";

/**
 * Activity drawer feed.
 *
 * Returns recent ActivityEvent rows the caller is likely to care about,
 * with referenced issues + agents hydrated. The drawer is a thin client
 * over this — no per-row personalisation beyond "events on issues
 * assigned to me OR mentioning me OR agent-touching events in this
 * workspace".
 *
 * Cursor pagination on (createdAt DESC, id DESC). Cursor is the id of
 * the last event in the previous page.
 */

const RELEVANT_KINDS: EventKind[] = [
  EventKind.ISSUE_CREATED,
  EventKind.ISSUE_UPDATED,
  EventKind.ISSUE_STATUS_CHANGED,
  EventKind.ISSUE_ASSIGNED,
  EventKind.ISSUE_PRIORITY_CHANGED,
  EventKind.ISSUE_QUEUED,
  EventKind.ISSUE_STALLED,
  EventKind.ISSUE_SLA_BREACH,
  EventKind.COMMENT_CREATED,
  EventKind.AGENT_ASSIGNED,
  EventKind.AGENT_NOACK,
  EventKind.AGENT_STATUS_CHANGED,
  EventKind.AGENT_RUN_STARTED,
  EventKind.AGENT_RUN_BLOCKED,
  EventKind.AGENT_RUN_COMPLETED,
  EventKind.AGENT_RUN_STALLED,
  EventKind.AGENT_RUN_CLEARED,
  EventKind.AGENT_RUN_CONTROL_REQUESTED,
  EventKind.AGENT_RUN_KICKED,
];
const CHAT_ACTIVITY_KINDS: EventKind[] = [
  EventKind.CHAT_MESSAGE_POSTED,
  EventKind.CHAT_THREAD_COMPACTED,
];

const TIMELINE_KINDS: EventKind[] = [
  ...RELEVANT_KINDS,
  EventKind.GOAL_CREATED,
  EventKind.GOAL_STATUS_CHANGED,
  EventKind.EXECUTION_STEP_READY,
  EventKind.EXECUTION_STEP_JUDGED,
  EventKind.PLAN_BUDGET_EXCEEDED,
  EventKind.PLAN_STALLED,
  EventKind.ISSUE_SNOOZED,
  EventKind.ISSUE_UNSNOOZED,
  EventKind.ISSUE_NUDGED,
];

const AGENT_TIMELINE_KINDS = new Set<EventKind>([
  EventKind.AGENT_ASSIGNED,
  EventKind.AGENT_NOACK,
  EventKind.AGENT_STATUS_CHANGED,
  EventKind.AGENT_RUN_STARTED,
  EventKind.AGENT_RUN_BLOCKED,
  EventKind.AGENT_RUN_COMPLETED,
  EventKind.AGENT_RUN_STALLED,
  EventKind.AGENT_RUN_CLEARED,
  EventKind.AGENT_RUN_CONTROL_REQUESTED,
  EventKind.AGENT_RUN_KICKED,
  EventKind.EXECUTION_STEP_READY,
  EventKind.EXECUTION_STEP_JUDGED,
  EventKind.PLAN_BUDGET_EXCEEDED,
  EventKind.PLAN_STALLED,
]);

const DECISION_TIMELINE_KINDS = new Set<EventKind>([
  EventKind.AGENT_NOACK,
  EventKind.AGENT_RUN_BLOCKED,
  EventKind.AGENT_RUN_STALLED,
  EventKind.AGENT_RUN_CONTROL_REQUESTED,
  EventKind.ISSUE_STALLED,
  EventKind.ISSUE_SLA_BREACH,
  EventKind.EXECUTION_STEP_JUDGED,
  EventKind.PLAN_BUDGET_EXCEEDED,
  EventKind.PLAN_STALLED,
]);

/**
 * State signals that a periodic watchdog may record more than once. The
 * immutable event stream keeps every occurrence, but the compact timeline
 * groups repeats so one subject cannot monopolize the whole pane.
 */
const COLLAPSIBLE_TIMELINE_KINDS = new Set<EventKind>([
  EventKind.ISSUE_STALLED,
  EventKind.ISSUE_SLA_BREACH,
  EventKind.AGENT_NOACK,
  EventKind.AGENT_RUN_STALLED,
  EventKind.PLAN_STALLED,
]);

const timelineFilterSchema = z.enum(["all", "mine", "agents", "decisions"]);

export const eventRouter = router({
  recent: workspaceProcedure
    .input(
      z
        .object({
          cursor: z.string().cuid().optional(),
          limit: z.number().int().min(1).max(100).default(40),
          /// When true, restricts to events touching the caller (assigned
          /// to them, mentioning them, comments they authored). Default
          /// false = workspace-wide stream.
          mineOnly: z.boolean().default(false),
        })
        .default({ limit: 40, mineOnly: false }),
    )
    .query(async ({ ctx, input }) => {
      const cursorRow = input.cursor
        ? await ctx.db.activityEvent.findUnique({
            where: { id: input.cursor },
            select: { createdAt: true },
          })
        : null;

      const myChatThreadIds = (
        await ctx.db.chatThread.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            userId: ctx.session.user.id,
            archivedAt: null,
          },
          select: { id: true },
        })
      ).map((thread) => thread.id);
      const ownedChatWhere: Prisma.ActivityEventWhereInput | null = myChatThreadIds.length
        ? {
            kind: { in: CHAT_ACTIVITY_KINDS },
            subjectType: "chat-thread",
            subjectId: { in: myChatThreadIds },
          }
        : null;

      const where: Prisma.ActivityEventWhereInput = {
        workspaceId: ctx.workspaceId,
        ...(cursorRow ? { createdAt: { lt: cursorRow.createdAt } } : {}),
      };

      if (input.mineOnly) {
        const userId = ctx.session.user.id;
        // Issues currently assigned to the caller (best-effort heuristic;
        // matches the agent.timeline approach).
        const myIssues = await ctx.db.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            OR: [
              { authorId: userId },
              { claimedById: userId },
              { assignees: { some: { userId } } },
            ],
          },
          select: { id: true },
        });
        const myIssueIds = myIssues.map((i) => i.id);
        where.OR = [
          {
            kind: { in: RELEVANT_KINDS },
            OR: [
              { actorId: userId },
              ...(myIssueIds.length
                ? [{ subjectType: "issue" as const, subjectId: { in: myIssueIds } }]
                : []),
            ],
          },
          ...(ownedChatWhere ? [ownedChatWhere] : []),
        ];
      } else {
        where.OR = [{ kind: { in: RELEVANT_KINDS } }, ...(ownedChatWhere ? [ownedChatWhere] : [])];
      }

      const rows = await ctx.db.activityEvent.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        include: {
          actor: { select: { id: true, name: true, image: true } },
          actorAgent: {
            select: { id: true, name: true, profileKey: true, avatar: true },
          },
        },
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const nextCursor = hasMore ? page[page.length - 1].id : null;

      // Batch-hydrate referenced issues + agents in one round-trip each.
      const issueIds = new Set<string>();
      const agentIds = new Set<string>();
      for (const e of page) {
        if (e.subjectType === "issue") issueIds.add(e.subjectId);
        if (e.subjectType === "agent") agentIds.add(e.subjectId);
        const payload = (e.payload ?? {}) as Record<string, unknown>;
        const pIssueId = payload.issueId;
        if (typeof pIssueId === "string") issueIds.add(pIssueId);
        const pAgentId = payload.agentId;
        if (typeof pAgentId === "string") agentIds.add(pAgentId);
      }
      const [issues, agents] = await Promise.all([
        issueIds.size
          ? ctx.db.issue.findMany({
              where: {
                id: { in: Array.from(issueIds) },
                workspaceId: ctx.workspaceId,
              },
              select: {
                id: true,
                number: true,
                title: true,
                workspace: { select: { key: true } },
                status: {
                  select: { id: true, name: true, color: true, category: true },
                },
                project: { select: { id: true, key: true, name: true, color: true } },
                assignedAgent: {
                  select: { id: true, name: true, profileKey: true },
                },
              },
            })
          : Promise.resolve([]),
        agentIds.size
          ? ctx.db.agent.findMany({
              where: {
                id: { in: Array.from(agentIds) },
                workspaceId: ctx.workspaceId,
              },
              select: {
                id: true,
                name: true,
                profileKey: true,
                avatar: true,
                status: true,
              },
            })
          : Promise.resolve([]),
      ]);

      const issueById = new Map(issues.map((i) => [i.id, i]));
      const agentById = new Map(agents.map((a) => [a.id, a]));

      return {
        events: page.map((e) => {
          const payload = (e.payload ?? {}) as Record<string, unknown>;
          const pAgentId = typeof payload.agentId === "string" ? (payload.agentId as string) : null;
          const pIssueId = typeof payload.issueId === "string" ? (payload.issueId as string) : null;
          const subjectIssue =
            e.subjectType === "issue"
              ? (issueById.get(e.subjectId) ?? null)
              : pIssueId
                ? (issueById.get(pIssueId) ?? null)
                : null;
          const subjectAgent =
            e.subjectType === "agent" ? (agentById.get(e.subjectId) ?? null) : null;
          const payloadAgent = pAgentId ? (agentById.get(pAgentId) ?? null) : null;
          return {
            id: e.id,
            kind: e.kind,
            createdAt: e.createdAt,
            actor: e.actor,
            actorAgent: e.actorAgent,
            subjectType: e.subjectType,
            subjectId: e.subjectId,
            issue: subjectIssue,
            agent: subjectAgent ?? payloadAgent,
            payload: e.payload,
          };
        }),
        nextCursor,
      };
    }),

  /**
   * Workspace-wide activity timeline for daily-driving surfaces. Unlike
   * `recent`, this maps raw ActivityEvent rows into display-ready copy,
   * actor labels, and canonical jump links so Dashboard / Command Center
   * do not each re-interpret event enums.
   */
  timeline: workspaceProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(50).default(12),
          filter: timelineFilterSchema.default("all"),
        })
        .default({ limit: 12, filter: "all" }),
    )
    .query(async ({ ctx, input }) => {
      const workspace = await ctx.db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { slug: true, key: true },
      });
      const ownedChatWhere = await ownedChatActivityWhere(ctx.db, {
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
      });
      const where: Prisma.ActivityEventWhereInput = {
        workspaceId: ctx.workspaceId,
      };

      if (input.filter === "mine") {
        where.OR = await mineActivityWhere(ctx.db, {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
          ownedChatWhere,
        });
      } else if (input.filter === "agents") {
        where.OR = [
          { kind: { in: Array.from(AGENT_TIMELINE_KINDS) } },
          { actorAgentId: { not: null } },
          { subjectType: { in: ["agent", "agent-run", "execution-step"] } },
        ];
      } else if (input.filter === "decisions") {
        where.OR = [
          { kind: { in: Array.from(DECISION_TIMELINE_KINDS) } },
          { subjectType: { in: ["action-request", "review-gate"] } },
        ];
      } else {
        where.OR = [{ kind: { in: TIMELINE_KINDS } }, ...(ownedChatWhere ? [ownedChatWhere] : [])];
      }

      const rows = await ctx.db.activityEvent.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        // Over-fetch so grouped watchdog signals do not leave a short pane.
        take: Math.min(input.limit * 5, 100),
        include: {
          actor: { select: { id: true, name: true, handle: true, image: true } },
          actorAgent: {
            select: { id: true, name: true, profileKey: true, avatar: true },
          },
        },
      });

      const hydrated = await hydrateTimelineReferences(ctx.db, {
        workspaceId: ctx.workspaceId,
        rows,
      });

      const mapped = rows
        .map((row) => mapTimelineRow(row, hydrated, workspace))
        .filter((row): row is NonNullable<typeof row> => Boolean(row));
      const items = collapseRecurringTimelineRows(mapped).slice(0, input.limit);

      return { items };
    }),

  /**
   * Per-agent attention rollup. This is intentionally not a health roster:
   * it answers what the operator may need to do for each agent right now
   * (questions, approvals, blocked/stale runs, and live work).
   */
  agentAttention: workspaceProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(20).default(8),
          itemLimit: z.number().int().min(1).max(8).default(4),
        })
        .default({ limit: 8, itemLimit: 4 }),
    )
    .query(async ({ ctx, input }) => {
      const workspace = await ctx.db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { slug: true, key: true },
      });

      const [agents, actionRequests, reviewGates, runs, recovery] = await Promise.all([
        ctx.db.agent.findMany({
          where: { workspaceId: ctx.workspaceId, archivedAt: null },
          orderBy: { name: "asc" },
          select: {
            id: true,
            profileKey: true,
            name: true,
            avatar: true,
            status: true,
            provider: true,
            runtimeMode: true,
            runtimeId: true,
            webhookUrl: true,
            lastHeartbeatAt: true,
          },
        }),
        ctx.db.actionRequest.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            status: ActionRequestStatus.OPEN,
            requestedByAgentId: { not: null },
          },
          orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
          take: 100,
          include: {
            requestedByAgent: {
              select: { id: true, name: true, profileKey: true, avatar: true },
            },
            issue: {
              select: {
                id: true,
                number: true,
                title: true,
                workspace: { select: { key: true } },
              },
            },
          },
        }),
        ctx.db.reviewGate.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            status: ReviewGateStatus.PENDING,
            requestedByAgentId: { not: null },
          },
          orderBy: { createdAt: "desc" },
          take: 100,
          include: {
            requestedByAgent: {
              select: { id: true, name: true, profileKey: true, avatar: true },
            },
          },
        }),
        ctx.db.agentRun.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
          },
          orderBy: [{ lastEventAt: "desc" }, { startedAt: "desc" }],
          take: 100,
          include: {
            agent: { select: { id: true, name: true, profileKey: true, avatar: true } },
            issue: {
              select: {
                id: true,
                number: true,
                title: true,
                workspace: { select: { key: true } },
              },
            },
          },
        }),
        listRunRecoveryItems(ctx.db, {
          workspaceId: ctx.workspaceId,
          limit: 50,
        }),
      ]);

      const rows = agents
        .map((agent) => {
          const questions = actionRequests.filter((r) => r.requestedByAgentId === agent.id);
          const gates = reviewGates.filter((g) => g.requestedByAgentId === agent.id);
          const agentRuns = runs.filter((r) => r.agentId === agent.id);
          const blockers = recovery.items.filter((r) => r.run.agentId === agent.id);
          const approvals = agentRuns.filter((r) => r.awaitingApprovalAt);
          const ordinaryRuns = agentRuns.filter((r) => !r.awaitingApprovalAt);
          const items: AgentAttentionItem[] = [];

          for (const request of questions) {
            items.push({
              id: `ask:${request.id}`,
              kind: "question",
              tone:
                request.severity === "ERROR" || request.severity === "CRITICAL"
                  ? "danger"
                  : "warning",
              title: request.title,
              detail: request.issue
                ? `${issueLabel(request.issue)} · ${request.issue.title}`
                : (request.body ?? "Open question from agent"),
              href: `/w/${workspace.slug}/command-center`,
              createdAt: request.createdAt,
            });
          }
          for (const gate of gates) {
            items.push({
              id: `gate:${gate.id}`,
              kind: "review",
              tone: "warning",
              title: "Review gate pending",
              detail: gate.prompt,
              href: gateHref(workspace.slug, gate.targetType, gate.targetId),
              createdAt: gate.createdAt,
            });
          }
          for (const run of blockers) {
            const issue = run.run.issue;
            items.push({
              id: `blocker:${run.run.id}`,
              kind: "blocked",
              tone: run.severity === "error" ? "danger" : "warning",
              title: run.title,
              detail: `${issueLabel(issue)} · ${run.detail}`,
              href: issueHref(workspace.slug, issue),
              createdAt: run.run.finishedAt ?? run.run.lastEventAt,
            });
          }
          for (const run of approvals) {
            items.push({
              id: `approval:${run.id}`,
              kind: "approval",
              tone: "warning",
              title: "Runtime approval needed",
              detail: `${issueLabel(run.issue)} · ${run.currentStep ?? run.issue.title}`,
              href: issueHref(workspace.slug, run.issue),
              createdAt: run.awaitingApprovalAt ?? run.lastEventAt,
            });
          }
          for (const run of agentRuns) {
            if (run.awaitingApprovalAt) continue;
            items.push({
              id: `run:${run.id}`,
              kind: "active",
              tone: run.status === "WAITING" ? "warning" : "neutral",
              title: run.status === "WAITING" ? "Waiting run" : "Active run",
              detail: `${issueLabel(run.issue)} · ${run.currentStep ?? run.issue.title}`,
              href: issueHref(workspace.slug, run.issue),
              createdAt: run.lastEventAt,
            });
          }

          items.sort((a, b) => {
            const rank = (item: AgentAttentionItem) =>
              item.kind === "blocked"
                ? 0
                : item.kind === "question"
                  ? 1
                  : item.kind === "approval"
                    ? 2
                    : item.kind === "review"
                      ? 3
                      : 4;
            const byRank = rank(a) - rank(b);
            if (byRank !== 0) return byRank;
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          });

          return {
            agent: {
              id: agent.id,
              profileKey: agent.profileKey,
              name: agent.name,
              avatar: agent.avatar,
              status: agent.status,
              lastHeartbeatAt: agent.lastHeartbeatAt,
              availability: presenceAvailability(agent),
            },
            counts: {
              questions: questions.length,
              reviewGates: gates.length,
              approvals: approvals.length,
              blocked: blockers.length,
              activeRuns: ordinaryRuns.length,
              total:
                questions.length +
                gates.length +
                approvals.length +
                blockers.length +
                ordinaryRuns.length,
            },
            items: items.slice(0, input.itemLimit),
          };
        })
        .filter((row) => row.counts.total > 0)
        .sort((a, b) => {
          const severityA = a.counts.blocked * 10 + a.counts.questions * 5 + a.counts.approvals * 3;
          const severityB = b.counts.blocked * 10 + b.counts.questions * 5 + b.counts.approvals * 3;
          if (severityA !== severityB) return severityB - severityA;
          return b.counts.total - a.counts.total;
        })
        .slice(0, input.limit);

      return { agents: rows, recoveryCounts: recovery.counts };
    }),

  /**
   * Unread count since `since`. Cheap COUNT for the topbar bell badge.
   * Caller is expected to track `since` per-user in localStorage / a
   * future UserState row; we don't persist read-state server-side yet.
   */
  unreadCount: workspaceProcedure
    .input(
      z
        .object({
          since: z.date().optional(),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      // Default window: 24h ago — nothing older counts as "unread" even
      // if the user has never opened the drawer. Keeps the badge bounded.
      const since = input.since ?? new Date(Date.now() - 24 * 60 * 60_000);
      const myChatThreadIds = (
        await ctx.db.chatThread.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            userId: ctx.session.user.id,
            archivedAt: null,
          },
          select: { id: true },
        })
      ).map((thread) => thread.id);
      const count = await ctx.db.activityEvent.count({
        where: {
          workspaceId: ctx.workspaceId,
          createdAt: { gte: since },
          OR: [
            { kind: { in: RELEVANT_KINDS } },
            ...(myChatThreadIds.length
              ? [
                  {
                    kind: { in: CHAT_ACTIVITY_KINDS },
                    subjectType: "chat-thread" as const,
                    subjectId: { in: myChatThreadIds },
                  },
                ]
              : []),
          ],
        },
      });
      return { count, since: since.toISOString() };
    }),
});

type TimelineReferenceHydration = Awaited<ReturnType<typeof hydrateTimelineReferences>>;
type ActivityRow = Prisma.ActivityEventGetPayload<{
  include: {
    actor: { select: { id: true; name: true; handle: true; image: true } };
    actorAgent: { select: { id: true; name: true; profileKey: true; avatar: true } };
  };
}>;
type TimelineWorkspace = { slug: string; key: string };

type TimelineTone = "neutral" | "success" | "warning" | "danger" | "muted";
type AgentAttentionItem = {
  id: string;
  kind: "question" | "review" | "blocked" | "approval" | "active";
  tone: TimelineTone;
  title: string;
  detail: string;
  href: string;
  createdAt: Date;
};

async function ownedChatActivityWhere(
  db: PrismaClient | Prisma.TransactionClient,
  input: { workspaceId: string; userId: string },
): Promise<Prisma.ActivityEventWhereInput | null> {
  const ids = (
    await db.chatThread.findMany({
      where: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        archivedAt: null,
      },
      select: { id: true },
    })
  ).map((thread) => thread.id);
  return ids.length
    ? {
        kind: { in: CHAT_ACTIVITY_KINDS },
        subjectType: "chat-thread",
        subjectId: { in: ids },
      }
    : null;
}

async function mineActivityWhere(
  db: PrismaClient | Prisma.TransactionClient,
  input: {
    workspaceId: string;
    userId: string;
    ownedChatWhere: Prisma.ActivityEventWhereInput | null;
  },
): Promise<Prisma.ActivityEventWhereInput[]> {
  const myIssueIds = (
    await db.issue.findMany({
      where: {
        workspaceId: input.workspaceId,
        OR: [
          { authorId: input.userId },
          { claimedById: input.userId },
          { assignees: { some: { userId: input.userId } } },
        ],
      },
      select: { id: true },
    })
  ).map((issue) => issue.id);

  return [
    {
      kind: { in: TIMELINE_KINDS },
      OR: [
        { actorId: input.userId },
        ...(myIssueIds.length
          ? [{ subjectType: "issue" as const, subjectId: { in: myIssueIds } }]
          : []),
      ],
    },
    ...(input.ownedChatWhere ? [input.ownedChatWhere] : []),
  ];
}

async function hydrateTimelineReferences(
  db: PrismaClient | Prisma.TransactionClient,
  input: { workspaceId: string; rows: ActivityRow[] },
) {
  const issueIds = new Set<string>();
  const agentIds = new Set<string>();
  const runIds = new Set<string>();
  const goalIds = new Set<string>();
  const planIds = new Set<string>();
  const stepIds = new Set<string>();

  for (const row of input.rows) {
    const payload = payloadRecord(row.payload);
    if (row.subjectType === "issue") issueIds.add(row.subjectId);
    if (row.subjectType === "agent") agentIds.add(row.subjectId);
    if (row.subjectType === "agent-run") runIds.add(row.subjectId);
    if (row.subjectType === "goal") goalIds.add(row.subjectId);
    if (row.subjectType === "execution-plan") planIds.add(row.subjectId);
    if (row.subjectType === "execution-step") stepIds.add(row.subjectId);
    addPayloadString(payload, "issueId", issueIds);
    addPayloadString(payload, "agentId", agentIds);
    addPayloadString(payload, "assignedAgentId", agentIds);
    addPayloadString(payload, "previousAgentId", agentIds);
    addPayloadString(payload, "runId", runIds);
    addPayloadString(payload, "goalId", goalIds);
    addPayloadString(payload, "planId", planIds);
    addPayloadString(payload, "stepId", stepIds);
  }

  const [issues, agents, runs, goals, plans, steps] = await Promise.all([
    issueIds.size
      ? db.issue.findMany({
          where: { workspaceId: input.workspaceId, id: { in: Array.from(issueIds) } },
          select: {
            id: true,
            number: true,
            title: true,
            workspace: { select: { key: true } },
            status: { select: { name: true, category: true, color: true } },
            assignedAgent: { select: { id: true, name: true, profileKey: true } },
          },
        })
      : Promise.resolve([]),
    agentIds.size
      ? db.agent.findMany({
          where: { workspaceId: input.workspaceId, id: { in: Array.from(agentIds) } },
          select: { id: true, name: true, profileKey: true, avatar: true, status: true },
        })
      : Promise.resolve([]),
    runIds.size
      ? db.agentRun.findMany({
          where: { workspaceId: input.workspaceId, id: { in: Array.from(runIds) } },
          select: {
            id: true,
            status: true,
            currentStep: true,
            summary: true,
            issue: {
              select: {
                id: true,
                number: true,
                title: true,
                workspace: { select: { key: true } },
              },
            },
            agent: { select: { id: true, name: true, profileKey: true, avatar: true } },
            executionStepId: true,
          },
        })
      : Promise.resolve([]),
    goalIds.size
      ? db.goal.findMany({
          where: { workspaceId: input.workspaceId, id: { in: Array.from(goalIds) } },
          select: { id: true, title: true, status: true },
        })
      : Promise.resolve([]),
    planIds.size
      ? db.executionPlan.findMany({
          where: { workspaceId: input.workspaceId, id: { in: Array.from(planIds) } },
          select: { id: true, title: true, status: true, goalId: true },
        })
      : Promise.resolve([]),
    stepIds.size
      ? db.executionStep.findMany({
          where: { workspaceId: input.workspaceId, id: { in: Array.from(stepIds) } },
          select: {
            id: true,
            title: true,
            status: true,
            planId: true,
            issue: {
              select: {
                id: true,
                number: true,
                title: true,
                workspace: { select: { key: true } },
              },
            },
          },
        })
      : Promise.resolve([]),
  ]);

  return {
    issues: new Map(issues.map((row) => [row.id, row])),
    agents: new Map(agents.map((row) => [row.id, row])),
    runs: new Map(runs.map((row) => [row.id, row])),
    goals: new Map(goals.map((row) => [row.id, row])),
    plans: new Map(plans.map((row) => [row.id, row])),
    steps: new Map(steps.map((row) => [row.id, row])),
  };
}

function mapTimelineRow(
  row: ActivityRow,
  refs: TimelineReferenceHydration,
  workspace: TimelineWorkspace,
) {
  const payload = payloadRecord(row.payload);
  const issue =
    row.subjectType === "issue"
      ? (refs.issues.get(row.subjectId) ?? null)
      : payloadString(payload, "issueId")
        ? (refs.issues.get(payloadString(payload, "issueId")!) ?? null)
        : null;
  const run =
    row.subjectType === "agent-run"
      ? (refs.runs.get(row.subjectId) ?? null)
      : payloadString(payload, "runId")
        ? (refs.runs.get(payloadString(payload, "runId")!) ?? null)
        : null;
  const agent =
    row.subjectType === "agent"
      ? (refs.agents.get(row.subjectId) ?? null)
      : payloadString(payload, "agentId")
        ? (refs.agents.get(payloadString(payload, "agentId")!) ?? null)
        : (run?.agent ?? null);
  const goal =
    row.subjectType === "goal"
      ? (refs.goals.get(row.subjectId) ?? null)
      : payloadString(payload, "goalId")
        ? (refs.goals.get(payloadString(payload, "goalId")!) ?? null)
        : null;
  const plan =
    row.subjectType === "execution-plan"
      ? (refs.plans.get(row.subjectId) ?? null)
      : payloadString(payload, "planId")
        ? (refs.plans.get(payloadString(payload, "planId")!) ?? null)
        : null;
  const step =
    row.subjectType === "execution-step"
      ? (refs.steps.get(row.subjectId) ?? null)
      : payloadString(payload, "stepId")
        ? (refs.steps.get(payloadString(payload, "stepId")!) ?? null)
        : null;

  const actor = actorLabel(row);
  const actorKind = row.actorAgent ? "agent" : row.actor ? "user" : "system";
  const targetIssue = issue ?? run?.issue ?? step?.issue ?? null;
  const targetAgent = agent ?? run?.agent ?? row.actorAgent ?? null;
  const targetLabel = targetIssue ? issueLabel(targetIssue) : null;
  const agentLabel = targetAgent?.profileKey ? `@${targetAgent.profileKey}` : "Agent";

  let title = `${actor} recorded ${humanKind(row.kind)}`;
  let detail = payloadString(payload, "summary") ?? payloadString(payload, "reason") ?? null;
  let tone: TimelineTone = "neutral";
  let category: "issue" | "agent" | "run" | "goal" | "plan" | "decision" | "chat" | "system" =
    "system";
  let href = `/w/${workspace.slug}`;

  if (targetIssue) {
    href = issueHref(workspace.slug, targetIssue);
    category = "issue";
  }
  if (goal) {
    href = `/w/${workspace.slug}/goals/${goal.id}`;
    category = "goal";
  }
  if (plan) {
    href = `/w/${workspace.slug}/plans/${plan.id}`;
    category = "plan";
  }
  if (step?.planId) {
    href = `/w/${workspace.slug}/plans/${step.planId}`;
    category = "plan";
  }
  if (!targetIssue && targetAgent?.profileKey) {
    href = `/w/${workspace.slug}/agents/${targetAgent.profileKey}`;
    category = "agent";
  }

  switch (row.kind) {
    case EventKind.ISSUE_CREATED:
      title = `${actor} created ${targetLabel ?? "an issue"}`;
      detail = targetIssue?.title ?? detail;
      break;
    case EventKind.ISSUE_UPDATED:
      title = `${actor} updated ${targetLabel ?? "an issue"}`;
      detail = targetIssue?.title ?? detail;
      break;
    case EventKind.ISSUE_STATUS_CHANGED:
      title = `${actor} moved ${targetLabel ?? "an issue"}`;
      detail = statusDetail(payload) ?? targetIssue?.title ?? detail;
      break;
    case EventKind.ISSUE_ASSIGNED:
      title = `${actor} changed assignees on ${targetLabel ?? "an issue"}`;
      detail = targetIssue?.title ?? detail;
      break;
    case EventKind.ISSUE_PRIORITY_CHANGED:
      title = `${actor} changed priority on ${targetLabel ?? "an issue"}`;
      detail = targetIssue?.title ?? detail;
      break;
    case EventKind.ISSUE_QUEUED:
      title = `${targetLabel ?? "Issue"} entered the queue`;
      detail = targetIssue?.title ?? detail;
      tone = "warning";
      break;
    case EventKind.ISSUE_STALLED:
      title = `${targetLabel ?? "Issue"} stalled`;
      detail = targetIssue
        ? [
            targetIssue.title,
            issue?.assignedAgent?.profileKey
              ? `assigned to @${issue.assignedAgent.profileKey}`
              : null,
            "open the issue to choose the next step",
          ]
            .filter(Boolean)
            .join(" · ")
        : detail;
      tone = "warning";
      category = "decision";
      break;
    case EventKind.ISSUE_SLA_BREACH:
      title = `${targetLabel ?? "Issue"} breached SLA`;
      detail = targetIssue?.title ?? detail;
      tone = "danger";
      category = "decision";
      break;
    case EventKind.ISSUE_SNOOZED:
      title = `${actor} snoozed ${targetLabel ?? "an issue"}`;
      detail = targetIssue?.title ?? detail;
      tone = "muted";
      break;
    case EventKind.ISSUE_UNSNOOZED:
      title = `${actor} unsnoozed ${targetLabel ?? "an issue"}`;
      detail = targetIssue?.title ?? detail;
      break;
    case EventKind.ISSUE_NUDGED:
      title = `${actor} nudged ${targetLabel ?? "an issue"}`;
      detail = targetIssue?.title ?? detail;
      tone = "warning";
      break;
    case EventKind.COMMENT_CREATED:
      title = `${actor} commented on ${targetLabel ?? "an issue"}`;
      detail = targetIssue?.title ?? payloadString(payload, "body") ?? detail;
      break;
    case EventKind.AGENT_ASSIGNED:
      title = `${agentLabel} assigned to ${targetLabel ?? "work"}`;
      detail = payloadString(payload, "reason") ?? targetIssue?.title ?? detail;
      category = "agent";
      break;
    case EventKind.AGENT_STATUS_CHANGED:
      title = `${agentLabel} status changed`;
      detail = statusDetail(payload) ?? detail;
      category = "agent";
      break;
    case EventKind.AGENT_NOACK:
      title = `${agentLabel} missed wake for ${targetLabel ?? "work"}`;
      detail = targetIssue?.title ?? detail;
      tone = "warning";
      category = "decision";
      break;
    case EventKind.AGENT_RUN_STARTED:
      title = `${agentLabel} started ${targetLabel ?? "a run"}`;
      detail = run?.currentStep ?? targetIssue?.title ?? detail;
      category = "run";
      break;
    case EventKind.AGENT_RUN_BLOCKED:
      title = `${agentLabel} is blocked on ${targetLabel ?? "a run"}`;
      detail = payloadString(payload, "reason") ?? run?.currentStep ?? detail;
      tone = "warning";
      category = "decision";
      break;
    case EventKind.AGENT_RUN_COMPLETED:
      title = `${agentLabel} completed ${targetLabel ?? "a run"}`;
      detail = payloadString(payload, "summary") ?? run?.summary ?? targetIssue?.title ?? detail;
      tone = "success";
      category = "run";
      break;
    case EventKind.AGENT_RUN_STALLED:
      title = `${agentLabel} stalled on ${targetLabel ?? "a run"}`;
      detail = payloadString(payload, "summary") ?? run?.summary ?? run?.currentStep ?? detail;
      tone = "danger";
      category = "decision";
      break;
    case EventKind.AGENT_RUN_CLEARED:
      title = `${actor} cleared a run for ${targetLabel ?? agentLabel}`;
      detail = run?.summary ?? detail;
      tone = "muted";
      category = "run";
      break;
    case EventKind.AGENT_RUN_CONTROL_REQUESTED:
      title = `Runtime approval needed for ${targetLabel ?? agentLabel}`;
      detail = payloadString(payload, "description") ?? run?.currentStep ?? detail;
      tone = "warning";
      category = "decision";
      break;
    case EventKind.AGENT_RUN_KICKED:
      title = `${actor} kicked ${agentLabel}`;
      detail = targetIssue ? `${targetLabel} · ${targetIssue.title}` : (run?.currentStep ?? detail);
      tone = "warning";
      category = "run";
      break;
    case EventKind.GOAL_CREATED:
      title = `${actor} created goal`;
      detail = goal?.title ?? detail;
      category = "goal";
      break;
    case EventKind.GOAL_STATUS_CHANGED:
      title = `${goal?.title ?? "Goal"} changed status`;
      detail = statusDetail(payload) ?? detail;
      tone = payloadString(payload, "to") === "ACHIEVED" ? "success" : "neutral";
      category = "goal";
      break;
    case EventKind.EXECUTION_STEP_READY:
      title = `${step?.title ?? payloadString(payload, "title") ?? "Step"} is ready`;
      detail = targetAgent?.profileKey
        ? `Assigned to @${targetAgent.profileKey}`
        : (plan?.title ?? detail);
      category = "plan";
      break;
    case EventKind.EXECUTION_STEP_JUDGED: {
      const outcome = payloadString(payload, "outcome") ?? payloadString(payload, "verdict");
      title = `${step?.title ?? "Step"} judged${outcome ? ` ${outcome.toLowerCase()}` : ""}`;
      detail = payloadString(payload, "feedback") ?? plan?.title ?? detail;
      tone = outcome === "BLOCKED" || outcome === "FAIL" ? "warning" : "success";
      category = outcome === "BLOCKED" ? "decision" : "plan";
      break;
    }
    case EventKind.PLAN_BUDGET_EXCEEDED:
      title = `${plan?.title ?? "Plan"} paused on budget`;
      detail = payloadString(payload, "reason") ?? detail;
      tone = "warning";
      category = "decision";
      break;
    case EventKind.CHAT_MESSAGE_POSTED:
      title = `${actor} posted in chat`;
      detail = payloadString(payload, "body") ?? detail;
      href = `/w/${workspace.slug}/chat`;
      category = "chat";
      break;
    case EventKind.CHAT_THREAD_COMPACTED:
      title = "Chat thread compacted";
      detail = payloadString(payload, "title") ?? detail;
      href = `/w/${workspace.slug}/chat`;
      category = "chat";
      tone = "muted";
      break;
  }

  return {
    id: row.id,
    kind: row.kind,
    category,
    tone,
    title,
    detail: detail ? truncate(detail, 180) : null,
    href,
    createdAt: row.createdAt,
    actor: {
      label: actor,
      kind: actorKind,
      avatar: row.actorAgent?.avatar ?? null,
      profileKey: row.actorAgent?.profileKey ?? null,
    },
    subject: {
      type: row.subjectType,
      id: row.subjectId,
      label:
        targetLabel ??
        goal?.title ??
        plan?.title ??
        step?.title ??
        targetAgent?.profileKey ??
        row.subjectType,
    },
    occurrences: 1,
  };
}

type MappedTimelineRow = NonNullable<ReturnType<typeof mapTimelineRow>>;

function collapseRecurringTimelineRows(items: MappedTimelineRow[]): MappedTimelineRow[] {
  const out: MappedTimelineRow[] = [];
  const indexByKey = new Map<string, number>();

  for (const item of items) {
    if (!COLLAPSIBLE_TIMELINE_KINDS.has(item.kind)) {
      out.push(item);
      continue;
    }
    const key = `${item.kind}:${item.subject.type}:${item.subject.id}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, out.length);
      out.push(item);
      continue;
    }
    const existing = out[existingIndex];
    out[existingIndex] = { ...existing, occurrences: existing.occurrences + 1 };
  }

  return out;
}

function actorLabel(row: ActivityRow): string {
  if (row.actorAgent) return `@${row.actorAgent.profileKey}`;
  if (row.actor?.name) return row.actor.name;
  if (row.actor?.handle) return `@${row.actor.handle}`;
  return "Forge";
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function addPayloadString(
  payload: Record<string, unknown>,
  key: string,
  target: Set<string>,
): void {
  const value = payloadString(payload, key);
  if (value) target.add(value);
}

function statusDetail(payload: Record<string, unknown>): string | null {
  const from = payloadString(payload, "from") ?? payloadString(payload, "before");
  const to = payloadString(payload, "to") ?? payloadString(payload, "after");
  if (from && to) return `${from} -> ${to}`;
  if (to) return `Now ${to}`;
  return null;
}

function humanKind(kind: EventKind): string {
  return kind.replace(/_/g, " ").toLowerCase();
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function issueLabel(issue: { number: number; workspace: { key: string } }): string {
  return `${issue.workspace.key}-${issue.number}`;
}

function issueHref(
  slug: string,
  issue: { id: string; number: number; workspace: { key: string } },
): string {
  return `/w/${slug}/i/${issue.workspace.key}-${issue.number}`;
}

function gateHref(slug: string, targetType: string, targetId: string): string {
  switch (targetType) {
    case "execution-plan":
      return `/w/${slug}/plans/${targetId}`;
    case "goal":
      return `/w/${slug}/goals/${targetId}`;
    case "issue":
      return `/w/${slug}/issues/${targetId}`;
    default:
      return `/w/${slug}/command-center`;
  }
}
