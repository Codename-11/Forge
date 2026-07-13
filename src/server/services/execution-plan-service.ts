import "server-only";
import type { PrismaClient } from "@prisma/client";
import { EventKind, ExecutionPlanStatus, GoalStatus, Prisma } from "@prisma/client";
import type { ExecutionStepStatus } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { recordChange } from "@/server/audit";
import { materializeStepAsIssueTx } from "@/server/services/execution-step-issue-service";
import {
  assertValidStepIndexDependencies,
  validateStepAssignees,
  validateStepDependencies,
  validateStepSourceRun,
} from "@/server/services/execution-step-integrity";

/**
 * Materialize an ExecutionStep into a first-class Issue (AXI-56). Idempotent:
 * if the step is already linked, returns the existing issue. Carries the
 * step's completion contract onto the issue (title, body→description,
 * expectedOutput, verification→verificationChecklist, assignee) so the step's
 * worker run can bind to its own issue instead of the plan's shared anchor.
 *
 * "Plan if desired": steps are NOT auto-materialized — call this when you want
 * the step tracked as board/cycle/project work.
 */
export async function materializeStepAsIssue(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    stepId: string;
  },
): Promise<{ issueId: string; created: boolean }> {
  return db.$transaction((tx) => materializeStepAsIssueTx(tx, params));
}

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
    /**
     * Optional dependencies by 0-based index within the `steps` array (AXI-54
     * gap 2). Mirrors `plans.addSteps` so callers can seed a hand-authored DAG
     * in one create call before real step ids exist. Resolved to real ids in
     * the same transaction; merged (union) with any explicit `dependsOnStepIds`.
     */
    dependsOnStepIndexes?: number[];
  }>;
}

/** Create an ExecutionPlan with optional seeded steps. */
export async function createExecutionPlan(
  db: PrismaClient,
  input: CreateExecutionPlanInput,
): Promise<{ id: string }> {
  let goalCrewId: string | null = null;
  if (
    input.status !== undefined &&
    input.status !== ExecutionPlanStatus.DRAFT &&
    input.status !== ExecutionPlanStatus.APPROVED
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "New plans must start as DRAFT or APPROVED; use the activation lifecycle to run them.",
    });
  }
  if (input.steps?.length) {
    assertValidStepIndexDependencies(input.steps);
    if (input.steps.some((step) => (step.dependsOnStepIds?.length ?? 0) > 0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "New plan steps must use dependsOnStepIndexes; dependency ids cannot belong to a plan that has not been created yet.",
      });
    }
    await validateStepAssignees(db, {
      workspaceId: input.workspaceId,
      steps: input.steps,
    });
  }
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
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Context set not found in this workspace.",
      });
    }
  }
  if (input.goalId) {
    const goal = await db.goal.findFirst({
      where: { id: input.goalId, workspaceId: input.workspaceId },
      select: { id: true, status: true, crewId: true },
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
    goalCrewId = goal.crewId;
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
        crewId: input.goalId ? goalCrewId : undefined,
        isActiveAttempt: input.goalId ? true : undefined,
        status: input.status ?? ExecutionPlanStatus.DRAFT,
        createdById: input.actorId,
        createdByAgentId: input.actorAgentId ?? null,
      },
    });
    if (input.steps && input.steps.length) {
      // First pass: create steps without index-based deps so we have real ids.
      const createdIds: string[] = [];
      for (let i = 0; i < input.steps.length; i++) {
        const step = input.steps[i];
        const created = await tx.executionStep.create({
          data: {
            workspaceId: input.workspaceId,
            planId: plan.id,
            title: step.title.trim(),
            body: step.body ?? null,
            position: i,
            assignedAgentId: step.assignedAgentId ?? null,
            assignedUserId: step.assignedUserId ?? null,
            expectedOutput: step.expectedOutput ?? null,
            verification:
              step.verification === undefined || step.verification === null
                ? Prisma.JsonNull
                : step.verification,
            // Index-based deps are resolved in pass 2.
            dependsOnStepIds: [],
          },
          select: { id: true },
        });
        createdIds.push(created.id);
      }
      // Second pass: resolve index-based deps to real step ids. Indexes are
      // scoped to this create call's steps array and were validated before
      // any records were created.
      for (let i = 0; i < input.steps.length; i++) {
        const step = input.steps[i];
        const idxs = step.dependsOnStepIndexes ?? [];
        if (!idxs.length) continue;
        const resolvedIds = idxs.map((idx) => createdIds[idx]);
        if (resolvedIds.length === 0) continue;
        await tx.executionStep.update({
          where: { id: createdIds[i] },
          data: { dependsOnStepIds: resolvedIds },
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
  if (params.contextSetId) {
    const contextSet = await db.contextSet.findFirst({
      where: {
        id: params.contextSetId,
        workspaceId: params.workspaceId,
        archivedAt: null,
      },
      select: { id: true },
    });
    if (!contextSet) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Context set not found in this workspace.",
      });
    }
  }
  if (
    params.status &&
    params.status !== existing.status &&
    !(
      (existing.status === ExecutionPlanStatus.DRAFT &&
        params.status === ExecutionPlanStatus.APPROVED) ||
      (existing.status === ExecutionPlanStatus.APPROVED &&
        params.status === ExecutionPlanStatus.DRAFT)
    )
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Use the plan activation or orchestration lifecycle for running and terminal states.",
    });
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
  return db.$transaction(async (tx) => {
    const [plan] = await tx.$queryRaw<
      Array<{ id: string; status: ExecutionPlanStatus }>
    >(Prisma.sql`
      SELECT "id", "status"
      FROM "ExecutionPlan"
      WHERE "id" = ${params.planId}
        AND "workspaceId" = ${params.workspaceId}
        AND "archivedAt" IS NULL
      FOR UPDATE
    `);
    if (!plan) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Execution plan not found." });
    }
    if (plan.status !== ExecutionPlanStatus.DRAFT) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Steps can only be added while the execution plan is a draft.",
      });
    }
    await validateStepAssignees(tx, { workspaceId: params.workspaceId, steps: [params] });
    await validateStepDependencies(tx, {
      workspaceId: params.workspaceId,
      planId: params.planId,
      dependsOnStepIds: params.dependsOnStepIds ?? [],
    });
    const last = await tx.executionStep.findFirst({
      where: { planId: params.planId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const step = await tx.executionStep.create({
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
    await tx.executionPlan.update({
      where: { id: params.planId },
      data: { updatedAt: new Date() },
    });
    return { id: step.id };
  });
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
    select: {
      id: true,
      planId: true,
      status: true,
      plan: { select: { status: true, crewId: true } },
    },
  });
  if (!step) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Execution step not found." });
  }
  if (
    params.status !== undefined &&
    params.status !== step.status &&
    (params.status === "READY" || params.status === "RUNNING")
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "READY and RUNNING are orchestration-owned states; activate the plan or start the assigned run instead.",
    });
  }
  if (params.dependsOnStepIds !== undefined && step.plan.status !== ExecutionPlanStatus.DRAFT) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Step dependencies can only be edited while the execution plan is a draft.",
    });
  }
  const verificationData =
    params.verification === undefined
      ? {}
      : params.verification === null
        ? { verification: Prisma.JsonNull }
        : { verification: params.verification };
  await db.$transaction(async (tx) => {
    if (params.status !== undefined && params.status !== step.status && step.plan.crewId) {
      const { lockCrewForExecution } = await import("@/server/services/orchestration-service");
      await lockCrewForExecution(tx, {
        workspaceId: params.workspaceId,
        crewId: step.plan.crewId,
      });
    }
    // Serialize dependency edits on this plan so concurrent updates cannot
    // each validate a half of a cycle and then both commit.
    const [lockedPlan] = await tx.$queryRaw<Array<{ status: ExecutionPlanStatus }>>(Prisma.sql`
      SELECT "status"
      FROM "ExecutionPlan"
      WHERE "id" = ${step.planId} AND "workspaceId" = ${params.workspaceId}
      FOR UPDATE
    `);
    if (!lockedPlan) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Execution plan not found." });
    }
    if (params.dependsOnStepIds !== undefined && lockedPlan.status !== ExecutionPlanStatus.DRAFT) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Step dependencies can only be edited while the execution plan is a draft.",
      });
    }
    await validateStepAssignees(tx, { workspaceId: params.workspaceId, steps: [params] });
    await validateStepSourceRun(tx, {
      workspaceId: params.workspaceId,
      sourceRunId: params.sourceRunId,
    });
    if (params.dependsOnStepIds !== undefined) {
      await validateStepDependencies(tx, {
        workspaceId: params.workspaceId,
        planId: step.planId,
        stepId: params.stepId,
        dependsOnStepIds: params.dependsOnStepIds,
      });
    }
    await tx.executionStep.update({
      where: { id: params.stepId },
      data: {
        title: params.title?.trim() ?? undefined,
        body: params.body === undefined ? undefined : params.body,
        status: params.status ?? undefined,
        assignedAgentId: params.assignedAgentId === undefined ? undefined : params.assignedAgentId,
        assignedUserId: params.assignedUserId === undefined ? undefined : params.assignedUserId,
        expectedOutput: params.expectedOutput === undefined ? undefined : params.expectedOutput,
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
      const releasedExecutionSlot =
        (step.status === "READY" || step.status === "RUNNING") &&
        params.status !== "READY" &&
        params.status !== "RUNNING";
      // DONE may unlock dependent steps; REVIEW/BLOCKED/CANCELED (and other
      // exits from READY/RUNNING) release a crew slot. Refill across all plans
      // sharing the crew so eligible work in another plan is not stranded.
      if (params.status === "DONE" || releasedExecutionSlot) {
        const { refillReadinessAfterSlotRelease } =
          await import("@/server/services/orchestration-service");
        await refillReadinessAfterSlotRelease(tx, {
          workspaceId: params.workspaceId,
          planId: step.planId,
          actorId: params.actorId,
        });
      }
      if (params.status === "DONE") {
        const { maybeCompleteGoal } = await import("@/server/services/orchestration-service");
        await maybeCompleteGoal(tx, {
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
      const { maybeAutoJudge } = await import("@/server/services/orchestration-service");
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
