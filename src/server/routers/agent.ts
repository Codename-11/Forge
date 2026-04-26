import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  AgentStatus,
  EventKind,
  RelationKind,
  type Prisma,
} from "@prisma/client";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";
import { recordChange, agentDispatchUrlFor } from "@/server/audit";
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

/**
 * Agent ids are *not* always cuids — some agents were seeded with
 * non-cuid handles (hex strings) and have to keep them. Use this
 * permissive schema instead of `z.string().cuid()` anywhere an agent
 * id arrives over the wire.
 */
const agentId = z.string().min(1).max(40).regex(/^[a-zA-Z0-9_-]+$/);

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
    .input(z.object({ id: agentId }))
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
        id: agentId,
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
    .input(z.object({ id: agentId }))
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
    .input(z.object({ id: agentId }))
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
    .input(z.object({ id: agentId }))
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
        id: agentId,
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
          agentId: agentId.optional(),
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
        EventKind.ISSUE_STALLED,
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

  /**
   * Windowed status math from `AGENT_STATUS_CHANGED` events.
   *
   * Returns total time spent in ONLINE / BUSY / OFFLINE plus an uptime
   * percentage (online + busy / total) and the raw transition list for
   * the status ribbon.
   *
   * Heuristic: when the window has no transitions, attribute the entire
   * window to the agent's current status. The first transition inside
   * the window starts a fresh segment; everything before it is bucketed
   * by the *last status the agent held before the window opened* (we
   * read the most recent transition before `windowStart`; if none, the
   * agent has only ever been at its current status, so we extrapolate).
   */
  uptime: workspaceProcedure
    .input(
      z.object({
        id: agentId,
        windowDays: z.number().int().min(1).max(90).default(7),
        transitionLimit: z.number().int().min(1).max(500).default(200),
      }),
    )
    .query(async ({ ctx, input }) => {
      const agent = await ctx.db.agent.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, status: true, lastHeartbeatAt: true },
      });

      const now = new Date();
      const windowStart = new Date(
        now.getTime() - input.windowDays * 86_400_000,
      );

      const eventsAfter = await ctx.db.activityEvent.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          kind: EventKind.AGENT_STATUS_CHANGED,
          subjectType: "agent",
          subjectId: input.id,
          createdAt: { gte: windowStart },
        },
        orderBy: { createdAt: "asc" },
        take: input.transitionLimit,
      });

      const lastBefore = await ctx.db.activityEvent.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          kind: EventKind.AGENT_STATUS_CHANGED,
          subjectType: "agent",
          subjectId: input.id,
          createdAt: { lt: windowStart },
        },
        orderBy: { createdAt: "desc" },
      });

      const buckets: Record<AgentStatus, number> = {
        ONLINE: 0,
        BUSY: 0,
        OFFLINE: 0,
      };

      const readStatus = (e: { payload: unknown }): AgentStatus | null => {
        const p = (e.payload ?? {}) as Record<string, unknown>;
        const s = p.status ?? p.to;
        if (s === "ONLINE" || s === "BUSY" || s === "OFFLINE") return s;
        return null;
      };

      // Status the agent held at windowStart. If no prior transition
      // exists, fall back to the agent's current status — the truth is
      // that we don't know, but the current value is the best guess.
      let cursorStatus: AgentStatus =
        (lastBefore && readStatus(lastBefore)) ??
        (eventsAfter[0] && readStatus(eventsAfter[0])) ??
        agent.status;
      let cursorAt = windowStart;

      for (const e of eventsAfter) {
        const next = readStatus(e);
        if (!next) continue;
        const segment = e.createdAt.getTime() - cursorAt.getTime();
        if (segment > 0) buckets[cursorStatus] += segment;
        cursorStatus = next;
        cursorAt = e.createdAt;
      }

      const tail = now.getTime() - cursorAt.getTime();
      if (tail > 0) buckets[cursorStatus] += tail;

      const totalMs =
        buckets.ONLINE + buckets.BUSY + buckets.OFFLINE || 1;
      const uptimePct = Math.round(
        ((buckets.ONLINE + buckets.BUSY) / totalMs) * 1000,
      ) / 10;

      // currentSinceIso = createdAt of the most-recent transition; falls
      // back to lastHeartbeatAt, then windowStart.
      const currentSince =
        eventsAfter.length > 0
          ? eventsAfter[eventsAfter.length - 1].createdAt
          : (lastBefore?.createdAt ?? agent.lastHeartbeatAt ?? windowStart);

      return {
        agentId: agent.id,
        windowDays: input.windowDays,
        windowStart: windowStart.toISOString(),
        windowEnd: now.toISOString(),
        totalMs,
        onlineMs: buckets.ONLINE,
        busyMs: buckets.BUSY,
        offlineMs: buckets.OFFLINE,
        uptimePct,
        currentStatus: agent.status,
        currentSince: currentSince.toISOString(),
        transitions: eventsAfter.map((e) => ({
          id: e.id,
          at: e.createdAt.toISOString(),
          status: readStatus(e),
          payload: e.payload,
        })),
      };
    }),

  /**
   * Webhook delivery health for an agent's synthetic dispatch shims —
   * `agent:dispatch:{agentId}` (per-agent, used for mentions / priority
   * bumps) and the workspace-shared `agent:dispatch`.
   *
   * Counts within the window plus the most recent N rows so the UI can
   * show a sparkline + "what just failed" list. The agent's configured
   * real `webhookUrl` is returned alongside so operators can verify
   * what URL Forge would deliver to.
   */
  webhookHealth: workspaceProcedure
    .input(
      z.object({
        id: agentId,
        windowDays: z.number().int().min(1).max(90).default(7),
        recentLimit: z.number().int().min(1).max(50).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const agent = await ctx.db.agent.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, webhookUrl: true },
      });

      const since = new Date(
        Date.now() - input.windowDays * 86_400_000,
      );

      const perAgentUrl = agentDispatchUrlFor(agent.id);

      // Hooks that route to this agent: the per-agent shim AND the
      // workspace-wide generic shim (the worker resolves the latter to
      // the issue's assignee at delivery time, but for health rollups
      // we count both with a clear label).
      const hooks = await ctx.db.webhook.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          OR: [{ url: perAgentUrl }, { url: "agent:dispatch" }],
        },
        select: { id: true, url: true },
      });

      if (hooks.length === 0) {
        return {
          agentId: agent.id,
          configuredWebhookUrl: agent.webhookUrl,
          windowDays: input.windowDays,
          totals: { pending: 0, success: 0, failed: 0, deadLetter: 0 },
          perHook: [],
          recent: [],
        };
      }

      const hookIds = hooks.map((h) => h.id);

      const counts = await ctx.db.webhookDelivery.groupBy({
        by: ["webhookId", "status"],
        where: {
          webhookId: { in: hookIds },
          scheduledAt: { gte: since },
        },
        _count: { _all: true },
      });

      const perHookMap = new Map<
        string,
        { pending: number; success: number; failed: number; deadLetter: number }
      >();
      for (const h of hooks) {
        perHookMap.set(h.id, {
          pending: 0,
          success: 0,
          failed: 0,
          deadLetter: 0,
        });
      }
      for (const r of counts) {
        const row = perHookMap.get(r.webhookId);
        if (!row) continue;
        if (r.status === "PENDING") row.pending = r._count._all;
        else if (r.status === "SUCCESS") row.success = r._count._all;
        else if (r.status === "FAILED") row.failed = r._count._all;
        else if (r.status === "DEAD_LETTER") row.deadLetter = r._count._all;
      }

      const totals = { pending: 0, success: 0, failed: 0, deadLetter: 0 };
      for (const v of perHookMap.values()) {
        totals.pending += v.pending;
        totals.success += v.success;
        totals.failed += v.failed;
        totals.deadLetter += v.deadLetter;
      }

      const recent = await ctx.db.webhookDelivery.findMany({
        where: {
          webhookId: { in: hookIds },
          scheduledAt: { gte: since },
        },
        orderBy: { scheduledAt: "desc" },
        take: input.recentLimit,
        select: {
          id: true,
          webhookId: true,
          status: true,
          attempt: true,
          scheduledAt: true,
          deliveredAt: true,
          responseStatus: true,
          event: {
            select: {
              id: true,
              kind: true,
              subjectType: true,
              subjectId: true,
              createdAt: true,
            },
          },
        },
      });

      return {
        agentId: agent.id,
        configuredWebhookUrl: agent.webhookUrl,
        windowDays: input.windowDays,
        totals,
        perHook: hooks.map((h) => ({
          webhookId: h.id,
          syntheticUrl: h.url,
          ...(perHookMap.get(h.id) ?? {
            pending: 0,
            success: 0,
            failed: 0,
            deadLetter: 0,
          }),
        })),
        recent,
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
