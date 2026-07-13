import "server-only";
import { EventKind, Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { recordChange } from "@/server/audit";
import { resolveDefaultIssueAssigneeIds } from "@/server/services/issue-create";
import { autoWatchUser } from "@/server/services/issue-watchers";

export async function materializeStepAsIssueTx(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    stepId: string;
  },
): Promise<{ issueId: string; created: boolean }> {
  const step = await tx.executionStep.findFirst({
    where: { id: params.stepId, workspaceId: params.workspaceId },
    select: {
      id: true,
      title: true,
      body: true,
      expectedOutput: true,
      verification: true,
      assignedAgentId: true,
      issueId: true,
      plan: { select: { id: true, projectId: true, createdById: true } },
    },
  });
  if (!step) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Execution step not found." });
  }
  if (step.issueId) {
    return { issueId: step.issueId, created: false };
  }

  // Issue.authorId is required and must be a real User. Prefer the actor; fall
  // back to the plan's human creator. Agent-only contexts must supply one.
  const authorId = params.actorId ?? step.plan.createdById;
  if (!authorId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Cannot materialize a step without a human author (actor or plan creator).",
    });
  }

  const status = await tx.status.findFirst({
    where: { workspaceId: params.workspaceId, isDefault: true },
    select: { id: true },
  });
  if (!status) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Workspace has no default status.",
    });
  }
  const last = await tx.issue.findFirst({
    where: { workspaceId: params.workspaceId },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const number = (last?.number ?? 0) + 1;
  const assigneeIds = await resolveDefaultIssueAssigneeIds(tx, {
    workspaceId: params.workspaceId,
    authorId,
  });

  const issue = await tx.issue.create({
    data: {
      workspaceId: params.workspaceId,
      number,
      title: step.title,
      description: step.body ?? null,
      statusId: status.id,
      authorId,
      projectId: step.plan.projectId ?? null,
      assignedAgentId: step.assignedAgentId ?? null,
      assignees: {
        create: assigneeIds.map((userId) => ({ userId })),
      },
      expectedOutput: step.expectedOutput ?? null,
      verificationChecklist:
        step.verification === null || step.verification === undefined
          ? Prisma.JsonNull
          : (step.verification as Prisma.InputJsonValue),
    },
    select: { id: true, number: true, title: true },
  });
  for (const userId of assigneeIds) {
    await autoWatchUser(tx, {
      workspaceId: params.workspaceId,
      issueId: issue.id,
      userId,
    });
  }

  await tx.executionStep.update({
    where: { id: step.id },
    data: { issueId: issue.id },
  });

  await recordChange(tx, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    actorAgentId: params.actorAgentId ?? null,
    entity: "Issue",
    entityId: issue.id,
    action: "materialized-from-step",
    after: { number: issue.number, title: issue.title, stepId: step.id },
    eventKind: EventKind.ISSUE_CREATED,
    subjectType: "issue",
    subjectId: issue.id,
    payload: {
      number: issue.number,
      title: issue.title,
      fromStepId: step.id,
      planId: step.plan.id,
    },
  });
  const { syncMaterializedIssueStatusFromStep } =
    await import("@/server/services/execution-step-issue-sync");
  await syncMaterializedIssueStatusFromStep(tx, {
    workspaceId: params.workspaceId,
    stepId: step.id,
    actorId: params.actorId,
    actorAgentId: params.actorAgentId ?? null,
  });

  return { issueId: issue.id, created: true };
}
