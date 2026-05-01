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
 * Hydrate the small `issueSnapshot` blob we attach to every AGENT_ASSIGNED
 * event payload — see `recordChange` for the wiring. Kept narrow on purpose:
 * id + number + title + priority + statusId + projectId + labelNames are
 * enough for an agent's webhook receiver to render a turn header and decide
 * whether to act, without an extra `issues.get` round-trip. Returns null
 * when the issue isn't in this workspace (defensive — recordChange callers
 * already validated subject scope, but a missing row shouldn't crash audit).
 */
export interface IssueSnapshot {
  id: string;
  number: number;
  title: string;
  priority: string;
  statusId: string;
  projectId: string | null;
  labelNames: string[];
}

async function loadIssueSnapshot(
  tx: PrismaClient | Prisma.TransactionClient,
  issueId: string,
): Promise<IssueSnapshot | null> {
  const row = await tx.issue.findUnique({
    where: { id: issueId },
    select: {
      id: true,
      number: true,
      title: true,
      priority: true,
      statusId: true,
      projectId: true,
      labels: { select: { label: { select: { name: true } } } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    priority: row.priority,
    statusId: row.statusId,
    projectId: row.projectId,
    labelNames: row.labels.map((l) => l.label.name),
  };
}

/**
 * Server-side auto-transition on AGENT_ASSIGNED. When the workspace has
 * `startedStatusId` set and the assigned issue is currently in a
 * BACKLOG / TODO category, flip the issue to that status row inside the
 * same transaction as the audit/event write. Returns the new statusId
 * if it transitioned, null otherwise. Skipped when:
 *   - workspace has no `startedStatusId` (opt-in feature)
 *   - target status missing or doesn't belong to the workspace
 *   - target status is not in IN_PROGRESS category (defensive — should
 *     have been validated at workspace.update time, but check again)
 *   - issue is already in IN_PROGRESS / IN_REVIEW / DONE / CANCELED
 */
async function maybeAutoTransitionOnAssign(
  tx: PrismaClient | Prisma.TransactionClient,
  workspaceId: string,
  issueId: string,
): Promise<string | null> {
  const ws = await tx.workspace.findUnique({
    where: { id: workspaceId },
    select: { startedStatusId: true },
  });
  if (!ws?.startedStatusId) return null;

  const [target, issue] = await Promise.all([
    tx.status.findUnique({
      where: { id: ws.startedStatusId },
      select: { id: true, workspaceId: true, category: true },
    }),
    tx.issue.findUnique({
      where: { id: issueId },
      select: { id: true, statusId: true, status: { select: { category: true } } },
    }),
  ]);
  if (!target || target.workspaceId !== workspaceId) return null;
  if (target.category !== "IN_PROGRESS") return null;
  if (!issue) return null;

  const currentCat = issue.status?.category;
  // Already started or terminal — nothing to do.
  if (
    currentCat === "IN_PROGRESS" ||
    currentCat === "IN_REVIEW" ||
    currentCat === "DONE" ||
    currentCat === "CANCELED"
  ) {
    return null;
  }
  if (issue.statusId === target.id) return null;

  await tx.issue.update({
    where: { id: issueId },
    data: { statusId: target.id },
  });
  return target.id;
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
        EventKind.CHAT_MESSAGE_POSTED,
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

  // Enrichment pass: AGENT_ASSIGNED events embed an `issueSnapshot` so the
  // agent's webhook receiver gets enough context (number, title, priority,
  // status, project, label names) to act without an immediate `issues.get`
  // round-trip. Single producer site (here in recordChange) so every
  // emitter — dispatcher, issue.create/update/bulkAssign, ai-triage, MCP
  // issues.assign / reassign — gets the same shape automatically. Grep
  // `issueSnapshot` in audit.ts to verify; this is the canonical site.
  //
  // Server-side auto-transition: when the workspace has
  // `startedStatusId` configured, AGENT_ASSIGNED also flips eligible
  // issues into that status here — same transaction, before the snapshot
  // loads, so the snapshot reflects the post-transition statusId. This
  // makes the daemon's client-side maybeTransitionToInProgress a no-op
  // for opted-in workspaces (it's idempotent — sees the issue already
  // started and skips). When the auto-transition fires, payloadOut also
  // gains an `autoTransitionedTo` field so receivers can tell apart a
  // pre-existing started status from a server-driven transition.
  let payloadOut: Prisma.InputJsonValue =
    (params.payload ?? {}) as Prisma.InputJsonValue;
  if (
    params.eventKind === EventKind.AGENT_ASSIGNED &&
    params.subjectType === "issue"
  ) {
    const transitionedTo = await maybeAutoTransitionOnAssign(
      tx,
      params.workspaceId,
      params.subjectId,
    );
    const snapshot = await loadIssueSnapshot(tx, params.subjectId);
    if (snapshot) {
      const base =
        params.payload && typeof params.payload === "object"
          ? (params.payload as Record<string, Prisma.InputJsonValue>)
          : {};
      payloadOut = {
        ...base,
        issueSnapshot: snapshot,
        ...(transitionedTo ? { autoTransitionedTo: transitionedTo } : {}),
      } as unknown as Prisma.InputJsonValue;
    }
  }

  const event = await tx.activityEvent.create({
    data: {
      workspaceId: params.workspaceId,
      kind: params.eventKind,
      actorId: params.actorId,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      payload: payloadOut,
    },
  });

  // Fan-out to subscribed webhooks. Single batch query + createMany keeps
  // this off the per-webhook N+1 path. Filter on `events: { has }` so the
  // DB does the enum membership check in-index.
  //
  // IMPORTANT: exclude synthetic agent-dispatch shim rows
  // (`agent:dispatch` + `agent:dispatch:<agentId>`) from this broadcast
  // query. The shims declare a populated `events` array because the
  // worker uses them as delivery targets, but they must only fire when
  // the agent-targeted dispatch logic below (branches a–d) explicitly
  // adds them to `agentWebhookIds`. Without this filter, a per-agent
  // shim like `agent:dispatch:victor` matches the broadcast for ANY
  // COMMENT_CREATED / AGENT_ASSIGNED / ISSUE_QUEUED / ISSUE_PRIORITY_CHANGED
  // / CHAT_MESSAGE_POSTED in the workspace — paging Victor on issues
  // he isn't assigned to and comments that don't mention him. (See
  // 2026-05-01 incident note in DEVLOG.)
  const subscribers = await tx.webhook.findMany({
    where: {
      workspaceId: params.workspaceId,
      active: true,
      events: { has: params.eventKind },
      NOT: { url: { startsWith: AGENT_DISPATCH_WEBHOOK_URL } },
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

  // (d) Chat — route to the agent the user is talking to.
  if (
    params.eventKind === EventKind.CHAT_MESSAGE_POSTED &&
    params.subjectType === "chat-thread"
  ) {
    const payload = params.payload as { agentId?: string; role?: string } | undefined;
    // Only dispatch on USER messages (don't loop agent's own posts back).
    if (payload?.agentId && payload?.role === "USER") {
      const agent = await tx.agent.findFirst({
        where: {
          workspaceId: params.workspaceId,
          id: payload.agentId,
          archivedAt: null,
          webhookUrl: { not: null },
        },
        select: { id: true },
      });
      if (agent) {
        const wid = await upsertAgentDispatchWebhook(
          tx,
          params.workspaceId,
          agentDispatchUrlFor(agent.id),
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
