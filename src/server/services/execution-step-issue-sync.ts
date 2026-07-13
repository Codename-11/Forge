import "server-only";
import {
  EventKind,
  ExecutionPlanStatus,
  ExecutionStepStatus,
  type Prisma,
  type PrismaClient,
  type StatusCategory,
} from "@prisma/client";
import { finishRunsForIssue } from "@/server/services/agent-run";

type Tx = PrismaClient | Prisma.TransactionClient;

const STEP_STATUS_CATEGORY: Partial<Record<ExecutionStepStatus, StatusCategory>> = {
  [ExecutionStepStatus.TODO]: "TODO",
  [ExecutionStepStatus.READY]: "TODO",
  [ExecutionStepStatus.RUNNING]: "IN_PROGRESS",
  [ExecutionStepStatus.REVIEW]: "IN_REVIEW",
  [ExecutionStepStatus.DONE]: "DONE",
  [ExecutionStepStatus.CANCELED]: "CANCELED",
};

async function preferredIssueStatusId(
  tx: Tx,
  workspaceId: string,
  category: StatusCategory,
): Promise<string | null> {
  const workspace =
    category === "IN_PROGRESS" || category === "IN_REVIEW"
      ? await tx.workspace.findUnique({
          where: { id: workspaceId },
          select: { startedStatusId: true, reviewStatusId: true },
        })
      : null;
  const configuredId =
    category === "IN_PROGRESS"
      ? workspace?.startedStatusId
      : category === "IN_REVIEW"
        ? workspace?.reviewStatusId
        : null;
  if (configuredId) {
    const configured = await tx.status.findFirst({
      where: { id: configuredId, workspaceId, category },
      select: { id: true },
    });
    if (configured) return configured.id;
  }
  const fallback = await tx.status.findFirst({
    where: { workspaceId, category },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return fallback?.id ?? null;
}

function issueLifecyclePatch(
  category: StatusCategory,
  startedAt: Date | null,
): {
  startedAt?: Date;
  completedAt: Date | null;
  canceledAt: Date | null;
} {
  const now = new Date();
  return {
    ...(category === "IN_PROGRESS" && !startedAt ? { startedAt: now } : {}),
    completedAt: category === "DONE" ? now : null,
    canceledAt: category === "CANCELED" ? now : null,
  };
}

/**
 * Project an authoritative orchestration transition onto a materialized Issue.
 * BLOCKED has no Issue status category, so it intentionally leaves the Issue
 * in its last meaningful lifecycle state while the plan context card carries
 * the block and feedback.
 */
export async function syncMaterializedIssueStatusFromStep(
  tx: Tx,
  params: {
    workspaceId: string;
    stepId: string;
    actorId: string | null;
    actorAgentId?: string | null;
  },
): Promise<boolean> {
  const step = await tx.executionStep.findFirst({
    where: { id: params.stepId, workspaceId: params.workspaceId },
    select: {
      id: true,
      planId: true,
      status: true,
      issue: {
        select: {
          id: true,
          statusId: true,
          startedAt: true,
          status: { select: { category: true } },
        },
      },
    },
  });
  if (!step?.issue) return false;
  const category = STEP_STATUS_CATEGORY[step.status];
  if (!category || step.issue.status.category === category) return false;
  const statusId = await preferredIssueStatusId(tx, params.workspaceId, category);
  if (!statusId) return false;

  const beforeStatusId = step.issue.statusId;
  await tx.issue.update({
    where: { id: step.issue.id },
    data: {
      statusId,
      ...issueLifecyclePatch(category, step.issue.startedAt),
    },
  });
  const { recordChange } = await import("@/server/audit");
  await recordChange(tx, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    actorAgentId: params.actorAgentId ?? null,
    entity: "Issue",
    entityId: step.issue.id,
    action: "sync-execution-step-status",
    before: { statusId: beforeStatusId },
    after: { statusId, category, executionStepId: step.id },
    eventKind: EventKind.ISSUE_STATUS_CHANGED,
    subjectType: "issue",
    subjectId: step.issue.id,
    payload: {
      statusId,
      category,
      executionStepId: step.id,
      planId: step.planId,
      orchestrationStatusSync: true,
    },
  });
  if (category === "DONE" || category === "CANCELED") {
    await finishRunsForIssue(tx, {
      workspaceId: params.workspaceId,
      issueId: step.issue.id,
      status: category === "DONE" ? "COMPLETED" : "ABANDONED",
      actorId: params.actorId,
      actorAgentId: params.actorAgentId ?? null,
    });
  }
  return true;
}

/**
 * Feed an explicit operator terminal decision on a materialized Issue back to
 * its one unambiguous plan step. In-flight states remain step-owned: moving an
 * Issue around the board cannot bypass DAG readiness or manufacture review
 * evidence. DONE/CANCELED are operator authority and therefore close/cancel
 * the corresponding step.
 */
export async function syncMaterializedStepTerminalFromIssue(
  tx: Tx,
  params: {
    workspaceId: string;
    issueId: string;
    category: StatusCategory;
    actorId: string | null;
    actorAgentId?: string | null;
  },
): Promise<{ stepId: string; status: ExecutionStepStatus } | null> {
  if (params.category !== "DONE" && params.category !== "CANCELED") return null;
  const candidates = await tx.executionStep.findMany({
    where: {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      status: { notIn: [ExecutionStepStatus.DONE, ExecutionStepStatus.CANCELED] },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: 2,
    select: {
      id: true,
      planId: true,
      status: true,
      plan: { select: { status: true, crewId: true } },
    },
  });
  if (candidates.length !== 1) return null;
  const step = candidates[0]!;
  const nextStatus =
    params.category === "DONE" ? ExecutionStepStatus.DONE : ExecutionStepStatus.CANCELED;
  const { lockCrewForExecution, refillReadinessAfterSlotRelease, maybeCompleteGoal } =
    await import("@/server/services/orchestration-service");
  if (step.plan.crewId) {
    await lockCrewForExecution(tx, {
      workspaceId: params.workspaceId,
      crewId: step.plan.crewId,
    });
  }
  await tx.executionStep.update({
    where: { id: step.id },
    data: { status: nextStatus },
  });
  const { recordChange } = await import("@/server/audit");
  await recordChange(tx, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    actorAgentId: params.actorAgentId ?? null,
    entity: "execution-step",
    entityId: step.id,
    action: "sync-materialized-issue-status",
    before: { status: step.status },
    after: { status: nextStatus, issueId: params.issueId },
    eventKind: EventKind.ISSUE_UPDATED,
    subjectType: "execution-step",
    subjectId: step.id,
    payload: {
      planId: step.planId,
      issueId: params.issueId,
      from: step.status,
      to: nextStatus,
      source: "materialized-issue-status",
    },
  });

  if (nextStatus === ExecutionStepStatus.DONE) {
    await refillReadinessAfterSlotRelease(tx, {
      workspaceId: params.workspaceId,
      planId: step.planId,
      actorId: params.actorId,
    });
    await maybeCompleteGoal(tx, {
      workspaceId: params.workspaceId,
      planId: step.planId,
      actorId: params.actorId,
    });
  } else if (step.plan.status === ExecutionPlanStatus.RUNNING) {
    await tx.executionPlan.update({
      where: { id: step.planId },
      data: { status: ExecutionPlanStatus.BLOCKED, updatedAt: new Date() },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      actorAgentId: params.actorAgentId ?? null,
      entity: "execution-plan",
      entityId: step.planId,
      action: "block-materialized-step-canceled",
      before: { status: step.plan.status },
      after: { status: ExecutionPlanStatus.BLOCKED, stepId: step.id },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "execution-plan",
      subjectId: step.planId,
      payload: {
        reason: "materialized_issue_canceled",
        stepId: step.id,
        issueId: params.issueId,
      },
    });
  }
  if (nextStatus === ExecutionStepStatus.CANCELED) {
    // The canceled step's own plan is BLOCKED above before refilling, so only
    // other RUNNING plans in the crew can claim the released slot.
    await refillReadinessAfterSlotRelease(tx, {
      workspaceId: params.workspaceId,
      planId: step.planId,
      actorId: params.actorId,
    });
  }
  return { stepId: step.id, status: nextStatus };
}
