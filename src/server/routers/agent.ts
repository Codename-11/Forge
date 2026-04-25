import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  AgentStatus,
  EventKind,
  RelationKind,
  type Prisma,
} from "@prisma/client";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import type { db as PrismaDb } from "@/server/db";

/**
 * Agent registry. Agents are MCP-first actors — LLM profiles that hold
 * ApiKeys, receive push dispatches, and can be assigned issues directly.
 *
 * `profileKey` is the stable cross-system handle (e.g. `victor`, `mizu`) and
 * matches the Hermes profile directory name so webhook payloads can route
 * locally without extra lookup.
 */

const profileKey = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "Lowercase, digits, `-` or `_` only");

const upsertInput = z.object({
  name: z.string().min(1).max(120),
  profileKey,
  description: z.string().max(2000).optional(),
  avatar: z.string().max(200).optional(),
  webhookUrl: z.string().url().max(500).optional().or(z.literal("")),
  capabilities: z.array(z.string().min(1).max(40)).max(32).default([]),
  maxConcurrent: z.number().int().min(0).max(100).default(1),
  /// Freeform markdown applied to the issue description when this agent
  /// is assigned to an issue whose description is empty. No length cap.
  templateMarkdown: z.string().optional(),
});

export const agentRouter = router({
  list: workspaceProcedure
    .input(
      z
        .object({
          includeArchived: z.boolean().default(false),
        })
        .default({ includeArchived: false }),
    )
    .query(({ ctx, input }) =>
      ctx.db.agent.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(input.includeArchived ? {} : { archivedAt: null }),
        },
        orderBy: [{ status: "asc" }, { name: "asc" }],
        include: { _count: { select: { assignedIssues: true } } },
      }),
    ),

  byId: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const agent = await ctx.db.agent.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: { _count: { select: { assignedIssues: true } } },
      });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND" });
      return agent;
    }),

  byProfileKey: workspaceProcedure
    .input(z.object({ profileKey }))
    .query(({ ctx, input }) =>
      ctx.db.agent.findUnique({
        where: {
          workspaceId_profileKey: {
            workspaceId: ctx.workspaceId,
            profileKey: input.profileKey,
          },
        },
      }),
    ),

  create: adminProcedure.input(upsertInput).mutation(async ({ ctx, input }) => {
    const existing = await ctx.db.agent.findUnique({
      where: {
        workspaceId_profileKey: {
          workspaceId: ctx.workspaceId,
          profileKey: input.profileKey,
        },
      },
    });
    if (existing) {
      throw new TRPCError({ code: "CONFLICT", message: "profileKey already used." });
    }
    return ctx.db.$transaction(async (tx) => {
      const agent = await tx.agent.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: input.name,
          profileKey: input.profileKey,
          description: input.description,
          avatar: input.avatar,
          webhookUrl: input.webhookUrl || null,
          capabilities: input.capabilities,
          maxConcurrent: input.maxConcurrent,
          templateMarkdown: input.templateMarkdown || null,
        },
      });
      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        entity: "Agent",
        entityId: agent.id,
        action: "create",
        after: agent,
        eventKind: EventKind.AGENT_CREATED,
        subjectType: "agent",
        subjectId: agent.id,
        payload: { name: agent.name, profileKey: agent.profileKey },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return agent;
    });
  }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(2000).nullable().optional(),
        avatar: z.string().max(200).nullable().optional(),
        webhookUrl: z.string().url().max(500).nullable().optional(),
        capabilities: z.array(z.string().min(1).max(40)).max(32).optional(),
        maxConcurrent: z.number().int().min(0).max(100).optional(),
        /// Freeform markdown template. Null clears. No length cap.
        templateMarkdown: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const before = await ctx.db.agent.findFirstOrThrow({
        where: { id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.$transaction(async (tx) => {
        const after = await tx.agent.update({ where: { id }, data: patch });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "Agent",
          entityId: id,
          action: "update",
          before,
          after,
          eventKind: EventKind.AGENT_UPDATED,
          subjectType: "agent",
          subjectId: id,
          payload: patch,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return after;
      });
    }),

  archive: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.agent.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.agent.update({
        where: { id: row.id },
        data: { archivedAt: new Date(), status: AgentStatus.OFFLINE },
      });
    }),

  unarchive: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.agent.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.agent.update({
        where: { id: row.id },
        data: { archivedAt: null },
      });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.agent.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.agent.delete({ where: { id: row.id } });
    }),

  /** Agent presence ping. Sets status and bumps lastHeartbeatAt. */
  heartbeat: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        status: z.nativeEnum(AgentStatus).default(AgentStatus.ONLINE),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.agent.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.agent.update({
        where: { id: row.id },
        data: { status: input.status, lastHeartbeatAt: new Date() },
      });
    }),

  /**
   * Pipeline view: per-agent swimlanes plus the unassigned pool.
   *
   * Buckets per agent:
   *   - assigned:    BACKLOG | TODO  (waiting to start)
   *   - inFlight:    IN_PROGRESS | IN_REVIEW
   *   - recentlyDone: DONE within `recentDays`
   * Pool = queued issues with assignedAgentId = null. Split into ready
   * (no open blockers) and blocked (at least one open blocker) so the
   * dispatcher view can highlight pickup-ready work first.
   */
  pipeline: workspaceProcedure
    .input(
      z
        .object({
          recentDays: z.number().int().min(1).max(30).default(7),
          laneLimit: z.number().int().min(1).max(100).default(25),
          poolLimit: z.number().int().min(1).max(200).default(50),
        })
        .default({ recentDays: 7, laneLimit: 25, poolLimit: 50 }),
    )
    .query(async ({ ctx, input }) => {
      const recentSince = new Date(
        Date.now() - input.recentDays * 86_400_000,
      );

      const issueInclude = {
        status: {
          select: { id: true, name: true, category: true, color: true },
        },
        project: {
          select: { id: true, key: true, name: true, color: true },
        },
        claimedBy: { select: { id: true, name: true, image: true } },
        _count: { select: { comments: true } },
      } as const;

      const blockedIds = await findBlockedIssueIdsForWorkspace(
        ctx.db,
        ctx.workspaceId,
      );

      const [poolRows, agents] = await Promise.all([
        ctx.db.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            deletedAt: null,
            queued: true,
            assignedAgentId: null,
            status: { category: { notIn: ["DONE", "CANCELED"] } },
          },
          orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
          take: input.poolLimit,
          include: issueInclude,
        }),
        ctx.db.agent.findMany({
          where: { workspaceId: ctx.workspaceId, archivedAt: null },
          orderBy: [{ status: "asc" }, { name: "asc" }],
        }),
      ]);

      const lanes = await Promise.all(
        agents.map(async (agent) => {
          const [assigned, inFlight, recentlyDone] = await Promise.all([
            ctx.db.issue.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                deletedAt: null,
                assignedAgentId: agent.id,
                status: { category: { in: ["BACKLOG", "TODO"] } },
              },
              orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
              take: input.laneLimit,
              include: issueInclude,
            }),
            ctx.db.issue.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                deletedAt: null,
                assignedAgentId: agent.id,
                status: { category: { in: ["IN_PROGRESS", "IN_REVIEW"] } },
              },
              orderBy: [
                { priority: "desc" },
                { startedAt: "desc" },
                { createdAt: "asc" },
              ],
              take: input.laneLimit,
              include: issueInclude,
            }),
            ctx.db.issue.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                deletedAt: null,
                assignedAgentId: agent.id,
                status: { category: "DONE" },
                completedAt: { gte: recentSince },
              },
              orderBy: [{ completedAt: "desc" }],
              take: input.laneLimit,
              include: issueInclude,
            }),
          ]);

          const annotate = <T extends { id: string }>(rows: T[]) =>
            rows.map((r) => ({ ...r, unblocked: !blockedIds.has(r.id) }));

          return {
            agent: {
              id: agent.id,
              name: agent.name,
              profileKey: agent.profileKey,
              avatar: agent.avatar,
              status: agent.status,
              maxConcurrent: agent.maxConcurrent,
              capabilities: agent.capabilities,
              lastHeartbeatAt: agent.lastHeartbeatAt,
              lastDispatchedAt: agent.lastDispatchedAt,
            },
            counts: {
              assigned: assigned.length,
              inFlight: inFlight.length,
              recentlyDone: recentlyDone.length,
              load: assigned.length + inFlight.length,
            },
            assigned: annotate(assigned),
            inFlight: annotate(inFlight),
            recentlyDone: recentlyDone.map((r) => ({
              ...r,
              unblocked: true,
            })),
          };
        }),
      );

      const poolAnnotated = poolRows.map((r) => ({
        ...r,
        unblocked: !blockedIds.has(r.id),
      }));

      return {
        pool: {
          ready: poolAnnotated.filter((r) => r.unblocked),
          blocked: poolAnnotated.filter((r) => !r.unblocked),
        },
        lanes,
        generatedAt: new Date().toISOString(),
      };
    }),

  /**
   * Chronological event feed scoped to agent activity.
   *
   * Kinds returned:
   *   - AGENT_*    (registry + assignment + status changes)
   *   - ISSUE_QUEUED, ISSUE_STATUS_CHANGED, COMMENT_CREATED
   *
   * When `agentId` is supplied, narrows to:
   *   - subjectType=agent AND subjectId=agentId, OR
   *   - kind=AGENT_ASSIGNED AND payload.agentId=agentId, OR
   *   - subjectType=issue AND issue is currently assigned to agentId.
   *
   * The "currently assigned" join is a heuristic — we don't snapshot the
   * agent at event time. Acceptable for v1 because reassignments are rare
   * and the page-level realtime invalidation fixes drift quickly.
   *
   * Cursor is the id of the last event in the previous page; pages are
   * ordered by createdAt DESC, id DESC.
   */
  timeline: workspaceProcedure
    .input(
      z
        .object({
          agentId: z.string().cuid().optional(),
          cursor: z.string().cuid().optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .default({ limit: 50 }),
    )
    .query(async ({ ctx, input }) => {
      const cursorRow = input.cursor
        ? await ctx.db.activityEvent.findUnique({
            where: { id: input.cursor },
            select: { createdAt: true },
          })
        : null;

      let issueIdScope: string[] | null = null;
      if (input.agentId) {
        const rows = await ctx.db.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            assignedAgentId: input.agentId,
          },
          select: { id: true },
        });
        issueIdScope = rows.map((r) => r.id);
      }

      const kinds: EventKind[] = [
        EventKind.AGENT_CREATED,
        EventKind.AGENT_UPDATED,
        EventKind.AGENT_DELETED,
        EventKind.AGENT_ASSIGNED,
        EventKind.AGENT_STATUS_CHANGED,
        EventKind.ISSUE_QUEUED,
        EventKind.ISSUE_STATUS_CHANGED,
        EventKind.COMMENT_CREATED,
      ];

      const where: Prisma.ActivityEventWhereInput = {
        workspaceId: ctx.workspaceId,
        kind: { in: kinds },
        ...(cursorRow ? { createdAt: { lt: cursorRow.createdAt } } : {}),
      };

      if (input.agentId) {
        const or: Prisma.ActivityEventWhereInput[] = [
          { subjectType: "agent", subjectId: input.agentId },
          {
            kind: EventKind.AGENT_ASSIGNED,
            payload: {
              path: ["agentId"],
              equals: input.agentId,
            } as Prisma.JsonFilter,
          },
        ];
        if (issueIdScope && issueIdScope.length) {
          or.push({
            subjectType: "issue",
            subjectId: { in: issueIdScope },
          });
        }
        where.OR = or;
      }

      const rows = await ctx.db.activityEvent.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        include: {
          actor: { select: { id: true, name: true, image: true } },
        },
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const nextCursor = hasMore ? page[page.length - 1].id : null;

      // Batch-hydrate referenced issues + agents.
      const issueIds = new Set<string>();
      const agentIds = new Set<string>();
      for (const e of page) {
        if (e.subjectType === "issue") issueIds.add(e.subjectId);
        if (e.subjectType === "agent") agentIds.add(e.subjectId);
        const payload = (e.payload ?? {}) as Record<string, unknown>;
        const pAgentId = payload.agentId;
        if (typeof pAgentId === "string") agentIds.add(pAgentId);
      }

      const [issues, agentsById] = await Promise.all([
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
                  select: {
                    id: true,
                    name: true,
                    category: true,
                    color: true,
                  },
                },
                project: {
                  select: { id: true, key: true, name: true, color: true },
                },
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
      const agentById = new Map(agentsById.map((a) => [a.id, a]));

      return {
        events: page.map((e) => {
          const payload = (e.payload ?? {}) as Record<string, unknown>;
          const pAgentId =
            typeof payload.agentId === "string"
              ? (payload.agentId as string)
              : null;
          const subjectIssue =
            e.subjectType === "issue"
              ? (issueById.get(e.subjectId) ?? null)
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
});

/**
 * Local copy of `issue.ts::findBlockedIssueIds` so the agent router stays
 * import-independent of the issue router. The relation graph rules:
 *   BLOCKS     : from = blocker, to = blocked
 *   BLOCKED_BY : from = blocked, to = blocker
 * An issue is blocked iff at least one blocker is still open (status
 * category not DONE/CANCELED).
 */
async function findBlockedIssueIdsForWorkspace(
  db: typeof PrismaDb,
  workspaceId: string,
): Promise<Set<string>> {
  const blockers = await db.issueRelation.findMany({
    where: {
      workspaceId,
      OR: [
        {
          kind: RelationKind.BLOCKS,
          fromIssue: {
            status: { category: { notIn: ["DONE", "CANCELED"] } },
            deletedAt: null,
          },
        },
        {
          kind: RelationKind.BLOCKED_BY,
          toIssue: {
            status: { category: { notIn: ["DONE", "CANCELED"] } },
            deletedAt: null,
          },
        },
      ],
    },
    select: { fromIssueId: true, toIssueId: true, kind: true },
  });
  const ids = new Set<string>();
  for (const r of blockers) {
    if (r.kind === RelationKind.BLOCKS) ids.add(r.toIssueId);
    if (r.kind === RelationKind.BLOCKED_BY) ids.add(r.fromIssueId);
  }
  return ids;
}
