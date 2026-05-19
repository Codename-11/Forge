import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ActionRequestStatus, EventKind, NotificationSeverity } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { recordChange } from "@/server/audit";

export interface CreateActionRequestInput {
  workspaceId: string;
  actorId: string | null;
  actorAgentId?: string | null;
  title: string;
  body?: string | null;
  severity?: NotificationSeverity;
  assignedUserId?: string | null;
  assignedAgentId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  issueId?: string | null;
  dueAt?: Date | null;
}

/**
 * Create an ActionRequest and emit an audit/activity event. Either
 * `assignedUserId` or `assignedAgentId` is recommended; the request
 * shows up on the inbox of whoever is targeted.
 */
export async function createActionRequest(
  db: PrismaClient,
  input: CreateActionRequestInput,
): Promise<{ id: string }> {
  if (input.issueId) {
    const found = await db.issue.findFirst({
      where: { id: input.issueId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!found) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found in this workspace." });
    }
  }
  const { id } = await db.$transaction(async (tx) => {
    const row = await tx.actionRequest.create({
      data: {
        workspaceId: input.workspaceId,
        title: input.title.trim(),
        body: input.body ?? null,
        severity: input.severity ?? NotificationSeverity.INFO,
        requestedByUserId: input.actorAgentId ? null : input.actorId,
        requestedByAgentId: input.actorAgentId ?? null,
        assignedUserId: input.assignedUserId ?? null,
        assignedAgentId: input.assignedAgentId ?? null,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        issueId: input.issueId ?? null,
        dueAt: input.dueAt ?? null,
      },
    });
    await recordChange(tx, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      entity: "action-request",
      entityId: row.id,
      action: "created",
      after: { title: row.title, severity: row.severity },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "action-request",
      subjectId: row.id,
      payload: {
        title: row.title,
        severity: row.severity,
        assignedUserId: row.assignedUserId,
        assignedAgentId: row.assignedAgentId,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
      } as Prisma.InputJsonValue,
    });
    return { id: row.id };
  });
  return { id };
}

/** Resolve / dismiss / snooze an action request. */
export async function transitionActionRequest(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    requestId: string;
    status: ActionRequestStatus;
    resolution?: string | null;
  },
): Promise<void> {
  const row = await db.actionRequest.findFirst({
    where: { id: params.requestId, workspaceId: params.workspaceId },
    select: { id: true, status: true, title: true },
  });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Action request not found." });
  }
  await db.$transaction(async (tx) => {
    await tx.actionRequest.update({
      where: { id: row.id },
      data: {
        status: params.status,
        resolvedAt: params.status === ActionRequestStatus.OPEN ? null : new Date(),
        resolution: params.resolution ?? undefined,
      },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      entity: "action-request",
      entityId: row.id,
      action: "transition",
      before: { status: row.status },
      after: { status: params.status },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "action-request",
      subjectId: row.id,
    });
  });
}
