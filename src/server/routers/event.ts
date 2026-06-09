import { z } from "zod";
import { EventKind, type Prisma } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";

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
          const pAgentId =
            typeof payload.agentId === "string"
              ? (payload.agentId as string)
              : null;
          const pIssueId =
            typeof payload.issueId === "string"
              ? (payload.issueId as string)
              : null;
          const subjectIssue =
            e.subjectType === "issue"
              ? (issueById.get(e.subjectId) ?? null)
              : pIssueId
                ? (issueById.get(pIssueId) ?? null)
              : null;
          const subjectAgent =
            e.subjectType === "agent"
              ? (agentById.get(e.subjectId) ?? null)
              : null;
          const payloadAgent = pAgentId
            ? (agentById.get(pAgentId) ?? null)
            : null;
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
      const since =
        input.since ?? new Date(Date.now() - 24 * 60 * 60_000);
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
