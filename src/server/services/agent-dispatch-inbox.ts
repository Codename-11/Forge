import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { AgentRunStatus, EventKind } from "@prisma/client";
import { openOrTouchRun, appendRunEvent } from "@/server/services/agent-run";
import { publish } from "@/server/realtime";
import { nanoid } from "nanoid";

/**
 * Durable agent dispatch inbox.
 *
 * Replaces the "webhook delivery success = canonical work created"
 * coupling with a model where:
 *
 *   1. `ActivityEvent` insertion creates / touches a canonical work row
 *      in the same transaction (`AgentRun` for issue-routed events,
 *      `ChatMessage` for chat-routed events).
 *   2. `WebhookDelivery` rows are wake accelerators only — their HTTP
 *      success or failure bumps `lastWake*` diagnostics but does not
 *      create or remove canonical work.
 *   3. The runtime (Hermes, Claude Code, etc.) reads its inbox via MCP
 *      `agent.inbox.list`, acknowledges with `agent.inbox.ack`, marks
 *      output started, and works against `agent.context.bundle`.
 *
 * Webhooks remain the low-latency wake path; the inbox is the durable
 * recovery path for missed wakes, restarts, and stale chats.
 */

type Tx = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Canonical work creation (called from audit.recordChange).
// ---------------------------------------------------------------------------

export interface EnsureCanonicalParams {
  workspaceId: string;
  eventKind: EventKind;
  eventId: string;
  subjectType: string;
  subjectId: string;
  actorId: string | null;
  payload: unknown;
  /**
   * Agent ids the audit-fan-out already resolved for this event. Lets
   * us avoid re-running the same resolution queries on three branches
   * of (a)–(e).
   */
  resolvedAgentIds?: ReadonlyArray<string>;
}

export interface EnsureCanonicalResult {
  /** AgentRun ids created or touched (issue-routed branches). */
  issueRunIds: string[];
  /** ChatMessage ids touched (chat-routed branch). */
  chatMessageIds: string[];
}

const EMPTY_ENSURE: EnsureCanonicalResult = Object.freeze({
  issueRunIds: Object.freeze<string[]>([]) as string[],
  chatMessageIds: Object.freeze<string[]>([]) as string[],
});

/**
 * Ensures canonical work rows exist for the just-recorded ActivityEvent.
 * Idempotent; callers can invoke once per `recordChange` write.
 *
 * For issue-routed events (AGENT_ASSIGNED, ISSUE_QUEUED, mention
 * COMMENT_CREATED, ISSUE_PRIORITY_CHANGED, watcher fan-out) we call
 * `openOrTouchRun` once per resolved agent and stamp the trigger.
 *
 * For chat-routed CHAT_MESSAGE_POSTED USER turns the user's ChatMessage
 * row IS the canonical work — we just ensure its lifecycle fields are
 * at defaults (no-op when first inserted).
 */
export async function ensureCanonicalFromEvent(
  tx: Tx,
  params: EnsureCanonicalParams,
): Promise<EnsureCanonicalResult> {
  const agentIds = params.resolvedAgentIds ?? [];
  if (agentIds.length === 0) return EMPTY_ENSURE;

  if (params.subjectType === "issue") {
    return ensureIssueRuns(tx, params, agentIds);
  }
  if (
    params.subjectType === "chat-thread" &&
    params.eventKind === EventKind.CHAT_MESSAGE_POSTED
  ) {
    return ensureChatMessage(tx, params, agentIds);
  }
  return EMPTY_ENSURE;
}

async function ensureIssueRuns(
  tx: Tx,
  params: EnsureCanonicalParams,
  agentIds: ReadonlyArray<string>,
): Promise<EnsureCanonicalResult> {
  const isAssigned = params.eventKind === EventKind.AGENT_ASSIGNED;
  const runIds: string[] = [];
  for (const agentId of agentIds) {
    const { run } = await openOrTouchRun(tx, {
      workspaceId: params.workspaceId,
      issueId: params.subjectId,
      agentId,
      actorId: params.actorId,
      assignmentEventId: isAssigned ? params.eventId : null,
    });
    // Stamp the latest trigger on the run so the inbox can distinguish
    // "Victor was just re-mentioned in AXI-31" from "Victor is the
    // static assignee". For AGENT_ASSIGNED triggers we also write
    // assignmentEventId for backward-compat with required-ack queries
    // that haven't migrated to triggerEventId yet.
    await tx.agentRun.update({
      where: { id: run.id },
      data: {
        triggerEventId: params.eventId,
        triggerKind: params.eventKind,
        ...(isAssigned ? { assignmentEventId: params.eventId } : {}),
      },
    });
    runIds.push(run.id);
  }
  return { issueRunIds: runIds, chatMessageIds: [] };
}

async function ensureChatMessage(
  tx: Tx,
  params: EnsureCanonicalParams,
  agentIds: ReadonlyArray<string>,
): Promise<EnsureCanonicalResult> {
  // Chat dispatch addresses exactly one agent (the thread's agent). The
  // user ChatMessage row that triggered CHAT_MESSAGE_POSTED already
  // exists; we resolve it from the payload so we can stamp wake/ack
  // bookkeeping on it later. Nothing to insert here — this branch is a
  // no-op write-wise, but returning the messageId lets callers (worker,
  // tests) link wake telemetry to the right row.
  const payload = (params.payload as { messageId?: string } | null) ?? null;
  const messageId = typeof payload?.messageId === "string" ? payload.messageId : null;
  if (!messageId) return EMPTY_ENSURE;
  // Defensive workspace scope; also confirms the row exists.
  const msg = await tx.chatMessage.findFirst({
    where: { id: messageId, workspaceId: params.workspaceId },
    select: { id: true },
  });
  if (!msg) return EMPTY_ENSURE;
  void agentIds; // chat dispatch resolves the agent via thread.agentId
  return { issueRunIds: [], chatMessageIds: [msg.id] };
}

// ---------------------------------------------------------------------------
// Wake telemetry (called from worker on every delivery, success OR fail).
// ---------------------------------------------------------------------------

export interface RecordWakeParams {
  workspaceId: string;
  agentId: string;
  /** Pinpoint the canonical work unit. Exactly one branch must be set. */
  target:
    | { kind: "issue"; issueId: string }
    | { kind: "chat-message"; chatMessageId: string };
  deliveryId: string;
  eventId: string;
  eventKind: EventKind;
  /** True when the HTTP POST succeeded. */
  ok: boolean;
}

export interface RecordWakeResult {
  /** Updated AgentRun id (issue branch) or null. */
  runId: string | null;
  /** Updated ChatMessage id (chat branch) or null. */
  chatMessageId: string | null;
}

/**
 * Records a wake attempt against the canonical work row. Always
 * bumps `wakeAttempts` and `lastWakeAt` (regardless of HTTP success
 * — the goal is to surface "wake failed N times" in the diagnostic
 * rail). Successful wakes additionally append a timeline event so the
 * pulse strip stays informative.
 */
export async function recordWakeAttempt(
  tx: Tx,
  params: RecordWakeParams,
): Promise<RecordWakeResult> {
  if (params.target.kind === "issue") {
    // Find the ACTIVE run for (issue, agent). Created at event time;
    // missing only on legacy data or out-of-order delivery. We don't
    // create the run here — that's the audit path's job.
    const run = await tx.agentRun.findFirst({
      where: {
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        issueId: params.target.issueId,
        status: AgentRunStatus.ACTIVE,
      },
      orderBy: { startedAt: "desc" },
      select: { id: true, issueId: true },
    });
    if (!run) return { runId: null, chatMessageId: null };
    await tx.agentRun.update({
      where: { id: run.id },
      data: {
        lastWakeAt: new Date(),
        wakeAttempts: { increment: 1 },
        lastWakeDeliveryId: params.deliveryId,
      },
    });
    if (params.ok) {
      // Keep the timeline informative: a WAKE_DELIVERED event makes
      // "Victor got the wake at 14:23" visible without needing the
      // WebhookDelivery table.
      await appendRunEvent(tx, {
        runId: run.id,
        workspaceId: params.workspaceId,
        issueId: run.issueId,
        agentId: params.agentId,
        kind: "WAKE_DELIVERED",
        payload: {
          eventId: params.eventId,
          eventKind: params.eventKind,
          deliveryId: params.deliveryId,
        },
      });
    }
    return { runId: run.id, chatMessageId: null };
  }

  const msg = await tx.chatMessage.findFirst({
    where: {
      id: params.target.chatMessageId,
      workspaceId: params.workspaceId,
    },
    select: { id: true, threadId: true },
  });
  if (!msg) return { runId: null, chatMessageId: null };
  await tx.chatMessage.update({
    where: { id: msg.id },
    data: {
      lastWakeAt: new Date(),
      wakeAttempts: { increment: 1 },
      lastWakeDeliveryId: params.deliveryId,
    },
  });
  if (params.ok) {
    void publish({
      id: nanoid(),
      workspaceId: params.workspaceId,
      kind: EventKind.CHAT_MESSAGE_POSTED,
      subjectType: "chat-thread-wake",
      subjectId: msg.threadId,
      payload: {
        chatMessageId: msg.id,
        agentId: params.agentId,
        phase: "wake-delivered",
        deliveryId: params.deliveryId,
      },
      actorId: null,
      createdAt: new Date().toISOString(),
    });
  }
  return { runId: null, chatMessageId: msg.id };
}

// ---------------------------------------------------------------------------
// Ack + output-started (called from MCP agent.inbox.ack /
// agent.inbox.outputStarted, and from chat.startDraft).
// ---------------------------------------------------------------------------

export type InboxTarget =
  | { runId: string }
  | { chatMessageId: string };

/**
 * Marks the canonical work as acknowledged by the linked agent.
 * Validates that the calling agent owns the row; throws otherwise.
 * Idempotent — re-calling on an already-acked row is a no-op.
 */
export async function ackInboxItem(
  tx: Tx,
  params: {
    workspaceId: string;
    agentId: string;
    target: InboxTarget;
  },
): Promise<{ acknowledgedAt: Date; alreadyAcked: boolean }> {
  if ("runId" in params.target) {
    const run = await tx.agentRun.findFirst({
      where: {
        id: params.target.runId,
        workspaceId: params.workspaceId,
      },
      select: { id: true, agentId: true, issueId: true, acknowledgedAt: true },
    });
    if (!run) throw new InboxNotFoundError("run not found");
    if (run.agentId !== params.agentId) {
      throw new InboxForbiddenError("run belongs to a different agent");
    }
    if (run.acknowledgedAt) {
      return { acknowledgedAt: run.acknowledgedAt, alreadyAcked: true };
    }
    const now = new Date();
    await tx.agentRun.update({
      where: { id: run.id },
      data: { acknowledgedAt: now, lastEventAt: now },
    });
    await appendRunEvent(tx, {
      runId: run.id,
      workspaceId: params.workspaceId,
      issueId: run.issueId,
      agentId: params.agentId,
      kind: "ACK",
      payload: { acknowledgedAt: now.toISOString() },
    });
    return { acknowledgedAt: now, alreadyAcked: false };
  }

  const msg = await tx.chatMessage.findFirst({
    where: {
      id: params.target.chatMessageId,
      workspaceId: params.workspaceId,
    },
    select: {
      id: true,
      threadId: true,
      role: true,
      acknowledgedAt: true,
      thread: { select: { agentId: true } },
    },
  });
  if (!msg) throw new InboxNotFoundError("chat message not found");
  if (msg.role !== "USER") {
    throw new InboxForbiddenError("only USER messages can be acknowledged");
  }
  if (msg.thread.agentId !== params.agentId) {
    throw new InboxForbiddenError("chat thread belongs to a different agent");
  }
  if (msg.acknowledgedAt) {
    return { acknowledgedAt: msg.acknowledgedAt, alreadyAcked: true };
  }
  const now = new Date();
  await tx.chatMessage.update({
    where: { id: msg.id },
    data: { acknowledgedAt: now },
  });
  // Lightweight SSE-only signal so the chat panel can swap "wake sent"
  // → "acknowledged" without round-tripping a refetch.
  void publish({
    id: nanoid(),
    workspaceId: params.workspaceId,
    kind: EventKind.CHAT_MESSAGE_POSTED,
    subjectType: "chat-thread-ack",
    subjectId: msg.threadId,
    payload: {
      chatMessageId: msg.id,
      agentId: params.agentId,
      phase: "acknowledged",
    },
    actorId: null,
    createdAt: now.toISOString(),
  });
  return { acknowledgedAt: now, alreadyAcked: false };
}

/**
 * Marks the canonical work as having produced its first output. For
 * chat this is called from `chat.startDraft`; for runs it can be
 * called explicitly or is auto-set on the first non-ACK timeline event.
 * Idempotent.
 */
export async function markOutputStarted(
  tx: Tx,
  params: {
    workspaceId: string;
    agentId: string;
    target: InboxTarget;
  },
): Promise<{ outputStartedAt: Date; alreadyStarted: boolean }> {
  if ("runId" in params.target) {
    const run = await tx.agentRun.findFirst({
      where: { id: params.target.runId, workspaceId: params.workspaceId },
      select: { id: true, agentId: true, outputStartedAt: true },
    });
    if (!run) throw new InboxNotFoundError("run not found");
    if (run.agentId !== params.agentId) {
      throw new InboxForbiddenError("run belongs to a different agent");
    }
    if (run.outputStartedAt) {
      return { outputStartedAt: run.outputStartedAt, alreadyStarted: true };
    }
    const now = new Date();
    await tx.agentRun.update({
      where: { id: run.id },
      data: { outputStartedAt: now, lastEventAt: now },
    });
    return { outputStartedAt: now, alreadyStarted: false };
  }

  const msg = await tx.chatMessage.findFirst({
    where: {
      id: params.target.chatMessageId,
      workspaceId: params.workspaceId,
    },
    select: {
      id: true,
      role: true,
      outputStartedAt: true,
      thread: { select: { agentId: true } },
    },
  });
  if (!msg) throw new InboxNotFoundError("chat message not found");
  if (msg.role !== "USER") {
    throw new InboxForbiddenError("only USER messages track agent output");
  }
  if (msg.thread.agentId !== params.agentId) {
    throw new InboxForbiddenError("chat thread belongs to a different agent");
  }
  if (msg.outputStartedAt) {
    return { outputStartedAt: msg.outputStartedAt, alreadyStarted: true };
  }
  const now = new Date();
  await tx.chatMessage.update({
    where: { id: msg.id },
    data: { outputStartedAt: now },
  });
  return { outputStartedAt: now, alreadyStarted: false };
}

// ---------------------------------------------------------------------------
// Inbox listing (called from MCP agent.inbox.list).
// ---------------------------------------------------------------------------

export type InboxFilter = "unacked" | "active" | "stale" | "all";

export interface InboxRunItem {
  kind: "run";
  runId: string;
  workspaceId: string;
  agentId: string;
  issueId: string;
  status: AgentRunStatus;
  triggerEventId: string | null;
  triggerKind: string | null;
  startedAt: Date;
  lastEventAt: Date;
  acknowledgedAt: Date | null;
  outputStartedAt: Date | null;
  lastWakeAt: Date | null;
  wakeAttempts: number;
  lastWakeDeliveryId: string | null;
  dispatchState: DispatchState;
  issueSnapshot: {
    id: string;
    number: number;
    title: string;
    priority: string;
    statusId: string;
    projectId: string | null;
  };
  recommendedAction: RecommendedAction;
}

export interface InboxChatItem {
  kind: "chat";
  chatMessageId: string;
  workspaceId: string;
  agentId: string;
  threadId: string;
  body: string;
  acknowledgedAt: Date | null;
  outputStartedAt: Date | null;
  lastWakeAt: Date | null;
  wakeAttempts: number;
  lastWakeDeliveryId: string | null;
  createdAt: Date;
  dispatchState: DispatchState;
  recommendedAction: RecommendedAction;
}

export type InboxItem = InboxRunItem | InboxChatItem;

/**
 * Lists inbox items for the linked agent. Identity must already be
 * resolved (typically from `ctx.apiKey.linkedAgentId`). Results blend
 * AgentRun (issue-routed) + ChatMessage (chat-routed) work units and
 * carry derived lifecycle state so the agent can decide what to do
 * next without re-deriving in every receiver.
 */
export async function listInbox(
  client: Tx,
  params: {
    workspaceId: string;
    agentId: string;
    filter: InboxFilter;
    limit: number;
    staleAfterSeconds?: number;
    /**
     * ApiKey scope narrowing. Empty arrays = no narrowing on that
     * dimension. Mirrors the existing ApiKey.projectIds / labelIds
     * semantics so a sub-agent key only sees its slice.
     */
    scope?: {
      projectIds?: string[];
      labelIds?: string[];
      initiativeIds?: string[];
    };
  },
): Promise<InboxItem[]> {
  const limit = Math.max(1, Math.min(100, params.limit));
  const staleMs = (params.staleAfterSeconds ?? 600) * 1000;
  const now = Date.now();

  const runWhere: Prisma.AgentRunWhereInput = {
    workspaceId: params.workspaceId,
    agentId: params.agentId,
    status: AgentRunStatus.ACTIVE,
  };
  if (params.filter === "unacked") runWhere.acknowledgedAt = null;
  if (params.filter === "stale") {
    runWhere.acknowledgedAt = null;
    runWhere.lastEventAt = { lt: new Date(now - staleMs) };
  }

  const scope = params.scope ?? {};
  const issueWhere: Prisma.IssueWhereInput = {};
  if (scope.projectIds && scope.projectIds.length > 0) {
    issueWhere.projectId = { in: scope.projectIds };
  }
  if (scope.labelIds && scope.labelIds.length > 0) {
    issueWhere.labels = { some: { labelId: { in: scope.labelIds } } };
  }
  if (scope.initiativeIds && scope.initiativeIds.length > 0) {
    issueWhere.project = { initiativeId: { in: scope.initiativeIds } };
  }
  if (Object.keys(issueWhere).length > 0) {
    runWhere.issue = issueWhere;
  }

  const [runs, chatMessages] = await Promise.all([
    client.agentRun.findMany({
      where: runWhere,
      orderBy: { lastEventAt: "desc" },
      take: limit,
      select: {
        id: true,
        workspaceId: true,
        agentId: true,
        issueId: true,
        status: true,
        triggerEventId: true,
        triggerKind: true,
        startedAt: true,
        lastEventAt: true,
        acknowledgedAt: true,
        outputStartedAt: true,
        lastWakeAt: true,
        wakeAttempts: true,
        lastWakeDeliveryId: true,
        issue: {
          select: {
            id: true,
            number: true,
            title: true,
            priority: true,
            statusId: true,
            projectId: true,
          },
        },
      },
    }),
    listChatInbox(client, params, limit, staleMs),
  ]);

  const runItems: InboxRunItem[] = runs.map((r) => {
    const state = deriveRunDispatchState({
      acknowledgedAt: r.acknowledgedAt,
      outputStartedAt: r.outputStartedAt,
      lastWakeAt: r.lastWakeAt,
      lastEventAt: r.lastEventAt,
      status: r.status,
      now,
      staleMs,
    });
    return {
      kind: "run",
      runId: r.id,
      workspaceId: r.workspaceId,
      agentId: r.agentId,
      issueId: r.issueId,
      status: r.status,
      triggerEventId: r.triggerEventId,
      triggerKind: r.triggerKind,
      startedAt: r.startedAt,
      lastEventAt: r.lastEventAt,
      acknowledgedAt: r.acknowledgedAt,
      outputStartedAt: r.outputStartedAt,
      lastWakeAt: r.lastWakeAt,
      wakeAttempts: r.wakeAttempts,
      lastWakeDeliveryId: r.lastWakeDeliveryId,
      dispatchState: state,
      issueSnapshot: {
        id: r.issue.id,
        number: r.issue.number,
        title: r.issue.title,
        priority: r.issue.priority,
        statusId: r.issue.statusId,
        projectId: r.issue.projectId,
      },
      recommendedAction: recommendedActionFor(state),
    };
  });

  return [...runItems, ...chatMessages].sort((a, b) => {
    const aT = (a.kind === "run" ? a.lastEventAt : a.createdAt).getTime();
    const bT = (b.kind === "run" ? b.lastEventAt : b.createdAt).getTime();
    return bT - aT;
  });
}

async function listChatInbox(
  client: Tx,
  params: {
    workspaceId: string;
    agentId: string;
    filter: InboxFilter;
  },
  limit: number,
  staleMs: number,
): Promise<InboxChatItem[]> {
  // Chat scope: USER messages on threads addressed to this agent that
  // are still pending an agent reply. "Pending" = the row's
  // `acknowledgedAt` is null AND no later AGENT message has been
  // posted in the same thread (cheap heuristic via lastMessageAt).
  // For v1 we trust the row state.
  const now = Date.now();
  const where: Prisma.ChatMessageWhereInput = {
    workspaceId: params.workspaceId,
    role: "USER",
    thread: { agentId: params.agentId },
  };
  if (params.filter === "unacked") {
    where.acknowledgedAt = null;
  } else if (params.filter === "stale") {
    where.acknowledgedAt = null;
    where.createdAt = { lt: new Date(now - staleMs) };
  } else if (params.filter === "active") {
    // active = not acked OR acked but not yet output. Drop terminal
    // chats where a subsequent AGENT message exists.
    where.OR = [{ acknowledgedAt: null }, { outputStartedAt: null }];
  }
  // "all" leaves where as-is (still scoped to USER role + agent).

  const messages = await client.chatMessage.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      workspaceId: true,
      threadId: true,
      body: true,
      acknowledgedAt: true,
      outputStartedAt: true,
      lastWakeAt: true,
      wakeAttempts: true,
      lastWakeDeliveryId: true,
      createdAt: true,
      dispatchedAt: true,
      thread: { select: { agentId: true } },
    },
  });

  return messages
    .filter((m) => m.dispatchedAt !== null)
    .map((m) => {
      const state = deriveChatDispatchState({
        acknowledgedAt: m.acknowledgedAt,
        outputStartedAt: m.outputStartedAt,
        lastWakeAt: m.lastWakeAt,
        createdAt: m.createdAt,
        now,
        staleMs,
      });
      return {
        kind: "chat",
        chatMessageId: m.id,
        workspaceId: m.workspaceId,
        agentId: m.thread.agentId,
        threadId: m.threadId,
        body: m.body,
        acknowledgedAt: m.acknowledgedAt,
        outputStartedAt: m.outputStartedAt,
        lastWakeAt: m.lastWakeAt,
        wakeAttempts: m.wakeAttempts,
        lastWakeDeliveryId: m.lastWakeDeliveryId,
        createdAt: m.createdAt,
        dispatchState: state,
        recommendedAction: recommendedActionFor(state),
      } satisfies InboxChatItem;
    });
}

// ---------------------------------------------------------------------------
// Dispatch state derivation.
// ---------------------------------------------------------------------------

export type DispatchState =
  | "queued"
  | "wake-sent"
  | "acknowledged"
  | "running"
  | "stalled"
  | "completed"
  | "abandoned";

export type RecommendedAction =
  | "wait"
  | "retry-wake"
  | "kick"
  | "abandon"
  | "none";

interface RunStateInput {
  acknowledgedAt: Date | null;
  outputStartedAt: Date | null;
  lastWakeAt: Date | null;
  lastEventAt: Date;
  status: AgentRunStatus;
  now: number;
  staleMs: number;
}

export function deriveRunDispatchState(input: RunStateInput): DispatchState {
  if (input.status === AgentRunStatus.COMPLETED) return "completed";
  if (input.status === AgentRunStatus.ABANDONED) return "abandoned";
  if (input.status === AgentRunStatus.STALLED) return "stalled";
  if (input.outputStartedAt) return "running";
  if (input.acknowledgedAt) {
    if (input.now - input.lastEventAt.getTime() > input.staleMs) return "stalled";
    return "acknowledged";
  }
  if (input.lastWakeAt) {
    if (input.now - input.lastWakeAt.getTime() > input.staleMs) return "stalled";
    return "wake-sent";
  }
  return "queued";
}

interface ChatStateInput {
  acknowledgedAt: Date | null;
  outputStartedAt: Date | null;
  lastWakeAt: Date | null;
  createdAt: Date;
  now: number;
  staleMs: number;
}

export function deriveChatDispatchState(input: ChatStateInput): DispatchState {
  if (input.outputStartedAt) return "running";
  if (input.acknowledgedAt) {
    if (input.now - input.acknowledgedAt.getTime() > input.staleMs) return "stalled";
    return "acknowledged";
  }
  if (input.lastWakeAt) {
    if (input.now - input.lastWakeAt.getTime() > input.staleMs) return "stalled";
    return "wake-sent";
  }
  if (input.now - input.createdAt.getTime() > input.staleMs) return "stalled";
  return "queued";
}

function recommendedActionFor(state: DispatchState): RecommendedAction {
  switch (state) {
    case "queued":
    case "wake-sent":
      return "retry-wake";
    case "acknowledged":
    case "running":
      return "wait";
    case "stalled":
      return "kick";
    case "completed":
    case "abandoned":
      return "none";
  }
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export class InboxNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxNotFoundError";
  }
}

export class InboxForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxForbiddenError";
  }
}
