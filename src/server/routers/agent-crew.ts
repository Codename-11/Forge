import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  EventKind,
  ExecutionStepStatus,
  GoalStatus,
  ReviewGateStatus,
} from "@prisma/client";
import { router, adminProcedure, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { agentIdSchema } from "@/server/validators";
import {
  AGENT_CREW_ROLES,
  addCrewMember,
  createAgentCrew,
  openReviewGate,
  resolveReviewGate,
  setCrewMemberRole,
  updateAgentCrew,
  type AgentCrewRole,
} from "@/server/services/agent-crew-service";

/** Step statuses that mean a crew member has queued or active work. */
const ACTIVE_STEP_STATUSES: ExecutionStepStatus[] = [
  ExecutionStepStatus.READY,
  ExecutionStepStatus.RUNNING,
  ExecutionStepStatus.REVIEW,
];

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

  /**
   * Full crew detail for the crew page: head metadata, every member with
   * agent identity + presence, and — for each member — the execution
   * steps they're actively running right now (RUNNING / REVIEW) so the
   * roster can show "who's busy with what".
   */
  detail: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const crew = await ctx.db.agentCrew.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          _count: { select: { members: true, executionPlans: true, goals: true } },
          members: {
            orderBy: [{ position: "asc" }, { createdAt: "asc" }],
            include: {
              agent: {
                select: {
                  id: true,
                  name: true,
                  profileKey: true,
                  avatar: true,
                  status: true,
                  lastHeartbeatAt: true,
                },
              },
            },
          },
        },
      });
      if (!crew) throw new TRPCError({ code: "NOT_FOUND", message: "Crew not found." });

      // Active step assignments for every distinct agent on the roster, in
      // one query — avoids an N+1 across members. We only pull plans that
      // belong to this crew (the loop dispatches a crew's steps from its
      // own plans), so "current activity" is scoped to this crew's work.
      const agentIds = Array.from(
        new Set(crew.members.map((m) => m.agentId)),
      );
      const activeSteps = agentIds.length
        ? await ctx.db.executionStep.findMany({
            where: {
              workspaceId: ctx.workspaceId,
              assignedAgentId: { in: agentIds },
              status: { in: ACTIVE_STEP_STATUSES },
              plan: { crewId: crew.id },
            },
            orderBy: { updatedAt: "desc" },
            select: {
              id: true,
              title: true,
              status: true,
              assignedAgentId: true,
              updatedAt: true,
              plan: {
                select: { id: true, title: true, goalId: true },
              },
            },
          })
        : [];

      const activeByAgent = new Map<string, typeof activeSteps>();
      for (const step of activeSteps) {
        if (!step.assignedAgentId) continue;
        const list = activeByAgent.get(step.assignedAgentId) ?? [];
        list.push(step);
        activeByAgent.set(step.assignedAgentId, list);
      }

      return {
        ...crew,
        members: crew.members.map((m) => ({
          ...m,
          activeSteps: activeByAgent.get(m.agentId) ?? [],
        })),
      };
    }),

  /**
   * Aggregate crew stats for the detail header. Computed server-side from
   * the goals + plans this crew owns. Cheap: a couple of grouped counts
   * and aggregates, no per-row N+1.
   */
  stats: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const crew = await ctx.db.agentCrew.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!crew) throw new TRPCError({ code: "NOT_FOUND", message: "Crew not found." });

      // Goals owned directly by the crew OR via one of its plans.
      const goals = await ctx.db.goal.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          OR: [{ crewId: crew.id }, { plans: { some: { crewId: crew.id } } }],
        },
        select: { id: true, status: true, totalCostUsd: true },
      });
      const totalGoals = goals.length;
      const achieved = goals.filter((g) => g.status === GoalStatus.ACHIEVED).length;
      const totalCost = goals.reduce((sum, g) => sum + (g.totalCostUsd ?? 0), 0);

      // Avg steps per plan across this crew's plans.
      const planAgg = await ctx.db.executionPlan.aggregate({
        where: { workspaceId: ctx.workspaceId, crewId: crew.id },
        _count: { _all: true },
      });
      const planCount = planAgg._count._all;
      const stepCount = planCount
        ? await ctx.db.executionStep.count({
            where: { workspaceId: ctx.workspaceId, plan: { crewId: crew.id } },
          })
        : 0;

      return {
        totalGoals,
        achievedGoals: achieved,
        successRate: totalGoals > 0 ? achieved / totalGoals : null,
        avgCostPerGoal: totalGoals > 0 ? totalCost / totalGoals : null,
        totalCostUsd: totalCost,
        planCount,
        avgStepsPerPlan: planCount > 0 ? stepCount / planCount : null,
      };
    }),

  /**
   * Goals this crew has run (or is running), newest first. A goal counts
   * if it points at the crew directly (`Goal.crewId`) or via one of its
   * execution plans (`ExecutionPlan.crewId`).
   */
  goalHistory: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        limit: z.number().int().positive().max(100).default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const crew = await ctx.db.agentCrew.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!crew) throw new TRPCError({ code: "NOT_FOUND", message: "Crew not found." });

      const items = await ctx.db.goal.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          OR: [{ crewId: crew.id }, { plans: { some: { crewId: crew.id } } }],
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          title: true,
          status: true,
          totalCostUsd: true,
          maxTotalCostUsd: true,
          startedAt: true,
          achievedAt: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { plans: true } },
        },
      });
      return { items };
    }),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(2_000).nullable().optional(),
        maxParallel: z.number().int().min(0).max(20).optional(),
        members: z
          .array(
            z.object({
              agentId: agentIdSchema,
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

  update: adminProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2_000).nullable().optional(),
        maxParallel: z.number().int().min(0).max(20).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await updateAgentCrew(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        crewId: input.id,
        name: input.name,
        description: input.description,
        maxParallel: input.maxParallel,
      });
      return { ok: true };
    }),

  setMemberRole: adminProcedure
    .input(z.object({ memberId: z.string().cuid(), role: roleSchema }))
    .mutation(async ({ ctx, input }) => {
      return setCrewMemberRole(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        memberId: input.memberId,
        role: input.role as AgentCrewRole,
      });
    }),

  archive: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const crew = await ctx.db.agentCrew.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!crew) throw new TRPCError({ code: "NOT_FOUND", message: "Crew not found." });
      await ctx.db.$transaction(async (tx) => {
        await tx.agentCrew.update({
          where: { id: input.id },
          data: { archivedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "agent-crew",
          entityId: input.id,
          action: "archived",
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "agent-crew",
          subjectId: input.id,
        });
      });
      return { ok: true };
    }),

  addMember: adminProcedure
    .input(
      z.object({
        crewId: z.string().cuid(),
        agentId: agentIdSchema,
        role: roleSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await addCrewMember(ctx.db, {
        workspaceId: ctx.workspaceId,
        crewId: input.crewId,
        agentId: input.agentId,
        role: input.role as AgentCrewRole,
        actorId: ctx.session?.user?.id ?? null,
      });
      return result;
    }),

  removeMember: adminProcedure
    .input(z.object({ memberId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const member = await ctx.db.agentCrewMember.findFirst({
        where: { id: input.memberId, workspaceId: ctx.workspaceId },
        select: { id: true, crewId: true, agentId: true, role: true },
      });
      if (!member) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Crew member not found." });
      }
      await ctx.db.$transaction(async (tx) => {
        await tx.agentCrewMember.delete({ where: { id: input.memberId } });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "agent-crew",
          entityId: member.crewId,
          action: "member_removed",
          before: { agentId: member.agentId, role: member.role },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "agent-crew",
          subjectId: member.crewId,
        });
      });
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
      // Resolve a human-readable label per target so the Review page shows
      // *what* is being gated (issue key + title / plan / goal) rather than a
      // raw cuid. Batched per type to avoid N+1.
      const idsByType = (type: string) =>
        rows.filter((r) => r.targetType === type).map((r) => r.targetId);
      const [issues, plans, goals] = await Promise.all([
        idsByType("issue").length
          ? ctx.db.issue.findMany({
              where: { id: { in: idsByType("issue") }, workspaceId: ctx.workspaceId },
              select: { id: true, number: true, title: true },
            })
          : Promise.resolve([]),
        idsByType("execution-plan").length
          ? ctx.db.executionPlan.findMany({
              where: { id: { in: idsByType("execution-plan") }, workspaceId: ctx.workspaceId },
              select: { id: true, title: true },
            })
          : Promise.resolve([]),
        idsByType("goal").length
          ? ctx.db.goal.findMany({
              where: { id: { in: idsByType("goal") }, workspaceId: ctx.workspaceId },
              select: { id: true, title: true },
            })
          : Promise.resolve([]),
      ]);
      const issueMap = new Map(issues.map((i) => [i.id, i]));
      const planMap = new Map(plans.map((p) => [p.id, p.title]));
      const goalMap = new Map(goals.map((g) => [g.id, g.title]));
      const items = rows.map((r) => {
        const issue = r.targetType === "issue" ? issueMap.get(r.targetId) : undefined;
        const targetLabel =
          issue?.title ??
          (r.targetType === "execution-plan"
            ? planMap.get(r.targetId)
            : r.targetType === "goal"
              ? goalMap.get(r.targetId)
              : undefined) ??
          null;
        return {
          ...r,
          targetLabel,
          targetNumber: issue?.number ?? null,
        };
      });
      return { items };
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

  resolve: adminProcedure
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
