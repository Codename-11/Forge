import { z } from "zod";
import { GoalStatus, type PrismaClient, type Role } from "@prisma/client";
import { TRPCError } from "@trpc/server";
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
import {
  buildExecutionPlanAccessWhere,
  buildIssueAccessWhere,
  type ProjectAction,
} from "@/server/services/authorization";

type GoalAuthContext = {
  db: PrismaClient;
  workspaceId: string;
  membership: { id: string; role: Role };
};

async function assertGoalAccess(ctx: GoalAuthContext, id: string, action: ProjectAction) {
  const issue = buildIssueAccessWhere({
    workspaceId: ctx.workspaceId,
    membershipId: ctx.membership.id,
    membershipRole: ctx.membership.role,
    action,
  });
  const found = await ctx.db.goal.findFirst({
    where: {
      id,
      workspaceId: ctx.workspaceId,
      OR: [{ issueId: null }, { issue: { is: issue } }],
    },
    select: { id: true },
  });
  if (!found) {
    throw new TRPCError({
      code: action === "READ" ? "NOT_FOUND" : "FORBIDDEN",
      message: action === "READ" ? "Goal not found." : "Goal access required.",
    });
  }
}

async function assertPlanAccess(ctx: GoalAuthContext, id: string, action: ProjectAction) {
  const found = await ctx.db.executionPlan.findFirst({
    where: {
      id,
      ...buildExecutionPlanAccessWhere({
        workspaceId: ctx.workspaceId,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        action,
      }),
    },
    select: { id: true },
  });
  if (!found) {
    throw new TRPCError({
      code: action === "READ" ? "NOT_FOUND" : "FORBIDDEN",
      message: action === "READ" ? "Execution plan not found." : "Plan access required.",
    });
  }
}

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
      const accessible = await ctx.db.goal.findMany({
        where: {
          id: { in: items.map((item) => item.id) },
          workspaceId: ctx.workspaceId,
          OR: [
            { issueId: null },
            {
              issue: {
                is: buildIssueAccessWhere({
                  workspaceId: ctx.workspaceId,
                  membershipId: ctx.membership.id,
                  membershipRole: ctx.membership.role,
                  action: "READ",
                }),
              },
            },
          ],
        },
        select: { id: true },
      });
      const allowed = new Set(accessible.map((row) => row.id));
      return { items: items.filter((item) => allowed.has(item.id)) };
    }),

  get: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertGoalAccess(ctx, input.id, "READ");
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
      if (input.issueId) {
        const issue = await ctx.db.issue.findFirst({
          where: {
            id: input.issueId,
            ...buildIssueAccessWhere({
              workspaceId: ctx.workspaceId,
              membershipId: ctx.membership.id,
              membershipRole: ctx.membership.role,
              action: "CONTRIBUTE",
            }),
          },
          select: { id: true },
        });
        if (!issue) throw new TRPCError({ code: "FORBIDDEN", message: "Issue access required." });
      }
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
      await assertGoalAccess(ctx, input.id, "CONTRIBUTE");
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
      await assertGoalAccess(ctx, input.id, "CONTRIBUTE");
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
      await assertGoalAccess(ctx, input.id, "CONTRIBUTE");
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
      await assertGoalAccess(ctx, input.id, "CONTRIBUTE");
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
      await assertGoalAccess(ctx, input.goalId, "CONTRIBUTE");
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
      await assertGoalAccess(ctx, input.goalId, "CONTRIBUTE");
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
      await Promise.all([
        assertGoalAccess(ctx, input.goalId, "CONTRIBUTE"),
        assertPlanAccess(ctx, input.planId, "CONTRIBUTE"),
      ]);
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
      await assertPlanAccess(ctx, input.planId, "CONTRIBUTE");
      return requestPlanApproval(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        planId: input.planId,
        assignedUserId: input.assignedUserId ?? null,
      });
    }),
});
