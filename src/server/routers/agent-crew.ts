import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { ReviewGateStatus } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import {
  AGENT_CREW_ROLES,
  addCrewMember,
  createAgentCrew,
  openReviewGate,
  resolveReviewGate,
  type AgentCrewRole,
} from "@/server/services/agent-crew-service";

const roleSchema = z.enum(AGENT_CREW_ROLES);

export const agentCrewRouter = router({
  list: workspaceProcedure
    .input(
      z
        .object({
          includeArchived: z.boolean().default(false),
          limit: z.number().int().positive().max(100).default(50),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.agentCrew.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: input.includeArchived ? undefined : null,
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit,
        include: {
          _count: { select: { members: true, executionPlans: true } },
          members: {
            include: {
              agent: { select: { id: true, name: true, profileKey: true, avatar: true } },
            },
          },
        },
      });
      return { items: rows };
    }),

  get: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.agentCrew.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          members: {
            orderBy: { position: "asc" },
            include: { agent: true },
          },
        },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Crew not found." });
      return row;
    }),

  create: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(2_000).nullable().optional(),
        maxParallel: z.number().int().min(0).max(20).optional(),
        members: z
          .array(
            z.object({
              agentId: z.string().cuid(),
              role: roleSchema,
            }),
          )
          .max(20)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await createAgentCrew(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        name: input.name,
        description: input.description ?? null,
        maxParallel: input.maxParallel,
        members: input.members?.map((m) => ({
          agentId: m.agentId,
          role: m.role as AgentCrewRole,
        })),
      });
      return result;
    }),

  archive: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const crew = await ctx.db.agentCrew.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!crew) throw new TRPCError({ code: "NOT_FOUND", message: "Crew not found." });
      await ctx.db.agentCrew.update({
        where: { id: input.id },
        data: { archivedAt: new Date() },
      });
      return { ok: true };
    }),

  addMember: workspaceProcedure
    .input(
      z.object({
        crewId: z.string().cuid(),
        agentId: z.string().cuid(),
        role: roleSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await addCrewMember(ctx.db, {
        workspaceId: ctx.workspaceId,
        crewId: input.crewId,
        agentId: input.agentId,
        role: input.role as AgentCrewRole,
      });
      return result;
    }),

  removeMember: workspaceProcedure
    .input(z.object({ memberId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const member = await ctx.db.agentCrewMember.findFirst({
        where: { id: input.memberId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!member) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Crew member not found." });
      }
      await ctx.db.agentCrewMember.delete({ where: { id: input.memberId } });
      return { ok: true };
    }),
});

export const reviewGateRouter = router({
  list: workspaceProcedure
    .input(
      z
        .object({
          status: z.nativeEnum(ReviewGateStatus).optional(),
          targetType: z.string().min(1).max(40).optional(),
          limit: z.number().int().positive().max(100).default(50),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.reviewGate.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          status: input.status,
          targetType: input.targetType,
        },
        orderBy: { createdAt: "desc" },
        take: input.limit,
      });
      return { items: rows };
    }),

  get: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.reviewGate.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Review gate not found." });
      return row;
    }),

  open: workspaceProcedure
    .input(
      z.object({
        targetType: z.string().min(1).max(40),
        targetId: z.string().min(1).max(40),
        prompt: z.string().min(1).max(10_000),
        requiredRole: z.string().max(40).nullable().optional(),
        crewId: z.string().cuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await openReviewGate(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        targetType: input.targetType,
        targetId: input.targetId,
        prompt: input.prompt,
        requiredRole: input.requiredRole ?? null,
        crewId: input.crewId ?? null,
      });
      return result;
    }),

  resolve: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        decision: z.enum(["APPROVED", "REJECTED", "CANCELED"]),
        resolution: z.string().max(10_000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await resolveReviewGate(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        gateId: input.id,
        decision: input.decision,
        resolution: input.resolution ?? null,
      });
      return { ok: true };
    }),
});
