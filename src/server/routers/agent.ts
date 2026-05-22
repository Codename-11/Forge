import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  AgentProvider,
  AgentRunStatus,
  AgentRuntimeMode,
  AgentStatus,
  EventKind,
  RelationKind,
  RunEngine,
  type Prisma,
} from "@prisma/client";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";
import { recordChange, agentDispatchUrlFor } from "@/server/audit";
import type { db as PrismaDb } from "@/server/db";
import { deliverWebhook } from "@/server/services/plugin-runtime";
import { STALE_RUN_MS } from "@/server/services/agent-presence";
import { agentIdSchema } from "@/server/validators";

/**
 * Agent registry. Agents are MCP-first actors — LLM profiles that hold
 * ApiKeys, receive push dispatches, and can be assigned issues directly.
 *
 * `profileKey` is the stable cross-system handle (e.g. `victor`, `mizu`).
 * For Hermes it usually matches the profile directory; for Claude, Codex, and
 * custom clients it is the Forge-side identity attached to linked MCP keys.
 */

const profileKey = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "Lowercase, digits, `-` or `_` only");

/**
 * Agent ids are *not* always cuids — some agents were seeded with
 * non-cuid handles (hex strings) and have to keep them. Re-exported from
 * the leaf `validators` module so services can share it without pulling
 * in this whole router.
 */
export const agentId = agentIdSchema;

const upsertInput = z.object({
  name: z.string().min(1).max(120),
  profileKey,
  description: z.string().max(2000).optional(),
  avatar: z.string().max(200).optional(),
  provider: z.nativeEnum(AgentProvider).default(AgentProvider.HERMES),
  runtimeMode: z
    .nativeEnum(AgentRuntimeMode)
    .default(AgentRuntimeMode.PERSISTENT),
  webhookUrl: z.string().url().max(500).optional().or(z.literal("")),
  webhookSecret: z.string().max(500).optional().or(z.literal("")),
  capabilities: z.array(z.string().min(1).max(40)).max(32).default([]),
  maxConcurrent: z.number().int().min(0).max(100).default(1),
  /// Freeform markdown applied to the issue description when this agent
  /// is assigned to an issue whose description is empty. No length cap.
  templateMarkdown: z.string().optional(),
});

function redactWebhookSecret<T extends { webhookSecret?: string | null }>(
  value: T,
): T {
  return {
    ...value,
    webhookSecret: value.webhookSecret ? "[redacted]" : value.webhookSecret,
  };
}

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
        include: {
          _count: { select: { assignedIssues: true } },
          runtime: {
            select: { id: true, name: true, kind: true, heartbeatAt: true },
          },
        },
      }),
    ),

  byId: workspaceProcedure
    .input(z.object({ id: agentId }))
    .query(async ({ ctx, input }) => {
      const agent = await ctx.db.agent.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          _count: { select: { assignedIssues: true } },
          runtime: {
            select: { id: true, name: true, kind: true, heartbeatAt: true },
          },
        },
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
        include: {
          runtime: {
            select: {
              id: true,
              name: true,
              kind: true,
              heartbeatAt: true,
              providersAvailable: true,
            },
          },
        },
      }),
    ),

  /**
   * Crews this agent belongs to + what it's actively working on right
   * now — powers the "Crews & live work" section on the agent detail
   * page. Mirrors the per-member computation in `agentCrew.detail`, but
   * scoped to a single agent (and not limited to one crew's plans):
   *
   *   - `crews`: every (non-archived) crew the agent is a member of,
   *     with the membership role.
   *   - `activeSteps`: execution steps assigned to this agent that are
   *     RUNNING or REVIEW, newest first, each with its plan + goalId so
   *     the client can deep-link to the goal (or plan as a fallback).
   *
   * Tenant-scoped on `workspaceId`. Agent ids may be non-cuid hex
   * strings, so the input uses the shared `agentIdSchema`.
   */
  crewsAndWork: workspaceProcedure
    .input(z.object({ id: agentId }))
    .query(async ({ ctx, input }) => {
      const agent = await ctx.db.agent.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND" });

      const [memberships, activeSteps] = await Promise.all([
        ctx.db.agentCrewMember.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            agentId: agent.id,
            crew: { archivedAt: null },
          },
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            role: true,
            crew: { select: { id: true, name: true } },
          },
        }),
        ctx.db.executionStep.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            assignedAgentId: agent.id,
            status: { in: ["RUNNING", "REVIEW"] },
          },
          orderBy: { updatedAt: "desc" },
          select: {
            id: true,
            title: true,
            status: true,
            plan: { select: { id: true, title: true, goalId: true } },
          },
        }),
      ]);

      return {
        crews: memberships.map((m) => ({
          crewId: m.crew.id,
          crewName: m.crew.name,
          role: m.role,
        })),
        activeSteps: activeSteps.map((s) => ({
          stepId: s.id,
          title: s.title,
          status: s.status,
          plan: s.plan,
        })),
      };
    }),

  /**
   * Narrow "card-shape" summary used by the `@profileKey` hover preview.
   *
   * Looks up an agent by either `id` or `profileKey` (the chip in
   * markdown carries only the lowercase profileKey; the chip in the
   * agent picker / strip carries the id). At most one of the two is
   * required. Workspace-scoped — cross-tenant resolves return
   * NOT_FOUND so the client renders the "Agent not found" softfail.
   *
   * The select shape is intentionally tight: name, profileKey, avatar,
   * status, last heartbeat, provider, capabilities (full array — the
   * card shows the first three and `+N` overflow). Cacheable per agent;
   * the client sets `staleTime` 60s.
   */
  summary: workspaceProcedure
    .input(
      z
        .object({
          id: agentId.optional(),
          profileKey: profileKey.optional(),
        })
        .refine((v) => v.id || v.profileKey, {
          message: "Provide id or profileKey.",
        }),
    )
    .query(async ({ ctx, input }) => {
      const agent = await ctx.db.agent.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: null,
          ...(input.id ? { id: input.id } : {}),
          ...(input.profileKey ? { profileKey: input.profileKey } : {}),
        },
        select: {
          id: true,
          name: true,
          profileKey: true,
          avatar: true,
          description: true,
          status: true,
          provider: true,
          capabilities: true,
          lastHeartbeatAt: true,
          maxConcurrent: true,
        },
      });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND" });
      return agent;
    }),

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
          provider: input.provider,
          runtimeMode: input.runtimeMode,
          webhookUrl: input.webhookUrl || null,
          webhookSecret: input.webhookSecret || null,
          capabilities: input.capabilities,
          maxConcurrent: input.maxConcurrent,
          templateMarkdown: input.templateMarkdown || null,
        },
      });
      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        entity: "Agent",
        entityId: agent.id,
        action: "create",
        after: redactWebhookSecret(agent),
        eventKind: EventKind.AGENT_CREATED,
        subjectType: "agent",
        subjectId: agent.id,
        payload: {
          name: agent.name,
          profileKey: agent.profileKey,
          provider: agent.provider,
          runtimeMode: agent.runtimeMode,
        },
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
        provider: z.nativeEnum(AgentProvider).optional(),
        runtimeMode: z.nativeEnum(AgentRuntimeMode).optional(),
        /// Chat engine override. Null clears (revert to integration default).
        runEngine: z.nativeEnum(RunEngine).nullable().optional(),
        webhookUrl: z.string().url().max(500).nullable().optional(),
        webhookSecret: z.string().max(500).nullable().optional(),
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
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Agent",
          entityId: id,
          action: "update",
          before: redactWebhookSecret(before),
          after: redactWebhookSecret(after),
          eventKind: EventKind.AGENT_UPDATED,
          subjectType: "agent",
          subjectId: id,
          payload: redactWebhookSecret(patch),
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

  testWebhook: adminProcedure
    .input(
      z.object({
        id: agentId.optional(),
        webhookUrl: z.string().url().max(500).optional().or(z.literal("")),
        webhookSecret: z.string().max(500).optional().or(z.literal("")),
        provider: z.nativeEnum(AgentProvider).optional(),
        runtimeMode: z.nativeEnum(AgentRuntimeMode).optional(),
        profileKey: profileKey.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let agent:
        | {
            id: string;
            name: string;
            profileKey: string;
            webhookUrl: string | null;
            webhookSecret: string | null;
            provider: AgentProvider;
            runtimeMode: AgentRuntimeMode;
          }
        | null = null;

      if (input.id) {
        agent = await ctx.db.agent.findFirstOrThrow({
          where: { id: input.id, workspaceId: ctx.workspaceId },
          select: {
            id: true,
            name: true,
            profileKey: true,
            webhookUrl: true,
            webhookSecret: true,
            provider: true,
            runtimeMode: true,
          },
        });
      }

      const url = input.webhookUrl || agent?.webhookUrl || "";
      if (!url) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Webhook URL is required to run a connection test.",
        });
      }

      const provider = input.provider ?? agent?.provider ?? AgentProvider.CUSTOM;
      const runtimeMode =
        input.runtimeMode ?? agent?.runtimeMode ?? AgentRuntimeMode.EPHEMERAL;
      const res = await deliverWebhook({
        url,
        secret:
          input.webhookSecret || agent?.webhookSecret || "forge_connection_test",
        timeoutMs: 5000,
        body: {
          id: `agent-test-${Date.now()}`,
          kind: "AGENT_CONNECTION_TEST",
          subjectType: "agent",
          subjectId: agent?.id ?? "draft",
          payload: {
            workspaceId: ctx.workspaceId,
            profileKey: input.profileKey ?? agent?.profileKey ?? null,
            provider,
            runtimeMode,
            test: true,
          },
          createdAt: new Date().toISOString(),
        },
      });

      return {
        ok: res.ok,
        status: res.status,
        responseBody: res.responseBody?.slice(0, 2_000) ?? null,
      };
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
        EventKind.AGENT_NOACK,
        EventKind.AGENT_STATUS_CHANGED,
        EventKind.ISSUE_QUEUED,
        EventKind.ISSUE_STATUS_CHANGED,
        EventKind.ISSUE_STALLED,
        EventKind.ISSUE_SLA_BREACH,
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

  /**
   * Cross-source activity timeline for a single agent. Merges:
   *
   *   1. `Comment` rows authored by the agent (`authoringAgentId = agent.id`).
   *   2. `ActivityEvent` rows whose payload.agentId matches the agent OR
   *      whose subject is `agent` / `agent-run` for this agent. There is
   *      no `actorApiKeyId` column on `ActivityEvent`, so the spec
   *      ("originated by an ApiKey with linkedAgentId = agent.id") is
   *      approximated via the `payload.agentId` convention used by every
   *      MCP tool that records an event on an agent's behalf
   *      (comments.create, comments.upsertStatus, agent-run open/event,
   *      chat.appendMessage, etc.). Subsequent streams should keep
   *      stamping `agentId` into payloads — that's the join key.
   *   3. `AgentRunEvent` rows for any AgentRun owned by this agent.
   *
   * Each source is fetched independently with `before` / `limit`, then
   * merged in JS and clipped back to `limit`. Pagination cursor is the
   * timestamp of the last returned row — clients pass it back as
   * `before` to fetch the next page. Equal-timestamp ties favour
   * stability via a secondary id-DESC ordering inside each source.
   */
  unifiedTimeline: workspaceProcedure
    .input(
      z.object({
        profileKey,
        before: z.date().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const agent = await ctx.db.agent.findUnique({
        where: {
          workspaceId_profileKey: {
            workspaceId: ctx.workspaceId,
            profileKey: input.profileKey,
          },
        },
        select: { id: true, profileKey: true, name: true, avatar: true },
      });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND" });

      const beforeFilter = input.before
        ? { lt: input.before }
        : undefined;

      const [comments, events, runEvents] = await Promise.all([
        // (1) Agent-authored comments.
        ctx.db.comment.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            authoringAgentId: agent.id,
            ...(beforeFilter ? { createdAt: beforeFilter } : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: input.limit,
          select: {
            id: true,
            issueId: true,
            body: true,
            kind: true,
            currentStep: true,
            createdAt: true,
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
        // (2) ActivityEvents touching this agent.
        ctx.db.activityEvent.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            ...(beforeFilter ? { createdAt: beforeFilter } : {}),
            OR: [
              { subjectType: "agent", subjectId: agent.id },
              {
                subjectType: "agent-run",
                payload: {
                  path: ["agentId"],
                  equals: agent.id,
                } as Prisma.JsonFilter,
              },
              {
                payload: {
                  path: ["agentId"],
                  equals: agent.id,
                } as Prisma.JsonFilter,
              },
            ],
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: input.limit,
          select: {
            id: true,
            kind: true,
            subjectType: true,
            subjectId: true,
            payload: true,
            createdAt: true,
            actor: { select: { id: true, name: true, image: true } },
          },
        }),
        // (3) AgentRunEvents for any of the agent's runs.
        ctx.db.agentRunEvent.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            run: { agentId: agent.id },
            ...(beforeFilter ? { createdAt: beforeFilter } : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: input.limit,
          select: {
            id: true,
            runId: true,
            kind: true,
            payload: true,
            createdAt: true,
            run: {
              select: {
                id: true,
                issueId: true,
                currentStep: true,
                status: true,
                issue: {
                  select: {
                    id: true,
                    number: true,
                    title: true,
                    workspace: { select: { key: true } },
                  },
                },
              },
            },
          },
        }),
      ]);

      type Row =
        | {
            kind: "comment";
            timestamp: Date;
            payload: (typeof comments)[number];
          }
        | {
            kind: "event";
            timestamp: Date;
            payload: (typeof events)[number];
          }
        | {
            kind: "run-event";
            timestamp: Date;
            payload: (typeof runEvents)[number];
          };

      const merged: Row[] = [
        ...comments.map(
          (c): Row => ({ kind: "comment", timestamp: c.createdAt, payload: c }),
        ),
        ...events.map(
          (e): Row => ({ kind: "event", timestamp: e.createdAt, payload: e }),
        ),
        ...runEvents.map(
          (r): Row => ({
            kind: "run-event",
            timestamp: r.createdAt,
            payload: r,
          }),
        ),
      ].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      const page = merged.slice(0, input.limit);
      const nextBefore =
        page.length === input.limit ? page[page.length - 1].timestamp : null;

      return {
        agent,
        rows: page,
        nextBefore,
      };
    }),

  /**
   * Per-agent stalled visibility — surfaces both flavours of "stalled"
   * for a single agent so the agent detail page can render a dedicated
   * bucket without joining two queries client-side.
   *
   *   - **stalledRuns** — `AgentRun` rows for this agent that are still
   *     ACTIVE but whose `lastEventAt` is older than `STALE_RUN_MS` (5
   *     min). UI signal — the watchdog that *closes* runs uses
   *     `Workspace.agentRunStaleMinutes`, a different knob. Operators
   *     should be able to see (and kick) a run as stalled long before
   *     the watchdog auto-closes it.
   *   - **stalledIssues** — issues currently assigned to this agent
   *     where `updatedAt < (now - workspace.stalledThresholdDays * 24h)`
   *     and the status is in a started category. When
   *     `stalledThresholdDays === 0` the bucket is disabled and an
   *     empty array is returned.
   *
   * Each row carries enough fields for the row renderer (issue key,
   * title, status, project, run id, currentStep, lastEventAt) so the
   * client doesn't need follow-up fetches. Sorted oldest-first within
   * each bucket so the most-stale entries surface to the top.
   */
  stalled: workspaceProcedure
    .input(z.object({ agentId }))
    .query(async ({ ctx, input }) => {
      // Workspace-scope guard: confirm the agent belongs to the
      // calling tenant before returning rows joined off it.
      const agent = await ctx.db.agent.findFirst({
        where: { id: input.agentId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND" });

      const ws = await ctx.db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { stalledThresholdDays: true },
      });

      const now = Date.now();
      const runCutoff = new Date(now - STALE_RUN_MS);

      const stalledRuns = await ctx.db.agentRun.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          agentId: agent.id,
          status: AgentRunStatus.ACTIVE,
          lastEventAt: { lt: runCutoff },
        },
        orderBy: [{ lastEventAt: "asc" }],
        take: 50,
        select: {
          id: true,
          issueId: true,
          currentStep: true,
          startedAt: true,
          lastEventAt: true,
          issue: {
            select: {
              id: true,
              number: true,
              title: true,
              status: {
                select: { id: true, name: true, category: true, color: true },
              },
              project: {
                select: { id: true, key: true, name: true, color: true },
              },
              workspace: { select: { key: true, slug: true } },
            },
          },
        },
      });

      let stalledIssues: Array<{
        id: string;
        number: number;
        title: string;
        updatedAt: Date;
        status: { id: string; name: string; category: string; color: string };
        project: { id: string; key: string; name: string; color: string | null } | null;
        workspace: { key: string; slug: string };
      }> = [];
      if (ws.stalledThresholdDays > 0) {
        const issueCutoff = new Date(
          now - ws.stalledThresholdDays * 24 * 60 * 60 * 1000,
        );
        const snoozeNow = new Date();
        stalledIssues = await ctx.db.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            deletedAt: null,
            assignedAgentId: agent.id,
            updatedAt: { lt: issueCutoff },
            status: { category: { in: ["IN_PROGRESS", "IN_REVIEW"] } },
            OR: [
              { snoozedUntil: null },
              { snoozedUntil: { lte: snoozeNow } },
            ],
          },
          orderBy: [{ updatedAt: "asc" }],
          take: 50,
          select: {
            id: true,
            number: true,
            title: true,
            updatedAt: true,
            status: {
              select: { id: true, name: true, category: true, color: true },
            },
            project: {
              select: { id: true, key: true, name: true, color: true },
            },
            workspace: { select: { key: true, slug: true } },
          },
        });
      }

      return {
        stalledRuns,
        stalledIssues,
        stalledThresholdDays: ws.stalledThresholdDays,
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
