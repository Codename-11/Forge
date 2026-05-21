import { z } from "zod";
import { GoalStatus } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import {
  abandonGoal,
  createGoal,
  decomposeGoal,
  getGoal,
  listGoals,
  requestPlanApproval,
} from "@/server/services/orchestration-service";

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
          includeArchived: z.boolean().default(false),
          limit: z.number().int().positive().max(100).default(50),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const items = await listGoals(ctx.db, {
        workspaceId: ctx.workspaceId,
        status: input.status,
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
        issueId: z.string().cuid().nullable().optional(),
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
        issueId: input.issueId ?? null,
        crewId: input.crewId ?? null,
        maxTotalCostUsd: input.maxTotalCostUsd ?? null,
        maxWallTimeMinutes: input.maxWallTimeMinutes ?? null,
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
        plannerAgentId: z.string().cuid().nullable().optional(),
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
