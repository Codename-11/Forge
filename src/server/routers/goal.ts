import { z } from "zod";
import { GoalStatus } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { agentIdSchema } from "@/server/validators";
import {
  acceptGoalOutcome,
  abandonGoal,
  attachPlanToGoal,
  createGoal,
  decomposeGoal,
  generatePlanForGoal,
  getGoal,
  listGoals,
  requestPlanApproval,
  reopenGoal,
  updateGoal,
} from "@/server/services/orchestration-service";

const outcomeEvidenceSchema = z
  .object({
    kind: z.enum(["PULL_REQUEST", "COMMIT", "DEPLOYMENT", "TEST", "ARTIFACT", "OTHER"]),
    label: z.string().trim().min(1).max(300),
    url: z.string().url().max(2_000).optional(),
    ref: z.string().trim().min(1).max(500).optional(),
  })
  .refine((item) => Boolean(item.url || item.ref), {
    message: "Each evidence item needs a URL or reference.",
  });

/**
 * tRPC mirror of the goals.* MCP surface for the UI. The orchestration
 * loop logic lives in `orchestration-service`; this router is the thin
 * workspace-scoped entry point the Goals tab / DAG view call.
 */
export const goalRouter = router({
  list: workspaceProcedure
    .input(
      z
        .object({
          status: z.nativeEnum(GoalStatus).optional(),
          issueId: z.string().cuid().optional(),
          includeArchived: z.boolean().default(false),
          limit: z.number().int().positive().max(100).default(50),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const items = await listGoals(ctx.db, {
        workspaceId: ctx.workspaceId,
        status: input.status,
        issueId: input.issueId,
        includeArchived: input.includeArchived,
        limit: input.limit,
      });
      return { items };
    }),

  get: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      return getGoal(ctx.db, { workspaceId: ctx.workspaceId, id: input.id });
    }),

  create: workspaceProcedure
    .input(
      z.object({
        title: z.string().min(1).max(300),
        description: z.string().max(50_000).nullable().optional(),
        successCriteria: z.string().max(50_000).nullable().optional(),
        outcomeSummary: z.string().max(50_000).nullable().optional(),
        targetDate: z.coerce.date().nullable().optional(),
        issueId: z.string().cuid().nullable().optional(),
        initiativeId: z.string().cuid().nullable().optional(),
        crewId: z.string().cuid().nullable().optional(),
        maxTotalCostUsd: z.number().nonnegative().nullable().optional(),
        maxWallTimeMinutes: z.number().int().positive().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return createGoal(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        title: input.title,
        description: input.description ?? null,
        successCriteria: input.successCriteria ?? null,
        outcomeSummary: input.outcomeSummary ?? null,
        targetDate: input.targetDate ?? null,
        issueId: input.issueId ?? null,
        initiativeId: input.initiativeId ?? null,
        crewId: input.crewId ?? null,
        maxTotalCostUsd: input.maxTotalCostUsd ?? null,
        maxWallTimeMinutes: input.maxWallTimeMinutes ?? null,
      });
    }),

  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(50_000).nullable().optional(),
        successCriteria: z.string().max(50_000).nullable().optional(),
        outcomeSummary: z.string().max(50_000).nullable().optional(),
        targetDate: z.coerce.date().nullable().optional(),
        initiativeId: z.string().cuid().nullable().optional(),
        crewId: z.string().cuid().nullable().optional(),
        maxTotalCostUsd: z.number().nonnegative().nullable().optional(),
        maxWallTimeMinutes: z.number().int().positive().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return updateGoal(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        id: input.id,
        title: input.title,
        description: input.description === undefined ? undefined : input.description,
        successCriteria: input.successCriteria === undefined ? undefined : input.successCriteria,
        outcomeSummary: input.outcomeSummary === undefined ? undefined : input.outcomeSummary,
        targetDate: input.targetDate === undefined ? undefined : input.targetDate,
        initiativeId: input.initiativeId === undefined ? undefined : input.initiativeId,
        crewId: input.crewId === undefined ? undefined : input.crewId,
        maxTotalCostUsd: input.maxTotalCostUsd === undefined ? undefined : input.maxTotalCostUsd,
        maxWallTimeMinutes:
          input.maxWallTimeMinutes === undefined ? undefined : input.maxWallTimeMinutes,
      });
    }),

  acceptOutcome: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        outcomeSummary: z.string().trim().min(1).max(50_000),
        evidence: z.array(outcomeEvidenceSchema).min(1).max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return acceptGoalOutcome(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        id: input.id,
        outcomeSummary: input.outcomeSummary,
        evidence: input.evidence,
      });
    }),

  reopen: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        reason: z.string().trim().min(1).max(2_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return reopenGoal(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        id: input.id,
        reason: input.reason,
      });
    }),

  abandon: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        reason: z.string().max(2_000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await abandonGoal(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        id: input.id,
        reason: input.reason ?? null,
      });
      return { ok: true };
    }),

  decompose: workspaceProcedure
    .input(
      z.object({
        goalId: z.string().cuid(),
        plannerAgentId: agentIdSchema.nullable().optional(),
        contextSetId: z.string().cuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return decomposeGoal(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        goalId: input.goalId,
        plannerAgentId: input.plannerAgentId ?? null,
        contextSetId: input.contextSetId ?? null,
      });
    }),

  generatePlan: workspaceProcedure
    .input(
      z.object({
        goalId: z.string().cuid(),
        contextSetId: z.string().cuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return generatePlanForGoal(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        goalId: input.goalId,
        contextSetId: input.contextSetId ?? null,
      });
    }),

  attachPlan: workspaceProcedure
    .input(
      z.object({
        goalId: z.string().cuid(),
        planId: z.string().cuid(),
        makeActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return attachPlanToGoal(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        goalId: input.goalId,
        planId: input.planId,
        makeActive: input.makeActive,
      });
    }),

  requestApproval: workspaceProcedure
    .input(
      z.object({
        planId: z.string().cuid(),
        assignedUserId: z.string().cuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return requestPlanApproval(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        planId: input.planId,
        assignedUserId: input.assignedUserId ?? null,
      });
    }),
});
