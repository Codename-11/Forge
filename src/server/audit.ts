import "server-only";
import type { AgentProvider, Prisma, PrismaClient, RunEngine } from "@prisma/client";
import { EventKind } from "@prisma/client";
import { publish } from "@/server/realtime";
import { db } from "@/server/db";
import { RUNTIME_KIND_LABEL } from "@/lib/runtime-kind";
import { runtimeToolSurface } from "@/lib/runtime-tools";
import { nanoid } from "nanoid";
import { ensureCanonicalFromEvent } from "@/server/services/agent-dispatch-inbox";
import {
  resolveRunEngine,
  getRunsConnectorForAgent,
  type AgentRuntimeRef,
} from "@/server/services/dispatch/registry";
import {
  ALERTABLE_EVENT_KINDS,
  scheduleEventNotificationFanout,
} from "@/server/services/notifications";

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

function mentionedAgentIdsFromPayload(payloadIn: unknown): string[] {
  const payload = payloadIn as
    | {
        mentions?:
          | {
              agentIds?: unknown[];
              agents?: Array<{ agentId?: unknown }>;
            }
          | Array<{ agentId?: unknown }>;
      }
    | undefined;
  const mentionsRaw = payload?.mentions;
  if (Array.isArray(mentionsRaw)) {
    return mentionsRaw
      .map((m) => m.agentId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  if (mentionsRaw && typeof mentionsRaw === "object") {
    if (Array.isArray(mentionsRaw.agentIds)) {
      return mentionsRaw.agentIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      );
    }
    if (Array.isArray(mentionsRaw.agents)) {
      return mentionsRaw.agents
        .map((m) => m.agentId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    }
  }
  return [];
}

const AGENT_WATCHER_FANOUT_EVENT_KINDS = new Set<EventKind>([
  EventKind.COMMENT_CREATED,
  EventKind.ISSUE_PRIORITY_CHANGED,
  EventKind.ISSUE_STALLED,
  EventKind.ISSUE_SLA_BREACH,
  EventKind.ISSUE_NUDGED,
]);

const ENGAGEMENT_MODE_LABEL: Record<string, string> = {
  EXECUTE: "EXECUTE",
  RESEARCH: "RESEARCH",
  REVIEW: "REVIEW",
  DISCUSS: "DISCUSS",
};

const ENGAGEMENT_MODE_HINT: Record<string, string> = {
  EXECUTE: "can modify and complete work",
  RESEARCH: "investigate and report",
  REVIEW: "instructions only",
  DISCUSS: "discussion only",
};

function payloadRecord(payload: Prisma.InputJsonValue): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function payloadBool(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

function modeLabel(mode: string | null): string | null {
  return mode ? (ENGAGEMENT_MODE_LABEL[mode] ?? mode) : null;
}

function modeHint(mode: string | null): string | null {
  return mode ? (ENGAGEMENT_MODE_HINT[mode] ?? null) : null;
}

function adapterLabel(adapterKey: string | null | undefined): string | null {
  if (!adapterKey) return null;
  return adapterKey
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function isRunsDrivenAgent(agent: {
  provider: AgentProvider;
  runEngine: RunEngine | null;
  runtime?: AgentRuntimeRef;
}): boolean {
  if (!agent.runtime?.adapterKey && agent.runEngine !== "RUNS") return false;
  return (
    resolveRunEngine({
      runEngine: agent.runEngine,
      provider: agent.provider,
      runtime: agent.runtime,
    }) === "RUNS" &&
    getRunsConnectorForAgent({ provider: agent.provider, runtime: agent.runtime }) != null
  );
}

type AssignmentAgentContext = {
  id: string;
  profileKey: string;
  provider: string;
  webhookUrl: string | null;
  runtime: {
    id: string;
    name: string;
    kind: string;
    adapterKey: string | null;
    config: Prisma.JsonValue | null;
  } | null;
};

function assignmentRuntimeLine(agent: AssignmentAgentContext): string | null {
  if (agent.runtime) {
    const adapterKey =
      agent.runtime.adapterKey ?? (agent.runtime.kind === "LOCAL_DAEMON" ? "local-daemon" : null);
    const surface = runtimeToolSurface(adapterKey, agent.runtime.config);
    const runtimeName = agent.runtime.name || adapterLabel(agent.runtime.adapterKey);
    const runtimeKind = RUNTIME_KIND_LABEL[agent.runtime.kind as keyof typeof RUNTIME_KIND_LABEL];
    const isHermesRuntime = agent.provider === "HERMES" && agent.runtime.adapterKey === "hermes";
    const toolText = isHermesRuntime
      ? "tools from Hermes host"
      : agent.runtime.kind === "LOCAL_DAEMON"
        ? "tools from local daemon"
        : surface.hasRepoTools
          ? "repo tools declared"
          : "repo tools not declared";
    return [runtimeName, runtimeKind, toolText].filter(Boolean).join(" · ");
  }
  if (agent.webhookUrl) return "webhook receiver · tools from webhook receiver";
  return null;
}

function assignmentRuntimePayload(agent: AssignmentAgentContext): Prisma.InputJsonObject | null {
  if (agent.runtime) {
    const adapterKey =
      agent.runtime.adapterKey ?? (agent.runtime.kind === "LOCAL_DAEMON" ? "local-daemon" : null);
    const surface = runtimeToolSurface(adapterKey, agent.runtime.config);
    const kind = RUNTIME_KIND_LABEL[agent.runtime.kind as keyof typeof RUNTIME_KIND_LABEL];
    const isHermesRuntime = agent.provider === "HERMES" && agent.runtime.adapterKey === "hermes";
    return {
      id: agent.runtime.id,
      name: agent.runtime.name,
      kind: kind ?? agent.runtime.kind,
      adapterKey: agent.runtime.adapterKey,
      tools: isHermesRuntime
        ? "tools from Hermes host"
        : agent.runtime.kind === "LOCAL_DAEMON"
          ? "tools from local daemon"
          : surface.hasRepoTools
            ? "repo tools declared"
            : "repo tools not declared",
      ...(surface.workspaceRoot ? { workspaceRoot: surface.workspaceRoot } : {}),
    };
  }
  if (agent.webhookUrl) {
    return {
      name: "webhook receiver",
      kind: "webhook",
      adapterKey: null,
      tools: "tools from webhook receiver",
    };
  }
  return null;
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
  engagementMode?: string,
): Promise<string | null> {
  // Engagement modes (AXI-53): only EXECUTE auto-starts the issue. A RESEARCH /
  // REVIEW / DISCUSS assignment must leave status alone. Absent = legacy
  // EXECUTE behaviour.
  if (engagementMode && engagementMode !== "EXECUTE") return null;
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
        EventKind.ISSUE_STALLED,
        EventKind.ISSUE_SLA_BREACH,
        EventKind.ISSUE_NUDGED,
        EventKind.CHAT_MESSAGE_POSTED,
        EventKind.AGENT_RUN_BLOCKED,
      ],
      active: true,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Post a SYSTEM-kind `Comment` row to the issue thread for an
 * AGENT_ASSIGNED event, so the conversation surface acknowledges the
 * assignment inline rather than waiting for the agent's first reply.
 *
 * - Skips when `agentId` is null (unassignment) or matches the
 *   previous assignee (no-op re-assignment).
 * - Skips when the assigned agent row can't be loaded (race).
 * - Writes directly via `tx.comment.create` — does NOT call
 *   `recordChange`, so this comment doesn't trigger another
 *   COMMENT_CREATED fan-out (which would re-page watchers + the
 *   agent's own webhook). The activity stream still picks it up
 *   through the AGENT_ASSIGNED ActivityEvent that's about to land
 *   in the same transaction.
 *
 * Idempotent in practice: the issue.update path only emits
 * AGENT_ASSIGNED when the assignee actually changes, so we don't
 * paper over duplicate posts here.
 */
async function maybeWriteAssignmentSystemComment(
  tx: PrismaClient | Prisma.TransactionClient,
  params: {
    workspaceId: string;
    issueId: string;
    payload: Prisma.InputJsonValue;
    actorId: string | null;
    agentContext?: AssignmentAgentContext | null;
  },
): Promise<void> {
  const payload = payloadRecord(params.payload);
  const agentId = payloadString(payload, "agentId");
  const previousAgentId = payloadString(payload, "previousAgentId");
  const modeUpdated = payloadBool(payload, "modeUpdated");
  const engagementMode = payloadString(payload, "engagementMode");
  if (!agentId) return; // unassignment — nothing to announce
  if (agentId === previousAgentId && !modeUpdated) return; // no-op re-assignment

  const agent =
    params.agentContext ??
    (await tx.agent.findFirst({
      where: { id: agentId, workspaceId: params.workspaceId },
      select: {
        id: true,
        profileKey: true,
        provider: true,
        webhookUrl: true,
        runtime: { select: { id: true, name: true, kind: true, adapterKey: true, config: true } },
      },
    }));
  if (!agent) return; // defensive — agent disappeared mid-transaction

  const actor = params.actorId
    ? await tx.user.findUnique({
        where: { id: params.actorId },
        select: { name: true, handle: true },
      })
    : null;
  const actorLabel = actor?.name ?? actor?.handle ?? "the system";

  const mode = modeLabel(engagementMode);
  const hint = modeHint(engagementMode);
  const modePhrase = mode ? ` in **${mode}** mode${hint ? ` (${hint})` : ""}` : "";
  const runtimeLabel = assignmentRuntimeLine(agent);

  const headline =
    modeUpdated && agentId === previousAgentId
      ? `**@${agent.profileKey}** work mode changed${modePhrase} by **@${actorLabel}**.`
      : `**@${agent.profileKey}** was assigned${modePhrase} by **@${actorLabel}**.`;

  const body = headline + (runtimeLabel ? `\n\n_Runtime: ${runtimeLabel}._` : "");

  await tx.comment.create({
    data: {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      authorId: null,
      authoringAgentId: null,
      body,
      kind: "SYSTEM",
    },
  });
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
    /**
     * When the action came through an agent-linked API key, the Agent is
     * the recorded actor; `actorId` stays the human key-owner as secondary
     * metadata. Null for human-driven / pure-system actions. Callers pass
     * `ctx.apiKey?.linkedAgentId ?? null`.
     */
    actorAgentId?: string | null;
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
      actorAgentId: params.actorAgentId ?? null,
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
  let payloadOut: Prisma.InputJsonValue = (params.payload ?? {}) as Prisma.InputJsonValue;
  if (params.eventKind === EventKind.AGENT_ASSIGNED && params.subjectType === "issue") {
    const assignMode =
      params.payload && typeof params.payload === "object" && !Array.isArray(params.payload)
        ? ((params.payload as Record<string, unknown>).engagementMode as string | undefined)
        : undefined;
    const transitionedTo = await maybeAutoTransitionOnAssign(
      tx,
      params.workspaceId,
      params.subjectId,
      assignMode,
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

    const assignmentPayload = payloadRecord(payloadOut);
    const assignedAgentId = payloadString(assignmentPayload, "agentId");
    const assignmentAgentContext = assignedAgentId
      ? await tx.agent.findFirst({
          where: { id: assignedAgentId, workspaceId: params.workspaceId },
          select: {
            id: true,
            profileKey: true,
            provider: true,
            webhookUrl: true,
            runtime: {
              select: { id: true, name: true, kind: true, adapterKey: true, config: true },
            },
          },
        })
      : null;
    const runtimePayload = assignmentAgentContext
      ? assignmentRuntimePayload(assignmentAgentContext)
      : null;
    if (runtimePayload) {
      payloadOut = {
        ...payloadRecord(payloadOut),
        runtime: runtimePayload,
      } as unknown as Prisma.InputJsonValue;
    }

    // SYSTEM comment: a small in-thread note ("victor was assigned by
    // Bailey. Runtime: local daemon.") so the issue conversation surface
    // doesn't look dead between assignment and the agent's first reply.
    // Hermes-managed agents historically had no inline acknowledgement
    // here — forge-cli daemons posted a starter comment, but everyone
    // else didn't. Writing this directly via `tx.comment.create` (not
    // through `comment.create`'s recordChange path) means we don't
    // re-emit COMMENT_CREATED and don't re-fan-out to watchers /
    // webhooks. Skip re-assignment to the same agent (no churn) and
    // unassignment (`agentId == null`).
    await maybeWriteAssignmentSystemComment(tx, {
      workspaceId: params.workspaceId,
      issueId: params.subjectId,
      payload: payloadOut,
      actorId: params.actorId,
      agentContext: assignmentAgentContext,
    });
  }

  const event = await tx.activityEvent.create({
    data: {
      workspaceId: params.workspaceId,
      kind: params.eventKind,
      actorId: params.actorId,
      actorAgentId: params.actorAgentId ?? null,
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
  //
  // `resolvedAgentIds` accumulates the actual agent ids touched in
  // branches (a)–(e). They're passed to `ensureCanonicalFromEvent`
  // after the activity write so the durable inbox row (AgentRun for
  // issue subjects, ChatMessage for chat subjects) is created in the
  // same transaction as the ActivityEvent. Webhook delivery success or
  // failure becomes a wake diagnostic only — canonical work exists
  // either way.
  const agentWebhookIds: string[] = [];
  const resolvedAgentIds: string[] = [];

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
      select: {
        assignedAgentId: true,
        assignedAgent: {
          select: {
            id: true,
            webhookUrl: true,
            provider: true,
            runEngine: true,
            runtime: {
              select: {
                adapterKey: true,
                endpoint: true,
                secret: true,
                config: true,
                disabledAt: true,
                name: true,
              },
            },
          },
        },
      },
    });
    if (issue?.assignedAgentId) {
      // Always record the canonical resolution — even if the agent has
      // no webhookUrl, the inbox row should exist so the agent can poll
      // and pick up the work (the v1 "missed wake recovery" path).
      resolvedAgentIds.push(issue.assignedAgentId);
      const a = issue.assignedAgent;
      // RUNS-engine agents are driven directly via the provider's
      // agent-run API by the worker (`runs-dispatch-sweep`); skip the
      // webhook so they aren't dispatched twice.
      const runsDriven = !!a && isRunsDrivenAgent(a);
      if (a?.webhookUrl && !runsDriven) {
        const wid = await upsertAgentDispatchWebhook(
          tx,
          params.workspaceId,
          AGENT_DISPATCH_WEBHOOK_URL,
        );
        agentWebhookIds.push(wid);
      }
    }
  }

  // (b) Priority escalations (HIGH / URGENT) on an assigned issue — push
  //     to the assignee via a per-agent shim so the delivery carries its
  //     own target id (doesn't re-resolve the issue's assignee later).
  if (params.eventKind === EventKind.ISSUE_PRIORITY_CHANGED && params.subjectType === "issue") {
    const to = (params.payload as { to?: string } | undefined)?.to;
    if (to === "HIGH" || to === "URGENT") {
      const issue = await tx.issue.findUnique({
        where: { id: params.subjectId },
        select: {
          assignedAgentId: true,
          assignedAgent: {
            select: {
              id: true,
              webhookUrl: true,
              provider: true,
              runEngine: true,
              runtime: {
                select: {
                  adapterKey: true,
                  endpoint: true,
                  secret: true,
                  config: true,
                  disabledAt: true,
                  name: true,
                },
              },
            },
          },
        },
      });
      if (issue?.assignedAgentId) {
        resolvedAgentIds.push(issue.assignedAgentId);
        if (issue.assignedAgent?.webhookUrl && !isRunsDrivenAgent(issue.assignedAgent)) {
          const wid = await upsertAgentDispatchWebhook(
            tx,
            params.workspaceId,
            agentDispatchUrlFor(issue.assignedAgentId),
          );
          agentWebhookIds.push(wid);
        }
      }
    }
  }

  // (c) Comment @mentions — one delivery per mentioned agent, each against
  //     its own per-agent shim so the worker pushes to the right webhookUrl
  //     instead of the issue's assigned agent. Reads the new structured
  //     `mentions: { agentIds, userIds }` shape with a fallback to the
  //     legacy `mentions: Array<{ agentId }>` shape for any in-flight
  //     events still carrying the old payload. Human user-mentions
  //     (`mentions.userIds`) don't trigger a webhook here — humans aren't
  //     webhooks — but the payload still propagates to ActivityEvent so
  //     downstream surfaces (notification materializer, inbox) can read
  //     it for involvement detection / watcher gating.
  //     COMMENT_UPDATED is ALSO handled here, but ONLY when the payload
  //     carries `edited: true` (a body edit via `comment.update`). In
  //     that case `mentions.agentIds` is the DIFF — agents newly added
  //     by the edit — so editing a comment to add `@victor` triggers him
  //     once, while pre-existing mentions stay quiet. Rolling STATUS
  //     comment updates also emit COMMENT_UPDATED but WITHOUT `edited`,
  //     so they never reach this branch and never re-page on every
  //     heartbeat.
  const isCommentMentionEvent =
    (params.eventKind === EventKind.COMMENT_CREATED ||
      (params.eventKind === EventKind.COMMENT_UPDATED &&
        (params.payload as { edited?: boolean } | undefined)?.edited === true)) &&
    params.subjectType === "issue";
  if (isCommentMentionEvent) {
    // Normalize to a flat list of agent ids regardless of incoming shape.
    const mentionedAgentIds = mentionedAgentIdsFromPayload(params.payload);
    if (mentionedAgentIds.length) {
      // Load mentioned agents within workspace scope. We canonicalize
      // every mentioned active agent into the inbox so the operator's
      // intent is recoverable; webhook delivery is created only for
      // agents that have a configured webhookUrl.
      const agents = await tx.agent.findMany({
        where: {
          workspaceId: params.workspaceId,
          id: { in: mentionedAgentIds },
          archivedAt: null,
        },
        select: {
          id: true,
          webhookUrl: true,
          provider: true,
          runEngine: true,
          runtime: {
            select: {
              adapterKey: true,
              endpoint: true,
              secret: true,
              config: true,
              disabledAt: true,
              name: true,
            },
          },
        },
      });
      for (const a of agents) {
        resolvedAgentIds.push(a.id);
        if (a.webhookUrl && !isRunsDrivenAgent(a)) {
          const wid = await upsertAgentDispatchWebhook(
            tx,
            params.workspaceId,
            agentDispatchUrlFor(a.id),
          );
          agentWebhookIds.push(wid);
        }
      }
    }
  }

  // (d) Chat — route to the agent the user is talking to.
  if (params.eventKind === EventKind.CHAT_MESSAGE_POSTED && params.subjectType === "chat-thread") {
    const payload = params.payload as
      | { agentId?: string; role?: string; streamed?: boolean }
      | undefined;
    // Skip dispatch when the interactive streaming path (/api/chat/stream)
    // is already handling this user turn — the audit + activity-event row
    // still gets emitted (for consistency across consumers) but we must
    // not queue a Hermes webhook delivery or we'll get a duplicate reply.
    const isStreamed = payload?.streamed === true;
    // Only dispatch on USER messages (don't loop agent's own posts back).
    if (!isStreamed && payload?.agentId && payload?.role === "USER") {
      const agent = await tx.agent.findFirst({
        where: {
          workspaceId: params.workspaceId,
          id: payload.agentId,
          archivedAt: null,
        },
        select: { id: true, webhookUrl: true },
      });
      if (agent) {
        resolvedAgentIds.push(agent.id);
        if (agent.webhookUrl) {
          const wid = await upsertAgentDispatchWebhook(
            tx,
            params.workspaceId,
            agentDispatchUrlFor(agent.id),
          );
          agentWebhookIds.push(wid);
        }
      }
    }
  }

  // (d2) AGENT_RUN_BLOCKED — the agent itself just flipped a run to
  //      WAITING via `runs.setWaiting({ blocking: true })`. Route the
  //      event back to the agent's own webhook so the runtime sees its
  //      block confirmed (useful for receipts / acks). Subject is the
  //      agent-run row; we resolve the owning agent from the payload's
  //      `agentId`. Also surfaces the event in the standard agent
  //      activity feed via the normal ActivityEvent write that already
  //      happened above.
  if (params.eventKind === EventKind.AGENT_RUN_BLOCKED && params.subjectType === "agent-run") {
    const payload = params.payload as { agentId?: string } | undefined;
    const blockedAgentId =
      typeof payload?.agentId === "string" && payload.agentId.length > 0 ? payload.agentId : null;
    if (blockedAgentId) {
      const agent = await tx.agent.findFirst({
        where: {
          workspaceId: params.workspaceId,
          id: blockedAgentId,
          archivedAt: null,
        },
        select: { id: true, webhookUrl: true },
      });
      if (agent) {
        resolvedAgentIds.push(agent.id);
        if (agent.webhookUrl) {
          const wid = await upsertAgentDispatchWebhook(
            tx,
            params.workspaceId,
            agentDispatchUrlFor(agent.id),
          );
          agentWebhookIds.push(wid);
        }
      }
    }
  }

  // (e) Watchers — for actionable issue-subject events, fan out to every
  //     subscribed agent watcher whose webhook is configured. Skip
  //     the actor's own row to avoid self-paging. Human watchers
  //     don't need a synthetic webhook — they're served by the
  //     inbox / notification surfaces. Agent watchers are routed
  //     through the same per-agent shim used for comment @mentions.
  //
  //     Deliberately exclude low-signal lifecycle/status churn from the
  //     durable agent inbox. A watched issue transitioning status or a
  //     rolling STATUS comment update may be useful UI timeline context,
  //     but it is not new work for the agent; opening/touching an
  //     AgentRun here makes completed/no-op turns age into "stalled".
  //
  //     ISSUE_WATCHED / ISSUE_UNWATCHED would create a self-feedback
  //     loop, so they're explicitly excluded if added later. (Today
  //     no such EventKind values exist — watch/unwatch tRPC procs
  //     intentionally don't emit events.)
  // A body edit (COMMENT_UPDATED with `edited: true`) deliberately does
  // NOT fan out to all watchers — that would re-page every stakeholder
  // on a typo fix. Edits route ONLY through branch (c)'s mention DIFF,
  // so just the agents newly @mentioned by the edit are triggered.
  const watcherPayload = params.payload as
    | { edited?: boolean; kind?: string; agentId?: string }
    | undefined;
  const isCommentEdit =
    params.eventKind === EventKind.COMMENT_UPDATED && watcherPayload?.edited === true;
  const isRollingStatusComment =
    (params.eventKind === EventKind.COMMENT_CREATED ||
      params.eventKind === EventKind.COMMENT_UPDATED) &&
    watcherPayload?.kind === "STATUS";
  const isAgentWatcherFanoutEvent =
    params.subjectType === "issue" &&
    AGENT_WATCHER_FANOUT_EVENT_KINDS.has(params.eventKind) &&
    !isCommentEdit &&
    !isRollingStatusComment;
  if (isAgentWatcherFanoutEvent) {
    const mentionedAgentIds = new Set(mentionedAgentIdsFromPayload(params.payload));
    const currentIssue =
      params.eventKind === EventKind.COMMENT_CREATED
        ? await tx.issue.findUnique({
            where: { id: params.subjectId },
            select: { assignedAgentId: true },
          })
        : null;
    const watchers = await tx.issueWatcher.findMany({
      where: {
        workspaceId: params.workspaceId,
        issueId: params.subjectId,
        agentId: { not: null },
      },
      select: {
        agentId: true,
        wakeOnActivity: true,
        agent: {
          select: {
            id: true,
            webhookUrl: true,
            provider: true,
            runEngine: true,
            runtime: {
              select: {
                adapterKey: true,
                endpoint: true,
                secret: true,
                config: true,
                disabledAt: true,
                name: true,
              },
            },
          },
        },
      },
    });
    for (const w of watchers) {
      if (!w.agent) continue;
      // Body comments should wake the assigned agent and explicit @mentions.
      // Former assignees can remain sticky watchers; that stale watcher row
      // should not become fresh canonical work after reassignment.
      if (
        params.eventKind === EventKind.COMMENT_CREATED &&
        currentIssue?.assignedAgentId !== w.agent.id &&
        !mentionedAgentIds.has(w.agent.id)
      ) {
        continue;
      }
      if (params.eventKind !== EventKind.COMMENT_CREATED && !w.wakeOnActivity) {
        continue;
      }
      // Don't fan out the actor's own action back to themselves —
      // when an agent comments and is also a watcher, the COMMENT_CREATED
      // already routes via the assigned-agent + mention shims. Watcher
      // fan-out is for OTHER stakeholders.
      // Note: actorId is a User id, agentId is an Agent id; equality
      // is impossible. We instead detect agent-as-actor via the
      // payload's `agentId` field when present.
      const payloadAgentId = (params.payload as { agentId?: string } | undefined)?.agentId;
      if (payloadAgentId && payloadAgentId === w.agent.id) continue;
      resolvedAgentIds.push(w.agent.id);
      if (w.agent.webhookUrl && !isRunsDrivenAgent(w.agent)) {
        const wid = await upsertAgentDispatchWebhook(
          tx,
          params.workspaceId,
          agentDispatchUrlFor(w.agent.id),
        );
        agentWebhookIds.push(wid);
      }
    }
  }

  // Durable inbox: open / touch the canonical AgentRun (issue subject)
  // or ChatMessage (chat-thread subject) for every agent the branches
  // above resolved. Done in the same transaction as the ActivityEvent
  // so a worker crash / missed wake never leaves a wake hanging
  // without a recoverable work row. Dedupe agents in case multiple
  // branches resolved the same id (e.g. AGENT_ASSIGNED + watcher).
  const uniqueResolvedAgentIds = Array.from(new Set(resolvedAgentIds));
  if (uniqueResolvedAgentIds.length > 0) {
    await ensureCanonicalFromEvent(tx, {
      workspaceId: params.workspaceId,
      eventKind: params.eventKind,
      eventId: event.id,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      actorId: params.actorId,
      actorAgentId: params.actorAgentId ?? null,
      payload: payloadOut,
      resolvedAgentIds: uniqueResolvedAgentIds,
    });
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

  if (ALERTABLE_EVENT_KINDS.includes(event.kind)) {
    scheduleEventNotificationFanout(db, {
      workspaceId: event.workspaceId,
      eventId: event.id,
    });
  }
}
