import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { EventKind } from "@prisma/client";
import { publish } from "@/server/realtime";
import { nanoid } from "nanoid";

/**
 * Synthetic slug + url used to route agent-bound dispatches through the
 * shared WebhookDelivery queue without adding a new column or table. The
 * worker recognises this url and resolves the target agent at delivery
 * time from the linked ActivityEvent (subjectId -> Issue.assignedAgent).
 */
export const AGENT_DISPATCH_WEBHOOK_SLUG = "__agents__";
export const AGENT_DISPATCH_WEBHOOK_URL = "agent:dispatch";

/**
 * Record a change to the audit log AND emit an activity event for the
 * product/plugin stream. Two separate tables intentionally — see schema.
 *
 * In the same transaction we also enqueue `WebhookDelivery` rows for any
 * active workspace webhooks subscribed to this eventKind. Delivery itself
 * happens asynchronously in `src/server/worker.ts`.
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

  // Fan-out to subscribed webhooks. Single batch query + createMany keeps
  // this off the per-webhook N+1 path. Filter on `events: { has }` so the
  // DB does the enum membership check in-index.
  const subscribers = await tx.webhook.findMany({
    where: {
      workspaceId: params.workspaceId,
      active: true,
      events: { has: params.eventKind },
    },
    select: { id: true },
  });

  // Agent-targeted dispatch — for issue events that imply pushing work to
  // a specific agent, enqueue a row against a synthetic per-workspace
  // webhook (upserted lazily). The worker resolves the agent's webhookUrl
  // at delivery time from the linked issue.
  const isAgentBound =
    (params.eventKind === EventKind.AGENT_ASSIGNED ||
      params.eventKind === EventKind.ISSUE_QUEUED) &&
    params.subjectType === "issue";
  let agentWebhookId: string | null = null;
  if (isAgentBound) {
    const issue = await tx.issue.findUnique({
      where: { id: params.subjectId },
      select: { assignedAgentId: true, assignedAgent: { select: { webhookUrl: true } } },
    });
    if (issue?.assignedAgentId && issue.assignedAgent?.webhookUrl) {
      // Upsert the synthetic agent-dispatch webhook. One row per workspace.
      // `secret` is unused for agent dispatch (per-agent HMAC handled in
      // the worker) but is required by the schema.
      const existing = await tx.webhook.findFirst({
        where: {
          workspaceId: params.workspaceId,
          url: AGENT_DISPATCH_WEBHOOK_URL,
        },
        select: { id: true },
      });
      if (existing) {
        agentWebhookId = existing.id;
      } else {
        const created = await tx.webhook.create({
          data: {
            workspaceId: params.workspaceId,
            url: AGENT_DISPATCH_WEBHOOK_URL,
            secret: nanoid(32),
            events: [EventKind.AGENT_ASSIGNED, EventKind.ISSUE_QUEUED],
            active: true,
          },
          select: { id: true },
        });
        agentWebhookId = created.id;
      }
    }
  }

  const deliveryRows = subscribers.map((w) => ({
    webhookId: w.id,
    eventId: event.id,
  }));
  if (agentWebhookId && !deliveryRows.some((r) => r.webhookId === agentWebhookId)) {
    deliveryRows.push({ webhookId: agentWebhookId, eventId: event.id });
  }
  if (deliveryRows.length > 0) {
    await tx.webhookDelivery.createMany({ data: deliveryRows });
  }

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
