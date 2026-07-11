import "server-only";
import type { PrismaClient } from "@prisma/client";
import { EventKind, ExecutionPlanStatus, GoalStatus, Prisma } from "@prisma/client";
import type { ExecutionStepStatus } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { recordChange } from "@/server/audit";
import { materializeStepAsIssueTx } from "@/server/services/execution-step-issue-service";

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
/**
 * Reject index-based step dependencies that form a cycle (Kahn's algorithm).
 * A dependency loop would leave the plan RUNNING forever with nothing ready.
 * Kept local (a pure ~20-line function) to avoid an import cycle with the
 * orchestration service. Out-of-range / self indexes are ignored.
 */
function assertNoStepCycles(steps: { dependsOnStepIndexes?: number[] }[]): void {
  const n = steps.length;
  const indeg = new Array<number>(n).fill(0);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (const d of steps[i].dependsOnStepIndexes ?? []) {
      if (!Number.isInteger(d) || d < 0 || d >= n || d === i) continue;
      adj[d].push(i);
      indeg[i]++;
    }
  }
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  let seen = 0;
  while (queue.length) {
    const u = queue.shift()!;
    seen++;
    for (const v of adj[u]) if (--indeg[v] === 0) queue.push(v);
  }
  if (seen !== n) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Plan steps contain a dependency cycle — steps can't depend on each other in a loop.",
    });
  }
}

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
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Context set not found in this workspace.",
      });
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
      assertNoStepCycles(input.steps);
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
            // Index-based deps resolved in pass 2; fall back to explicit ids.
            dependsOnStepIds: step.dependsOnStepIndexes?.length
              ? []
              : (step.dependsOnStepIds ?? []),
          },
          select: { id: true },
        });
        createdIds.push(created.id);
      }
      // Second pass: resolve index-based deps to real step ids. Indexes are
      // scoped to this create call's steps array; invalid/self references are
      // ignored defensively. Explicit dependsOnStepIds are preserved and
      // de-duped with resolved ids.
      for (let i = 0; i < input.steps.length; i++) {
        const step = input.steps[i];
        const idxs = step.dependsOnStepIndexes ?? [];
        if (!idxs.length) continue;
        const resolvedIds = idxs
          .filter((idx) => idx >= 0 && idx < createdIds.length && idx !== i)
          .map((idx) => createdIds[idx]);
        if (resolvedIds.length === 0) continue;
        const dependsOnStepIds = Array.from(
          new Set([...(step.dependsOnStepIds ?? []), ...resolvedIds]),
        );
        await tx.executionStep.update({
          where: { id: createdIds[i] },
          data: { dependsOnStepIds },
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
      // Orchestration loop: when a step is marked DONE (manually or by an
      // agent), re-evaluate downstream readiness so dependents that are
      // now unblocked flip TODO → READY and dispatch. Done inside the
      // same transaction so the cascade is atomic with the status flip.
      if (params.status === "DONE") {
        const { cascadeReadiness } = await import("@/server/services/orchestration-service");
        await cascadeReadiness(tx, {
          workspaceId: params.workspaceId,
          planId: step.planId,
          actorId: params.actorId,
        });
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
