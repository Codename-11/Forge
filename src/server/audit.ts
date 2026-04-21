import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { EventKind } from "@prisma/client";
import { publish } from "@/server/realtime";
import { nanoid } from "nanoid";

/**
 * Synthetic slug + url used to route agent-bound dispatches through the
 * shared WebhookDelivery queue without adding a new column or table. The
 * worker recognises these urls and resolves the target agent at delivery
 * time:
 *
 *  - `agent:dispatch`            — generic per-workspace shim; the worker
 *                                  looks at the event's subject issue's
 *                                  assignedAgentId to find the target.
 *  - `agent:dispatch:{agentId}`  — per-agent shim; the worker parses the
 *                                  suffix to resolve the target directly.
 *                                  Used for comment @mentions where the
 *                                  target isn't the issue's assignee.
 */
export const AGENT_DISPATCH_WEBHOOK_SLUG = "__agents__";
export const AGENT_DISPATCH_WEBHOOK_URL = "agent:dispatch";
export const AGENT_DISPATCH_WEBHOOK_URL_PREFIX = "agent:dispatch:";

/**
 * Build the synthetic per-agent dispatch url. Keep the format stable —
 * the worker parses the suffix with `slice(prefix.length)`.
 */
export function agentDispatchUrlFor(agentId: string): string {
  return `${AGENT_DISPATCH_WEBHOOK_URL_PREFIX}${agentId}`;
}

/**
 * Lazily upsert the synthetic Webhook row for a given dispatch url. One
 * row per (workspace, url). `events` is set to the union of agent-routed
 * kinds so that the worker's `webhook.active` gate stays meaningful.
 *
 * The `secret` on this row is only used as a last-resort HMAC key — the
 * worker prefers `Agent.webhookSecret` when the delivery resolves to a
 * specific agent.
 */
async function upsertAgentDispatchWebhook(
  tx: PrismaClient | Prisma.TransactionClient,
  workspaceId: string,
  url: string,
): Promise<string> {
  const existing = await tx.webhook.findFirst({
    where: { workspaceId, url },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await tx.webhook.create({
    data: {
      workspaceId,
      url,
      secret: nanoid(32),
      events: [
        EventKind.AGENT_ASSIGNED,
        EventKind.ISSUE_QUEUED,
        EventKind.COMMENT_CREATED,
        EventKind.ISSUE_PRIORITY_CHANGED,
      ],
      active: true,
    },
    select: { id: true },
  });
  return created.id;
}

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

  // Agent-targeted dispatch. Several event kinds push to a specific agent
  // (or several agents); each resolves to one or more synthetic Webhook
  // rows that the worker understands. Collected into `agentWebhookIds` so
  // the final createMany is a single round-trip.
  const agentWebhookIds: string[] = [];

  // (a) Issue-level assignment / queuing — route to the issue's currently
  //     assigned agent via the generic `agent:dispatch` shim. Worker
  //     resolves the target agent from the subject issue at delivery time.
  const isAssigneeRouted =
    (params.eventKind === EventKind.AGENT_ASSIGNED ||
      params.eventKind === EventKind.ISSUE_QUEUED) &&
    params.subjectType === "issue";
  if (isAssigneeRouted) {
    const issue = await tx.issue.findUnique({
      where: { id: params.subjectId },
      select: { assignedAgentId: true, assignedAgent: { select: { webhookUrl: true } } },
    });
    if (issue?.assignedAgentId && issue.assignedAgent?.webhookUrl) {
      const wid = await upsertAgentDispatchWebhook(
        tx,
        params.workspaceId,
        AGENT_DISPATCH_WEBHOOK_URL,
      );
      agentWebhookIds.push(wid);
    }
  }

  // (b) Priority escalations (HIGH / URGENT) on an assigned issue — push
  //     to the assignee via a per-agent shim so the delivery carries its
  //     own target id (doesn't re-resolve the issue's assignee later).
  if (
    params.eventKind === EventKind.ISSUE_PRIORITY_CHANGED &&
    params.subjectType === "issue"
  ) {
    const to = (params.payload as { to?: string } | undefined)?.to;
    if (to === "HIGH" || to === "URGENT") {
      const issue = await tx.issue.findUnique({
        where: { id: params.subjectId },
        select: {
          assignedAgentId: true,
          assignedAgent: { select: { id: true, webhookUrl: true } },
        },
      });
      if (issue?.assignedAgentId && issue.assignedAgent?.webhookUrl) {
        const wid = await upsertAgentDispatchWebhook(
          tx,
          params.workspaceId,
          agentDispatchUrlFor(issue.assignedAgentId),
        );
        agentWebhookIds.push(wid);
      }
    }
  }

  // (c) Comment @mentions — one delivery per mentioned agent, each against
  //     its own per-agent shim so the worker pushes to the right webhookUrl
  //     instead of the issue's assigned agent.
  if (
    params.eventKind === EventKind.COMMENT_CREATED &&
    params.subjectType === "issue"
  ) {
    const payload = params.payload as
      | { mentions?: Array<{ agentId: string; profileKey?: string }> }
      | undefined;
    const mentions = payload?.mentions ?? [];
    if (mentions.length) {
      // Load the mentioned agents to filter out any that don't have a
      // webhookUrl (nothing to deliver to) and to enforce workspace
      // scoping defensively.
      const agents = await tx.agent.findMany({
        where: {
          workspaceId: params.workspaceId,
          id: { in: mentions.map((m) => m.agentId) },
          archivedAt: null,
          webhookUrl: { not: null },
        },
        select: { id: true },
      });
      for (const a of agents) {
        const wid = await upsertAgentDispatchWebhook(
          tx,
          params.workspaceId,
          agentDispatchUrlFor(a.id),
        );
        agentWebhookIds.push(wid);
      }
    }
  }

  const deliveryRows = subscribers.map((w) => ({
    webhookId: w.id,
    eventId: event.id,
  }));
  const seen = new Set(deliveryRows.map((r) => r.webhookId));
  for (const wid of agentWebhookIds) {
    if (!seen.has(wid)) {
      deliveryRows.push({ webhookId: wid, eventId: event.id });
      seen.add(wid);
    }
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
