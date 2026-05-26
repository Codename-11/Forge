import "server-only";
import type { PrismaClient } from "@prisma/client";
import { EventKind, ExecutionPlanStatus, GoalStatus, Prisma } from "@prisma/client";
import type { ExecutionStepStatus } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { recordChange } from "@/server/audit";

export interface CreateExecutionPlanInput {
  workspaceId: string;
  actorId: string | null;
  actorAgentId?: string | null;
  title: string;
  description?: string | null;
  issueId?: string | null;
  projectId?: string | null;
  contextSetId?: string | null;
  /**
   * Optional owning Goal. When set, the plan is created as that goal's
   * active attempt (prior attempts are demoted), mirroring `decomposeGoal`
   * — so a hand-authored plan links to its Goal in one call instead of
   * relying on the LLM planner. The goal must be in the same workspace and
   * not ACHIEVED/ABANDONED.
   */
  goalId?: string | null;
  status?: ExecutionPlanStatus;
  steps?: Array<{
    title: string;
    body?: string | null;
    assignedAgentId?: string | null;
    assignedUserId?: string | null;
    expectedOutput?: string | null;
    verification?: Prisma.InputJsonValue | null;
    dependsOnStepIds?: string[];
  }>;
}

/** Create an ExecutionPlan with optional seeded steps. */
export async function createExecutionPlan(
  db: PrismaClient,
  input: CreateExecutionPlanInput,
): Promise<{ id: string }> {
  // Cross-tenant guards on optional refs.
  if (input.issueId) {
    const found = await db.issue.findFirst({
      where: { id: input.issueId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!found) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found in this workspace." });
    }
  }
  if (input.projectId) {
    const found = await db.project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!found) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Project not found in this workspace." });
    }
  }
  if (input.contextSetId) {
    const found = await db.contextSet.findFirst({
      where: { id: input.contextSetId, workspaceId: input.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!found) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Context set not found in this workspace." });
    }
  }
  if (input.goalId) {
    const goal = await db.goal.findFirst({
      where: { id: input.goalId, workspaceId: input.workspaceId },
      select: { id: true, status: true },
    });
    if (!goal) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found in this workspace." });
    }
    if (goal.status === GoalStatus.ACHIEVED || goal.status === GoalStatus.ABANDONED) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Cannot attach a plan to a ${goal.status.toLowerCase()} goal.`,
      });
    }
  }

  const { id } = await db.$transaction(async (tx) => {
    // When linking to a goal, this plan becomes the active attempt — demote
    // any prior active attempt first (mirrors decomposeGoal).
    if (input.goalId) {
      await tx.executionPlan.updateMany({
        where: { goalId: input.goalId, isActiveAttempt: true },
        data: { isActiveAttempt: false },
      });
    }
    const plan = await tx.executionPlan.create({
      data: {
        workspaceId: input.workspaceId,
        title: input.title.trim(),
        description: input.description ?? null,
        issueId: input.issueId ?? null,
        projectId: input.projectId ?? null,
        contextSetId: input.contextSetId ?? null,
        goalId: input.goalId ?? null,
        isActiveAttempt: input.goalId ? true : undefined,
        status: input.status ?? ExecutionPlanStatus.DRAFT,
        createdById: input.actorId,
        createdByAgentId: input.actorAgentId ?? null,
      },
    });
    if (input.steps && input.steps.length) {
      for (let i = 0; i < input.steps.length; i++) {
        const step = input.steps[i];
        await tx.executionStep.create({
          data: {
            workspaceId: input.workspaceId,
            planId: plan.id,
            title: step.title.trim(),
            body: step.body ?? null,
            position: i,
            assignedAgentId: step.assignedAgentId ?? null,
            assignedUserId: step.assignedUserId ?? null,
            expectedOutput: step.expectedOutput ?? null,
            verification: step.verification === undefined || step.verification === null
              ? Prisma.JsonNull
              : step.verification,
            dependsOnStepIds: step.dependsOnStepIds ?? [],
          },
        });
      }
    }
    await recordChange(tx, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      actorAgentId: input.actorAgentId ?? null,
      entity: "execution-plan",
      entityId: plan.id,
      action: "created",
      after: { title: plan.title, status: plan.status, stepCount: input.steps?.length ?? 0 },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "execution-plan",
      subjectId: plan.id,
      payload: {
        planTitle: plan.title,
        planStatus: plan.status,
        issueId: input.issueId ?? null,
        projectId: input.projectId ?? null,
        action: "created",
      } as Prisma.InputJsonValue,
    });
    return { id: plan.id };
  });
  return { id };
}

/** Update head metadata or status. Steps use addStep/updateStep. */
export async function updateExecutionPlan(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    planId: string;
    title?: string;
    description?: string | null;
    status?: ExecutionPlanStatus;
    contextSetId?: string | null;
  },
): Promise<void> {
  const existing = await db.executionPlan.findFirst({
    where: { id: params.planId, workspaceId: params.workspaceId },
    select: { id: true, status: true, title: true },
  });
  if (!existing) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Execution plan not found." });
  }
  await db.$transaction(async (tx) => {
    await tx.executionPlan.update({
      where: { id: params.planId },
      data: {
        title: params.title?.trim() ?? undefined,
        description: params.description === undefined ? undefined : params.description,
        status: params.status ?? undefined,
        contextSetId: params.contextSetId === undefined ? undefined : params.contextSetId,
      },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      entity: "execution-plan",
      entityId: params.planId,
      action: "updated",
      before: { title: existing.title, status: existing.status },
      after: { title: params.title ?? existing.title, status: params.status ?? existing.status },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "execution-plan",
      subjectId: params.planId,
    });
  });
}

/** Append a step to a plan (position = current max + 1). */
export async function addExecutionStep(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    planId: string;
    title: string;
    body?: string | null;
    assignedAgentId?: string | null;
    assignedUserId?: string | null;
    expectedOutput?: string | null;
    verification?: Prisma.InputJsonValue | null;
    dependsOnStepIds?: string[];
  },
): Promise<{ id: string }> {
  const plan = await db.executionPlan.findFirst({
    where: { id: params.planId, workspaceId: params.workspaceId, archivedAt: null },
    select: { id: true },
  });
  if (!plan) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Execution plan not found." });
  }
  const last = await db.executionStep.findFirst({
    where: { planId: params.planId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const step = await db.executionStep.create({
    data: {
      workspaceId: params.workspaceId,
      planId: params.planId,
      title: params.title.trim(),
      body: params.body ?? null,
      position: (last?.position ?? -1) + 1,
      assignedAgentId: params.assignedAgentId ?? null,
      assignedUserId: params.assignedUserId ?? null,
      expectedOutput: params.expectedOutput ?? null,
      verification:
        params.verification === undefined || params.verification === null
          ? Prisma.JsonNull
          : params.verification,
      dependsOnStepIds: params.dependsOnStepIds ?? [],
    },
  });
  await db.executionPlan.update({
    where: { id: params.planId },
    data: { updatedAt: new Date() },
  });
  return { id: step.id };
}

/** Update a step's status / assignee / fields. */
export async function updateExecutionStep(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    stepId: string;
    title?: string;
    body?: string | null;
    status?: ExecutionStepStatus;
    assignedAgentId?: string | null;
    assignedUserId?: string | null;
    expectedOutput?: string | null;
    verification?: Prisma.InputJsonValue | null;
    sourceRunId?: string | null;
    dependsOnStepIds?: string[];
  },
): Promise<void> {
  const step = await db.executionStep.findFirst({
    where: { id: params.stepId, workspaceId: params.workspaceId },
    select: { id: true, planId: true, status: true },
  });
  if (!step) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Execution step not found." });
  }
  const verificationData =
    params.verification === undefined
      ? {}
      : params.verification === null
        ? { verification: Prisma.JsonNull }
        : { verification: params.verification };
  await db.$transaction(async (tx) => {
    await tx.executionStep.update({
      where: { id: params.stepId },
      data: {
        title: params.title?.trim() ?? undefined,
        body: params.body === undefined ? undefined : params.body,
        status: params.status ?? undefined,
        assignedAgentId:
          params.assignedAgentId === undefined ? undefined : params.assignedAgentId,
        assignedUserId:
          params.assignedUserId === undefined ? undefined : params.assignedUserId,
        expectedOutput:
          params.expectedOutput === undefined ? undefined : params.expectedOutput,
        sourceRunId: params.sourceRunId === undefined ? undefined : params.sourceRunId,
        dependsOnStepIds: params.dependsOnStepIds ?? undefined,
        ...verificationData,
      },
    });
    await tx.executionPlan.update({
      where: { id: step.planId },
      data: { updatedAt: new Date() },
    });
    if (params.status && params.status !== step.status) {
      await recordChange(tx, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        entity: "execution-step",
        entityId: params.stepId,
        action: "transition",
        before: { status: step.status },
        after: { status: params.status },
        eventKind: EventKind.ISSUE_UPDATED,
        subjectType: "execution-step",
        subjectId: params.stepId,
        payload: { planId: step.planId, from: step.status, to: params.status },
      });
      // Orchestration loop: when a step is marked DONE (manually or by an
      // agent), re-evaluate downstream readiness so dependents that are
      // now unblocked flip TODO → READY and dispatch. Done inside the
      // same transaction so the cascade is atomic with the status flip.
      if (params.status === "DONE") {
        const { cascadeReadiness } = await import(
          "@/server/services/orchestration-service"
        );
        await cascadeReadiness(tx, {
          workspaceId: params.workspaceId,
          planId: step.planId,
          actorId: params.actorId,
        });
      }
    }
  });

  // Auto-judge hook: when a step lands in REVIEW (worker posted output),
  // dispatch a REVIEWER if the plan opted into autoJudge. Run AFTER the
  // transaction commits — the judge dispatch opens its own transaction and
  // we don't want it to wedge the status write if dispatch resolution is
  // slow. Best-effort; failures here don't roll back the REVIEW transition.
  if (params.status === "REVIEW" && params.status !== step.status) {
    try {
      const { maybeAutoJudge } = await import(
        "@/server/services/orchestration-service"
      );
      await maybeAutoJudge(db as PrismaClient, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        stepId: params.stepId,
      });
    } catch {
      // Swallow — auto-judge is opportunistic; an operator can call
      // plans.judge manually if dispatch failed.
    }
  }
}
