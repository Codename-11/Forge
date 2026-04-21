import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { AgentStatus, EventKind } from "@prisma/client";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";

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
});
