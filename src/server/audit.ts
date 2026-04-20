import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { EventKind } from "@prisma/client";
import { publish } from "@/server/realtime";
import { nanoid } from "nanoid";

/**
 * Record a change to the audit log AND emit an activity event for the
 * product/plugin stream. Two separate tables intentionally — see schema.
 *
 * Pass an open Prisma client (tx or base) so callers can include this in
 * an existing transaction.
 */
export async function recordChange(
  tx: PrismaClient | Prisma.TransactionClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    entity: string;
    entityId: string;
    action: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
    eventKind: EventKind;
    subjectType: string;
    subjectId: string;
    payload?: Prisma.InputJsonValue;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      entity: params.entity,
      entityId: params.entityId,
      action: params.action,
      before: params.before,
      after: params.after,
      ip: params.ip ?? undefined,
      userAgent: params.userAgent ?? undefined,
    },
  });
  const event = await tx.activityEvent.create({
    data: {
      workspaceId: params.workspaceId,
      kind: params.eventKind,
      actorId: params.actorId,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      payload: params.payload ?? {},
    },
  });
  // Fire-and-forget — pub/sub delivery is best-effort; webhook workers
  // pick up events from the ActivityEvent table as the durable queue.
  void publish({
    id: event.id ?? nanoid(),
    workspaceId: event.workspaceId,
    kind: event.kind,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    payload: event.payload,
    actorId: event.actorId,
    createdAt: event.createdAt.toISOString(),
  });
}
