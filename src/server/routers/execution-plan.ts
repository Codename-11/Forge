import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { ExecutionPlanStatus, ExecutionStepStatus } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import {
  addExecutionStep,
  createExecutionPlan,
  updateExecutionPlan,
  updateExecutionStep,
} from "@/server/services/execution-plan-service";

const verificationSchema = z
  .array(
    z.object({
      id: z.string().min(1).optional(),
      label: z.string().min(1).max(500),
      kind: z.enum(["manual", "command", "artifact"]).optional(),
      value: z.string().max(2_000).optional(),
      done: z.boolean().optional(),
    }),
  )
  .max(50);

const stepInputSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(50_000).nullable().optional(),
  assignedAgentId: z.string().cuid().nullable().optional(),
  assignedUserId: z.string().cuid().nullable().optional(),
  expectedOutput: z.string().max(50_000).nullable().optional(),
  verification: verificationSchema.nullable().optional(),
  dependsOnStepIds: z.array(z.string()).max(50).optional(),
});

export const executionPlanRouter = router({
  list: workspaceProcedure
    .input(
      z
        .object({
          status: z.nativeEnum(ExecutionPlanStatus).optional(),
          issueId: z.string().cuid().optional(),
          projectId: z.string().cuid().optional(),
          includeArchived: z.boolean().default(false),
          limit: z.number().int().positive().max(100).default(50),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.executionPlan.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          status: input.status,
          issueId: input.issueId,
          projectId: input.projectId,
          archivedAt: input.includeArchived ? undefined : null,
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit,
        include: { _count: { select: { steps: true } } },
      });
      return { items: rows };
    }),

  get: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const plan = await ctx.db.executionPlan.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          steps: {
            orderBy: { position: "asc" },
          },
          contextSet: { select: { id: true, name: true } },
          issue: { select: { id: true, number: true, title: true } },
          project: { select: { id: true, key: true, name: true } },
          createdBy: { select: { id: true, name: true, image: true } },
          createdByAgent: { select: { id: true, profileKey: true, name: true } },
        },
      });
      if (!plan) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Execution plan not found." });
      }
      return plan;
    }),

  create: workspaceProcedure
    .input(
      z.object({
        title: z.string().min(1).max(300),
        description: z.string().max(50_000).nullable().optional(),
        issueId: z.string().cuid().nullable().optional(),
        projectId: z.string().cuid().nullable().optional(),
        contextSetId: z.string().cuid().nullable().optional(),
        status: z.nativeEnum(ExecutionPlanStatus).optional(),
        steps: z.array(stepInputSchema).max(50).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await createExecutionPlan(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        title: input.title,
        description: input.description ?? null,
        issueId: input.issueId ?? null,
        projectId: input.projectId ?? null,
        contextSetId: input.contextSetId ?? null,
        status: input.status,
        steps: input.steps?.map((s) => ({
          title: s.title,
          body: s.body ?? null,
          assignedAgentId: s.assignedAgentId ?? null,
          assignedUserId: s.assignedUserId ?? null,
          expectedOutput: s.expectedOutput ?? null,
          verification: s.verification ?? null,
          dependsOnStepIds: s.dependsOnStepIds ?? [],
        })),
      });
      return result;
    }),

  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(50_000).nullable().optional(),
        status: z.nativeEnum(ExecutionPlanStatus).optional(),
        contextSetId: z.string().cuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await updateExecutionPlan(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        planId: input.id,
        title: input.title,
        description: input.description === undefined ? undefined : input.description,
        status: input.status,
        contextSetId: input.contextSetId === undefined ? undefined : input.contextSetId,
      });
      return { ok: true };
    }),

  archive: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const plan = await ctx.db.executionPlan.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!plan) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Execution plan not found." });
      }
      await ctx.db.executionPlan.update({
        where: { id: input.id },
        data: { archivedAt: new Date() },
      });
      return { ok: true };
    }),

  addStep: workspaceProcedure
    .input(
      z.object({
        planId: z.string().cuid(),
        title: z.string().min(1).max(300),
        body: z.string().max(50_000).nullable().optional(),
        assignedAgentId: z.string().cuid().nullable().optional(),
        assignedUserId: z.string().cuid().nullable().optional(),
        expectedOutput: z.string().max(50_000).nullable().optional(),
        verification: verificationSchema.nullable().optional(),
        dependsOnStepIds: z.array(z.string()).max(50).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await addExecutionStep(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        planId: input.planId,
        title: input.title,
        body: input.body ?? null,
        assignedAgentId: input.assignedAgentId ?? null,
        assignedUserId: input.assignedUserId ?? null,
        expectedOutput: input.expectedOutput ?? null,
        verification: input.verification ?? null,
        dependsOnStepIds: input.dependsOnStepIds ?? [],
      });
      return result;
    }),

  updateStep: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        title: z.string().min(1).max(300).optional(),
        body: z.string().max(50_000).nullable().optional(),
        status: z.nativeEnum(ExecutionStepStatus).optional(),
        assignedAgentId: z.string().cuid().nullable().optional(),
        assignedUserId: z.string().cuid().nullable().optional(),
        expectedOutput: z.string().max(50_000).nullable().optional(),
        verification: verificationSchema.nullable().optional(),
        sourceRunId: z.string().cuid().nullable().optional(),
        dependsOnStepIds: z.array(z.string()).max(50).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await updateExecutionStep(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        stepId: input.id,
        title: input.title,
        body: input.body === undefined ? undefined : input.body,
        status: input.status,
        assignedAgentId:
          input.assignedAgentId === undefined ? undefined : input.assignedAgentId,
        assignedUserId:
          input.assignedUserId === undefined ? undefined : input.assignedUserId,
        expectedOutput:
          input.expectedOutput === undefined ? undefined : input.expectedOutput,
        verification: input.verification ?? undefined,
        sourceRunId: input.sourceRunId === undefined ? undefined : input.sourceRunId,
        dependsOnStepIds: input.dependsOnStepIds,
      });
      return { ok: true };
    }),

  removeStep: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const step = await ctx.db.executionStep.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, planId: true },
      });
      if (!step) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Execution step not found." });
      }
      await ctx.db.executionStep.delete({ where: { id: input.id } });
      await ctx.db.executionPlan.update({
        where: { id: step.planId },
        data: { updatedAt: new Date() },
      });
      return { ok: true };
    }),
});
