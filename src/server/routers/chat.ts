import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  AgentProvider,
  AgentRunStatus,
  ChatContextMode,
  ChatRole,
  EventKind,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { STALE_RUN_MS } from "@/server/services/agent-presence";
import { deliverWebhook } from "@/server/services/plugin-runtime";
import { compactChatThread } from "@/server/services/chat-compaction";
import { resolveChatReadiness } from "@/server/services/chat-readiness";
import { workspaceChatProviderAvailability } from "@/server/services/ai-providers";
import { getRunsConnectorForAgent } from "@/server/services/dispatch/registry";
import { finishRun } from "@/server/services/agent-run";
import { deleteAttachment } from "@/server/services/storage";

// Forge has mixed id formats across rows (some cuid v1, some hex). Use
// the same loose validator the rest of the codebase uses for entity ids.
const idString = z.string().min(1).max(40);

const ThreadStateSchema = z.enum(["all", "waiting", "stalled", "has_attachments"]);
const ChatContextModeSchema = z.nativeEnum(ChatContextMode);

const ChatContextSchema = z
  .object({
    route: z.string().optional(),
    slug: z.string().optional(),
    issueId: z.string().optional(),
    selectedIds: z.array(z.string()).optional(),
    visibleEntities: z.array(z.object({ kind: z.string(), ids: z.array(z.string()) })).optional(),
    pinnedRunIds: z.array(z.string()).optional(),
    liveRunIds: z.array(z.string()).optional(),
  })
  .partial();

const chatAttachmentSelect = {
  id: true,
  filename: true,
  mimeType: true,
  size: true,
  kind: true,
  externalUrl: true,
  targetType: true,
  targetId: true,
  createdAt: true,
} as const;

function chatEventPayload(input: {
  threadId: string;
  messageId: string;
  agentId: string;
  role: "USER" | "AGENT";
  body?: string;
  context?: Prisma.InputJsonValue | null;
  sourceRunId?: string | null;
  attachments?: Prisma.InputJsonValue;
}): Prisma.InputJsonObject {
  return {
    threadId: input.threadId,
    messageId: input.messageId,
    agentId: input.agentId,
    role: input.role,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.sourceRunId !== undefined ? { sourceRunId: input.sourceRunId } : {}),
    attachments: (input.attachments ?? []) as Prisma.InputJsonValue,
  };
}

async function purgeChatMessageAttachments(
  db: Pick<Prisma.TransactionClient, "attachment">,
  workspaceId: string,
  messageIds: string[],
): Promise<number> {
  if (messageIds.length === 0) return 0;
  const attachments = await db.attachment.findMany({
    where: {
      workspaceId,
      targetType: "chat-message",
      targetId: { in: messageIds },
    },
    select: { id: true },
  });

  let purged = 0;
  for (const attachment of attachments) {
    try {
      await deleteAttachment(attachment.id);
      purged += 1;
    } catch {
      // Still remove the polymorphic row so clearing/deleting a chat cannot
      // leave visible orphan attachments when object storage is unavailable.
      const deleted = await db.attachment.deleteMany({ where: { id: attachment.id } });
      purged += deleted.count;
    }
  }
  return purged;
}

const visibleChatMessageWhere = {
  OR: [{ role: { not: ChatRole.USER } }, { dispatchedAt: { not: null } }],
} satisfies Prisma.ChatMessageWhereInput;

type ChatThreadDiagnostics = {
  latestUserMessageId: string | null;
  latestUserMessageAt: Date | null;
  latestAgentMessageAt: Date | null;
  lastAgentStreamError: string | null;
  lastAgentStreamAborted: boolean;
  waitingForReply: boolean;
  waitingMs: number | null;
  lastSourceRunId: string | null;
  lastRun: {
    id: string;
    status: AgentRunStatus;
    startedAt: Date;
    completedAt: Date | null;
    currentStep: string | null;
    lastEventAt: Date;
    idleMs: number;
  } | null;
  lastDelivery: {
    id: string;
    status: string;
    attempts: number;
    lastError: string | null;
    updatedAt: Date;
  } | null;
  /**
   * Canonical dispatch state derived from the latest USER message's
   * lifecycle fields. Drives the chat panel's typing/wake/stalled UI
   * directly — preferred over the `lastMessageAge < 60s` heuristic.
   */
  dispatchState: "idle" | "queued" | "wake-sent" | "acknowledged" | "running" | "stalled";
  /**
   * Provider-neutral turn phase for the chat UI. This is the compact version
   * of the lower-level timestamps/run/delivery fields below.
   */
  turnStatus: {
    phase:
      | "idle"
      | "queued"
      | "delivered"
      | "read"
      | "thinking"
      | "running"
      | "completed"
      | "stalled"
      | "failed";
    label: string;
    detail: string;
    tone: "muted" | "info" | "success" | "warning" | "danger";
    startedAt: Date | null;
    readAt: Date | null;
    outputStartedAt: Date | null;
    waitingMs: number | null;
    runId: string | null;
  };
  /**
   * USER-message-level lifecycle snapshot. `null` when no dispatched
   * user message exists for the thread (idle).
   */
  latestUserMessage: {
    id: string;
    createdAt: Date;
    acknowledgedAt: Date | null;
    outputStartedAt: Date | null;
    lastWakeAt: Date | null;
    wakeAttempts: number;
    lastWakeDeliveryId: string | null;
  } | null;
};

function redactDiagnosticText(value: string | null | undefined): string | null {
  if (!value) return null;
  const redacted = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(token|secret|key|authorization|signature)([\"'\s:=]+)[^\s\"'&}]+/gi,
      "$1$2[REDACTED]",
    )
    .replace(/https?:\/\/[^\s\"']+/gi, "[REDACTED_URL]");
  return redacted.length > 500 ? `${redacted.slice(0, 497)}…` : redacted;
}

function jsonObject(
  value: Prisma.JsonValue | null | undefined,
): Record<string, Prisma.JsonValue> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, Prisma.JsonValue>;
}

async function buildThreadDiagnostics(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  threadId: string,
): Promise<ChatThreadDiagnostics> {
  const [latestUser, latestAgent, latestSourceMessage, lastEvent] = await Promise.all([
    tx.chatMessage.findFirst({
      where: { workspaceId, threadId, role: ChatRole.USER, dispatchedAt: { not: null } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        acknowledgedAt: true,
        outputStartedAt: true,
        lastWakeAt: true,
        wakeAttempts: true,
        lastWakeDeliveryId: true,
      },
    }),
    tx.chatMessage.findFirst({
      where: { workspaceId, threadId, role: ChatRole.AGENT },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, sourceRunId: true, contextSnapshot: true },
    }),
    tx.chatMessage.findFirst({
      where: { workspaceId, threadId, sourceRunId: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { sourceRunId: true },
    }),
    tx.activityEvent.findFirst({
      where: {
        workspaceId,
        kind: EventKind.CHAT_MESSAGE_POSTED,
        subjectType: "chat-thread",
        subjectId: threadId,
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        deliveries: {
          orderBy: { scheduledAt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            attempt: true,
            responseBody: true,
            responseStatus: true,
            scheduledAt: true,
            deliveredAt: true,
          },
        },
      },
    }),
  ]);

  const lastSourceRunId = latestSourceMessage?.sourceRunId ?? null;
  const run = lastSourceRunId
    ? await tx.agentRun.findFirst({
        where: { id: lastSourceRunId, workspaceId },
        select: {
          id: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          currentStep: true,
          lastEventAt: true,
        },
      })
    : null;
  const waitingForReply = Boolean(
    latestUser &&
    (!latestAgent || latestUser.createdAt.getTime() > latestAgent.createdAt.getTime()),
  );
  const delivery = lastEvent?.deliveries[0] ?? null;
  const now = Date.now();
  const latestAgentSnapshot = jsonObject(latestAgent?.contextSnapshot);
  const lastAgentStreamError = redactDiagnosticText(
    typeof latestAgentSnapshot?.error === "string" ? latestAgentSnapshot.error : null,
  );
  const lastAgentStreamAborted = latestAgentSnapshot?.aborted === true;

  // Canonical dispatch state derivation. When the latest USER message
  // is "done" (an AGENT message landed after it), report idle; otherwise
  // map the user message's lifecycle fields to the same state machine
  // the inbox surfaces. 60s is the soft "stalled" cutoff for chat —
  // chosen to match the existing legacy thinking-bubble threshold so
  // the UI's "Still waiting" copy still kicks in at the same moment,
  // just driven by canonical state instead of clock-only heuristics.
  const STALE_CHAT_MS = 60_000;
  let dispatchState: ChatThreadDiagnostics["dispatchState"] = "idle";
  if (waitingForReply && latestUser) {
    if (latestUser.outputStartedAt) {
      dispatchState = "running";
    } else if (latestUser.acknowledgedAt) {
      dispatchState =
        now - latestUser.acknowledgedAt.getTime() > STALE_CHAT_MS ? "stalled" : "acknowledged";
    } else if (latestUser.lastWakeAt) {
      dispatchState =
        now - latestUser.lastWakeAt.getTime() > STALE_CHAT_MS ? "stalled" : "wake-sent";
    } else if (now - latestUser.createdAt.getTime() > STALE_CHAT_MS) {
      dispatchState = "stalled";
    } else {
      dispatchState = "queued";
    }
  }
  const waitingMs =
    waitingForReply && latestUser ? Math.max(0, now - latestUser.createdAt.getTime()) : null;
  const deliveryFailed = delivery?.status === "FAILED";
  const readAt = latestUser?.acknowledgedAt ?? latestUser?.outputStartedAt ?? null;
  const turnStatus: ChatThreadDiagnostics["turnStatus"] = !latestUser
    ? {
        phase: "idle",
        label: "Ready",
        detail: "No chat turn has been sent yet.",
        tone: "muted",
        startedAt: null,
        readAt: null,
        outputStartedAt: null,
        waitingMs: null,
        runId: null,
      }
    : !waitingForReply
      ? {
          phase: "completed",
          label: "Replied",
          detail: latestAgent
            ? `Latest reply landed ${Math.max(0, Math.floor((now - latestAgent.createdAt.getTime()) / 1000))}s ago.`
            : "No pending reply.",
          tone: "success",
          startedAt: latestUser.createdAt,
          readAt,
          outputStartedAt: latestUser.outputStartedAt,
          waitingMs: null,
          runId: run?.id ?? null,
        }
      : deliveryFailed || lastAgentStreamError
        ? {
            phase: "failed",
            label: "Needs attention",
            detail:
              lastAgentStreamError ??
              redactDiagnosticText(
                delivery?.responseBody ??
                  (delivery?.responseStatus ? `HTTP ${delivery.responseStatus}` : null),
              ) ??
              "Delivery failed before the agent could reply.",
            tone: "danger",
            startedAt: latestUser.createdAt,
            readAt,
            outputStartedAt: latestUser.outputStartedAt,
            waitingMs,
            runId: run?.id ?? null,
          }
        : dispatchState === "stalled"
          ? {
              phase: "stalled",
              label: "Stalled",
              detail: run?.currentStep
                ? `Waiting on ${run.currentStep}; idle ${Math.max(0, Math.floor((now - run.lastEventAt.getTime()) / 1000))}s.`
                : `No reply after ${Math.max(0, Math.floor((waitingMs ?? 0) / 1000))}s.`,
              tone: "warning",
              startedAt: latestUser.createdAt,
              readAt,
              outputStartedAt: latestUser.outputStartedAt,
              waitingMs,
              runId: run?.id ?? null,
            }
          : dispatchState === "running"
            ? {
                phase: run ? "running" : "thinking",
                label: run ? "Running" : "Thinking",
                detail: run?.currentStep ?? "Agent accepted the turn and is drafting.",
                tone: "info",
                startedAt: latestUser.createdAt,
                readAt,
                outputStartedAt: latestUser.outputStartedAt,
                waitingMs,
                runId: run?.id ?? null,
              }
            : dispatchState === "acknowledged"
              ? {
                  phase: "read",
                  label: "Read",
                  detail: "Agent acknowledged the turn.",
                  tone: "info",
                  startedAt: latestUser.createdAt,
                  readAt,
                  outputStartedAt: latestUser.outputStartedAt,
                  waitingMs,
                  runId: run?.id ?? null,
                }
              : dispatchState === "wake-sent"
                ? {
                    phase: "delivered",
                    label: "Delivered",
                    detail: "Wake delivered; waiting for agent acknowledgement.",
                    tone: "info",
                    startedAt: latestUser.createdAt,
                    readAt,
                    outputStartedAt: latestUser.outputStartedAt,
                    waitingMs,
                    runId: run?.id ?? null,
                  }
                : {
                    phase: "queued",
                    label: "Queued",
                    detail: "Forge persisted the turn and is preparing delivery.",
                    tone: "muted",
                    startedAt: latestUser.createdAt,
                    readAt,
                    outputStartedAt: latestUser.outputStartedAt,
                    waitingMs,
                    runId: run?.id ?? null,
                  };

  return {
    latestUserMessageId: latestUser?.id ?? null,
    latestUserMessageAt: latestUser?.createdAt ?? null,
    latestAgentMessageAt: latestAgent?.createdAt ?? null,
    lastAgentStreamError,
    lastAgentStreamAborted,
    waitingForReply,
    waitingMs,
    lastSourceRunId,
    lastRun: run
      ? {
          id: run.id,
          status: run.status,
          startedAt: run.startedAt,
          completedAt: run.finishedAt,
          currentStep: run.currentStep,
          lastEventAt: run.lastEventAt,
          idleMs: Math.max(0, now - run.lastEventAt.getTime()),
        }
      : null,
    lastDelivery: delivery
      ? {
          id: delivery.id,
          status: delivery.status,
          attempts: delivery.attempt,
          lastError: redactDiagnosticText(
            delivery.responseBody ??
              (delivery.responseStatus ? `HTTP ${delivery.responseStatus}` : null),
          ),
          updatedAt: delivery.deliveredAt ?? delivery.scheduledAt,
        }
      : null,
    dispatchState,
    turnStatus,
    latestUserMessage: latestUser
      ? {
          id: latestUser.id,
          createdAt: latestUser.createdAt,
          acknowledgedAt: latestUser.acknowledgedAt,
          outputStartedAt: latestUser.outputStartedAt,
          lastWakeAt: latestUser.lastWakeAt,
          wakeAttempts: latestUser.wakeAttempts,
          lastWakeDeliveryId: latestUser.lastWakeDeliveryId,
        }
      : null,
  };
}

async function threadHasFinalizedAttachments(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  messageIds: string[],
): Promise<boolean> {
  if (messageIds.length === 0) return false;
  const count = await tx.attachment.count({
    where: {
      workspaceId,
      targetType: "chat-message",
      targetId: { in: messageIds },
      NOT: { url: { startsWith: "pending:" } },
    },
  });
  return count > 0;
}

type ChatAttachmentSummary = Prisma.AttachmentGetPayload<{ select: typeof chatAttachmentSelect }>;

type ChatMessageWithAttachments = Prisma.ChatMessageGetPayload<{
  select: {
    id: true;
    role: true;
    body: true;
    createdAt: true;
    sourceRunId: true;
  };
}> & {
  attachments: ChatAttachmentSummary[];
};

function isImageMime(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("image/");
}

function defaultConversationTitle(agentName: string): string {
  return `Chat with ${agentName}`;
}

async function requireChatAgent(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
) {
  const agent = await tx.agent.findFirst({
    where: { id: agentId, workspaceId, archivedAt: null },
    select: { id: true, name: true, profileKey: true, avatar: true, status: true, role: true },
  });
  if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
  return agent;
}

async function getOrCreateDefaultThread(input: {
  tx: Prisma.TransactionClient;
  workspaceId: string;
  userId: string;
  agentId: string;
  now?: Date;
  touch?: boolean;
}) {
  const existing = await input.tx.chatThread.findFirst({
    where: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: input.agentId,
      isDefault: true,
    },
    orderBy: { createdAt: "asc" },
  });
  if (existing) {
    if (input.touch) {
      return input.tx.chatThread.update({
        where: { id: existing.id },
        data: { lastMessageAt: input.now ?? new Date(), archivedAt: null },
      });
    }
    return existing;
  }
  const agent = await requireChatAgent(input.tx, input.workspaceId, input.agentId);
  return input.tx.chatThread.create({
    data: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: input.agentId,
      title: defaultConversationTitle(agent.name),
      isDefault: true,
      contextMode: ChatContextMode.SMART,
      lastMessageAt: input.now ?? new Date(),
    },
  });
}

async function loadChatAttachmentsByMessageId(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  messageIds: string[],
): Promise<Map<string, ChatAttachmentSummary[]>> {
  if (messageIds.length === 0) return new Map();
  const attachments = await tx.attachment.findMany({
    where: {
      workspaceId,
      targetType: "chat-message",
      targetId: { in: messageIds },
      NOT: { url: { startsWith: "pending:" } },
    },
    orderBy: { createdAt: "asc" },
    select: chatAttachmentSelect,
  });
  const byMessage = new Map<string, ChatAttachmentSummary[]>();
  for (const attachment of attachments) {
    if (!attachment.targetId) continue;
    const bucket = byMessage.get(attachment.targetId) ?? [];
    bucket.push(attachment);
    byMessage.set(attachment.targetId, bucket);
  }
  return byMessage;
}

async function attachChatMessageMetadata(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  messages: Array<Omit<ChatMessageWithAttachments, "attachments">>,
): Promise<ChatMessageWithAttachments[]> {
  const byMessage = await loadChatAttachmentsByMessageId(
    tx,
    workspaceId,
    messages.map((message) => message.id),
  );
  return messages.map((message) => ({
    ...message,
    attachments: byMessage.get(message.id) ?? [],
  }));
}

async function requireOwnedChatThread(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; userId: string; threadId: string },
) {
  const thread = await tx.chatThread.findFirst({
    where: {
      id: input.threadId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      archivedAt: null,
    },
    select: { id: true, workspaceId: true, userId: true },
  });
  if (!thread) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Chat thread not found" });
  }
  return thread;
}

async function markOwnedChatThreadRead(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; userId: string; threadId: string; readAt: Date },
) {
  const thread = await requireOwnedChatThread(tx, input);
  const id = randomUUID();
  const now = new Date();
  const rows = await tx.$queryRaw<Array<{ readAt: Date }>>`
    INSERT INTO "ChatThreadRead" ("id", "workspaceId", "threadId", "userId", "readAt", "createdAt", "updatedAt")
    VALUES (${id}, ${input.workspaceId}, ${thread.id}, ${input.userId}, ${input.readAt}, ${now}, ${now})
    ON CONFLICT ("threadId", "userId") DO UPDATE
      SET "readAt" = GREATEST("ChatThreadRead"."readAt", EXCLUDED."readAt"),
          "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "readAt"
  `;
  return { threadId: thread.id, readAt: rows[0]?.readAt ?? input.readAt };
}

export const chatRouter = router({
  /**
   * List chat threads the current user has with any agent. Empty when
   * the user hasn't started any chats yet.
   */
  threads: workspaceProcedure
    .input(
      z
        .object({
          archived: z.boolean().optional(),
          query: z.string().trim().max(200).optional(),
          state: ThreadStateSchema.default("all"),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const query = input?.query?.trim();
      const threads = await ctx.db.chatThread.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
          archivedAt: input?.archived ? { not: null } : null,
          ...(query
            ? {
                OR: [
                  { title: { contains: query, mode: "insensitive" } },
                  { agent: { name: { contains: query, mode: "insensitive" } } },
                  { agent: { profileKey: { contains: query, mode: "insensitive" } } },
                  { messages: { some: { body: { contains: query, mode: "insensitive" } } } },
                ],
              }
            : {}),
        },
        orderBy: { lastMessageAt: "desc" },
        include: {
          agent: {
            select: {
              id: true,
              name: true,
              profileKey: true,
              avatar: true,
              status: true,
              role: true,
              // Availability inputs so the sidebar shows "on-demand" instead
              // of a false "offline" for managed-runtime / dispatch agents.
              provider: true,
              runtimeMode: true,
              lastHeartbeatAt: true,
              webhookUrl: true,
              runtimeId: true,
            },
          },
          messages: {
            where: visibleChatMessageWhere,
            orderBy: { createdAt: "desc" },
            take: 20,
            select: { id: true, role: true, body: true, createdAt: true, sourceRunId: true },
          },
          reads: {
            where: { userId: ctx.session.user.id },
            select: { readAt: true },
            take: 1,
          },
          _count: { select: { messages: true } },
        },
        take: 75,
      });
      const visibleMessages = threads.flatMap((thread) => thread.messages);
      const latestWithAttachments = await attachChatMessageMetadata(
        ctx.db,
        ctx.workspaceId,
        visibleMessages,
      );
      const byId = new Map(latestWithAttachments.map((message) => [message.id, message]));
      const enriched = [];
      for (const { messages, reads, ...thread } of threads) {
        const latest = messages[0] ? byId.get(messages[0].id) : null;
        const diagnostics = await buildThreadDiagnostics(ctx.db, ctx.workspaceId, thread.id);
        const hasAttachments = await threadHasFinalizedAttachments(
          ctx.db,
          ctx.workspaceId,
          messages.map((message) => message.id),
        );
        enriched.push({
          ...thread,
          lastReadAt: reads[0]?.readAt ?? null,
          diagnostics,
          hasAttachments,
          latestMessage: latest
            ? {
                id: latest.id,
                role: latest.role,
                body: latest.body,
                createdAt: latest.createdAt,
                sourceRunId: latest.sourceRunId,
                attachmentCount: latest.attachments.length,
                hasImageAttachment: latest.attachments.some((attachment) =>
                  isImageMime(attachment.mimeType),
                ),
                attachments: latest.attachments,
              }
            : null,
        });
      }
      const state = input?.state ?? "all";
      return enriched.filter((thread) => {
        if (state === "waiting") return thread.diagnostics.waitingForReply;
        if (state === "stalled") {
          return (
            thread.diagnostics.lastRun?.status === AgentRunStatus.STALLED ||
            Boolean(
              thread.diagnostics.lastRun &&
              thread.diagnostics.lastRun.status === AgentRunStatus.ACTIVE &&
              thread.diagnostics.lastRun.idleMs >= STALE_RUN_MS,
            )
          );
        }
        if (state === "has_attachments") return thread.hasAttachments;
        return true;
      });
    }),

  markRead: workspaceProcedure
    .input(
      z.object({
        threadId: idString,
        readAt: z.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const readAt = input.readAt ?? new Date();
      const result = await markOwnedChatThreadRead(ctx.db, {
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        threadId: input.threadId,
        readAt,
      });
      return { ok: true, ...result };
    }),

  /**
   * Open / get the default DM thread for an agent. This preserves the old
   * one-click chat behavior while named conversations use createConversation.
   */
  defaultThread: workspaceProcedure
    .input(z.object({ agentId: idString }))
    .mutation(async ({ ctx, input }) => {
      const agent = await requireChatAgent(ctx.db, ctx.workspaceId, input.agentId);
      const thread = await getOrCreateDefaultThread({
        tx: ctx.db,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        agentId: agent.id,
      });
      const messages = await ctx.db.chatMessage.findMany({
        where: {
          threadId: thread.id,
          OR: [{ role: { not: ChatRole.USER } }, { dispatchedAt: { not: null } }],
        },
        orderBy: { createdAt: "asc" },
        take: 50,
      });
      return { thread, agent, messages };
    }),

  /** Backward-compatible alias for existing Mission Control callers. */
  thread: workspaceProcedure
    .input(z.object({ agentId: idString }))
    .mutation(async ({ ctx, input }) => {
      const agent = await requireChatAgent(ctx.db, ctx.workspaceId, input.agentId);
      const thread = await getOrCreateDefaultThread({
        tx: ctx.db,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        agentId: agent.id,
      });
      const messages = await ctx.db.chatMessage.findMany({
        where: {
          threadId: thread.id,
          OR: [{ role: { not: ChatRole.USER } }, { dispatchedAt: { not: null } }],
        },
        orderBy: { createdAt: "asc" },
        take: 50,
      });
      return { thread, agent, messages };
    }),

  createConversation: workspaceProcedure
    .input(
      z.object({
        agentId: idString,
        title: z.string().trim().min(1).max(120).optional(),
        topic: z.string().trim().max(500).optional(),
        contextMode: ChatContextModeSchema.default(ChatContextMode.SMART),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const agent = await requireChatAgent(ctx.db, ctx.workspaceId, input.agentId);
      const now = new Date();
      const thread = await ctx.db.chatThread.create({
        data: {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
          agentId: agent.id,
          title: input.title ?? null,
          topic: input.topic || null,
          isDefault: false,
          contextMode: input.contextMode,
          lastMessageAt: now,
          createdAt: now,
        },
      });
      return { thread, agent, messages: [] };
    }),

  forkThread: workspaceProcedure
    .input(
      z.object({
        threadId: idString,
        messageId: idString,
        title: z.string().trim().min(1).max(120).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const source = await tx.chatThread.findFirst({
          where: {
            id: input.threadId,
            workspaceId: ctx.workspaceId,
            userId: ctx.session.user.id,
            archivedAt: null,
          },
          include: {
            agent: {
              select: {
                id: true,
                name: true,
                profileKey: true,
                avatar: true,
                status: true,
                role: true,
              },
            },
          },
        });
        if (!source) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Chat thread not found" });
        }

        const sourceMessages = await tx.chatMessage.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            threadId: source.id,
            ...visibleChatMessageWhere,
          },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            role: true,
            body: true,
            contextSnapshot: true,
            dispatchedAt: true,
            acknowledgedAt: true,
            outputStartedAt: true,
            createdAt: true,
          },
        });
        const targetIndex = sourceMessages.findIndex((message) => message.id === input.messageId);
        if (targetIndex === -1) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Message not found in thread" });
        }
        const selectedMessages = sourceMessages.slice(0, targetIndex + 1);
        const now = new Date();
        const baseTitle =
          source.title?.trim() ||
          source.topic?.trim() ||
          `Chat with ${source.agent.name || source.agent.profileKey}`;
        const thread = await tx.chatThread.create({
          data: {
            workspaceId: ctx.workspaceId,
            userId: ctx.session.user.id,
            agentId: source.agentId,
            title: input.title ?? `Fork: ${baseTitle}`.slice(0, 120),
            topic: source.topic,
            isDefault: false,
            contextMode: source.contextMode,
            summaryMarkdown: source.summaryMarkdown,
            summarizedUntilMessageId: null,
            summarizedAt: source.summarizedAt,
            providerOverride: source.providerOverride,
            modelOverride: source.modelOverride,
            lastMessageAt: now,
            createdAt: now,
          },
        });

        const messageIdMap = new Map<string, string>();
        const clonedMessages = [];
        for (const [idx, message] of selectedMessages.entries()) {
          const createdAt = new Date(now.getTime() + idx);
          const receiptAt =
            message.acknowledgedAt ?? message.outputStartedAt ?? message.dispatchedAt ?? createdAt;
          const cloned = await tx.chatMessage.create({
            data: {
              workspaceId: ctx.workspaceId,
              threadId: thread.id,
              role: message.role,
              body: message.body,
              contextSnapshot: (message.contextSnapshot ?? undefined) as
                | Prisma.InputJsonValue
                | undefined,
              // Historical fork rows should stay visible/readable, but must
              // not wake agents or point the new thread at an old runtime run.
              sourceRunId: null,
              dispatchedAt: message.role === ChatRole.USER ? (message.dispatchedAt ?? now) : null,
              acknowledgedAt: message.role === ChatRole.USER ? receiptAt : null,
              outputStartedAt: message.role === ChatRole.USER ? receiptAt : null,
              lastWakeAt: null,
              wakeAttempts: 0,
              lastWakeDeliveryId: null,
              createdAt,
            },
          });
          messageIdMap.set(message.id, cloned.id);
          clonedMessages.push(cloned);
        }

        const sourceMessageIds = selectedMessages.map((message) => message.id);
        const sourceAttachments =
          sourceMessageIds.length > 0
            ? await tx.attachment.findMany({
                where: {
                  workspaceId: ctx.workspaceId,
                  targetType: "chat-message",
                  targetId: { in: sourceMessageIds },
                  NOT: { url: { startsWith: "pending:" } },
                },
                orderBy: { createdAt: "asc" },
              })
            : [];
        if (sourceAttachments.length > 0) {
          await tx.attachment.createMany({
            data: sourceAttachments
              .map((attachment) => {
                const targetId = attachment.targetId
                  ? messageIdMap.get(attachment.targetId)
                  : undefined;
                if (!targetId) return null;
                return {
                  workspaceId: ctx.workspaceId,
                  issueId: null,
                  targetType: "chat-message",
                  targetId,
                  kind: attachment.kind,
                  filename: attachment.filename,
                  mimeType: attachment.mimeType,
                  size: attachment.size,
                  url: attachment.url,
                  externalUrl: attachment.externalUrl,
                  linkTitle: attachment.linkTitle,
                  createdAt: now,
                };
              })
              .filter((row): row is NonNullable<typeof row> => row !== null),
          });
        }

        await tx.auditLog.create({
          data: {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "ChatThread",
            entityId: thread.id,
            action: "fork",
            before: {
              sourceThreadId: source.id,
              sourceMessageId: input.messageId,
            },
            after: {
              messageCount: clonedMessages.length,
              attachmentCount: sourceAttachments.length,
            },
          },
        });

        const messages = await attachChatMessageMetadata(tx, ctx.workspaceId, clonedMessages);
        return { thread, agent: source.agent, messages };
      });
    }),

  updateConversation: workspaceProcedure
    .input(
      z.object({
        threadId: idString,
        title: z.string().trim().min(1).max(120).nullable().optional(),
        topic: z.string().trim().max(500).nullable().optional(),
        contextMode: ChatContextModeSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const thread = await ctx.db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId, userId: ctx.session.user.id },
        select: { id: true },
      });
      if (!thread) throw new TRPCError({ code: "NOT_FOUND", message: "Chat thread not found" });
      return ctx.db.chatThread.update({
        where: { id: thread.id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.topic !== undefined ? { topic: input.topic || null } : {}),
          ...(input.contextMode !== undefined ? { contextMode: input.contextMode } : {}),
        },
      });
    }),

  /**
   * Set or clear per-thread provider/model overrides. Null on either
   * field reverts to the agent default (provider) / the provider default
   * model. Both fields are optional in the input — the mutation only
   * touches columns the caller specifies.
   */
  setOverride: workspaceProcedure
    .input(
      z.object({
        threadId: idString,
        provider: z.nativeEnum(AgentProvider).nullable().optional(),
        model: z.string().trim().max(120).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const thread = await ctx.db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId, userId: ctx.session.user.id },
        select: { id: true },
      });
      if (!thread) throw new TRPCError({ code: "NOT_FOUND", message: "Chat thread not found" });
      const data: Prisma.ChatThreadUpdateInput = {};
      if (input.provider !== undefined) data.providerOverride = input.provider;
      if (input.model !== undefined) {
        const trimmed = input.model?.trim() ?? null;
        data.modelOverride = trimmed && trimmed.length > 0 ? trimmed : null;
      }
      await ctx.db.chatThread.update({ where: { id: thread.id }, data });
      return { ok: true } as const;
    }),

  compactThread: workspaceProcedure
    .input(z.object({ threadId: idString }))
    .mutation(async ({ ctx, input }) => {
      const thread = await ctx.db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId, userId: ctx.session.user.id },
        select: { id: true },
      });
      if (!thread) throw new TRPCError({ code: "NOT_FOUND", message: "Chat thread not found" });
      return compactChatThread(ctx.db, {
        workspaceId: ctx.workspaceId,
        threadId: thread.id,
        actorId: ctx.session.user.id,
        actor: "manual",
      });
    }),

  clearThread: workspaceProcedure
    .input(z.object({ threadId: idString }))
    .mutation(async ({ ctx, input }) => {
      const thread = await ctx.db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId, userId: ctx.session.user.id },
        select: { id: true, title: true, isDefault: true, agentId: true },
      });
      if (!thread) throw new TRPCError({ code: "NOT_FOUND", message: "Chat thread not found" });

      const messages = await ctx.db.chatMessage.findMany({
        where: { workspaceId: ctx.workspaceId, threadId: thread.id },
        select: { id: true },
      });
      const messageIds = messages.map((message) => message.id);
      const purgedAttachments = await purgeChatMessageAttachments(
        ctx.db,
        ctx.workspaceId,
        messageIds,
      );

      const messageIdSet = new Set(messageIds);
      const events =
        messageIds.length > 0
          ? await ctx.db.activityEvent.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                subjectType: "chat-thread",
                subjectId: thread.id,
              },
              select: { id: true, payload: true },
            })
          : [];
      const eventIds = events
        .filter((event) => {
          const payload =
            event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
              ? (event.payload as Record<string, Prisma.JsonValue>)
              : null;
          return typeof payload?.messageId === "string" && messageIdSet.has(payload.messageId);
        })
        .map((event) => event.id);

      const now = new Date();
      await ctx.db.$transaction(async (tx) => {
        if (eventIds.length > 0) {
          await tx.webhookDelivery.deleteMany({ where: { eventId: { in: eventIds } } });
          await tx.notificationState.deleteMany({ where: { eventId: { in: eventIds } } });
          await tx.activityEvent.deleteMany({ where: { id: { in: eventIds } } });
        }
        if (messageIds.length > 0) {
          await tx.auditLog.deleteMany({
            where: {
              workspaceId: ctx.workspaceId,
              entity: "ChatMessage",
              entityId: { in: messageIds },
            },
          });
          await tx.chatMessage.deleteMany({
            where: { workspaceId: ctx.workspaceId, threadId: thread.id },
          });
        }
        await tx.chatThread.update({
          where: { id: thread.id },
          data: {
            summaryMarkdown: null,
            summarizedUntilMessageId: null,
            summarizedAt: null,
            lastMessageAt: now,
          },
        });
        await tx.auditLog.create({
          data: {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            entity: "ChatThread",
            entityId: thread.id,
            action: "clear",
            before: {
              title: thread.title,
              isDefault: thread.isDefault,
              agentId: thread.agentId,
              messageCount: messageIds.length,
            },
            after: {
              messageCount: 0,
              summarizedAt: null,
            },
          },
        });
      });

      return {
        ok: true,
        cleared: true,
        messageCount: messageIds.length,
        purgedAttachments,
      } as const;
    }),

  /**
   * Fetch a concrete thread for deep-linked chat surfaces. This is read-only
   * and owner-scoped: another member of the same workspace should not see a
   * private operator/agent thread just because they can guess the id.
   */
  getThread: workspaceProcedure
    .input(z.object({ threadId: idString }))
    .query(async ({ ctx, input }) => {
      const thread = await ctx.db.chatThread.findFirst({
        where: {
          id: input.threadId,
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
          archivedAt: null,
        },
        include: {
          agent: {
            select: {
              id: true,
              name: true,
              profileKey: true,
              avatar: true,
              status: true,
              role: true,
            },
          },
          reads: {
            where: { userId: ctx.session.user.id },
            select: { readAt: true },
            take: 1,
          },
        },
      });
      if (!thread) return null;
      const messages = await ctx.db.chatMessage.findMany({
        where: {
          threadId: thread.id,
          ...visibleChatMessageWhere,
        },
        orderBy: { createdAt: "asc" },
        take: 100,
        // contextSnapshot is included so the streaming chat path can
        // rehydrate `thinking` + `tool_use` blocks on page reload.
        // The delivery-receipt columns MUST be selected too — the client's
        // MessageReceipt derives "Sent"/"Read" from them, and without them
        // every persisted USER row falls through to a stuck "Sending…"
        // spinner (the `thread` mutation path returns them by default, so
        // only this explicit-select read regressed).
        select: {
          id: true,
          role: true,
          body: true,
          createdAt: true,
          sourceRunId: true,
          contextSnapshot: true,
          dispatchedAt: true,
          acknowledgedAt: true,
          outputStartedAt: true,
        },
      });
      const messagesWithAttachments = await attachChatMessageMetadata(
        ctx.db,
        ctx.workspaceId,
        messages,
      );
      const diagnostics = await buildThreadDiagnostics(ctx.db, ctx.workspaceId, thread.id);
      const { reads, ...threadWithoutReads } = thread;
      return {
        ...threadWithoutReads,
        lastReadAt: reads[0]?.readAt ?? null,
        messages: messagesWithAttachments,
        diagnostics,
      };
    }),

  /**
   * Send a user text-only message. This remains the immediate path: it
   * persists, marks dispatchedAt, then fans out CHAT_MESSAGE_POSTED so
   * webhooks/agents can respond.
   */
  send: workspaceProcedure
    .input(
      z.object({
        agentId: idString,
        threadId: idString.optional(),
        body: z.string().min(1).max(8000),
        context: ChatContextSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const now = new Date();
        const thread = input.threadId
          ? await tx.chatThread.findFirst({
              where: {
                id: input.threadId,
                workspaceId: ctx.workspaceId,
                userId: ctx.session.user.id,
                agentId: input.agentId,
                archivedAt: null,
              },
            })
          : await getOrCreateDefaultThread({
              tx,
              workspaceId: ctx.workspaceId,
              userId: ctx.session.user.id,
              agentId: input.agentId,
              now,
              touch: true,
            });
        if (!thread) throw new TRPCError({ code: "NOT_FOUND", message: "Chat thread not found" });
        if (input.threadId) {
          await tx.chatThread.update({ where: { id: thread.id }, data: { lastMessageAt: now } });
        }
        const message = await tx.chatMessage.create({
          data: {
            workspaceId: ctx.workspaceId,
            threadId: thread.id,
            role: ChatRole.USER,
            body: input.body,
            contextSnapshot: (input.context ?? {}) as never,
            dispatchedAt: now,
          },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "ChatMessage",
          entityId: message.id,
          action: "create",
          eventKind: EventKind.CHAT_MESSAGE_POSTED,
          subjectType: "chat-thread",
          subjectId: thread.id,
          payload: chatEventPayload({
            threadId: thread.id,
            messageId: message.id,
            agentId: input.agentId,
            role: "USER",
            body: input.body,
            context: input.context ?? {},
            attachments: [] as Prisma.InputJsonArray,
          }),
        });
        return { threadId: thread.id, messageId: message.id };
      });
    }),

  /**
   * Create a USER message without dispatching it yet. Attachment-aware UI
   * uses this, uploads/finalizes files against targetType=chat-message,
   * then calls dispatchMessage. This removes the race where agents were
   * invoked before the inbound attachments existed.
   */
  createPendingMessage: workspaceProcedure
    .input(
      z.object({
        agentId: idString,
        threadId: idString.optional(),
        body: z.string().max(8000).default(""),
        context: ChatContextSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const agent = await requireChatAgent(ctx.db, ctx.workspaceId, input.agentId);
      const thread = input.threadId
        ? await ctx.db.chatThread.findFirst({
            where: {
              id: input.threadId,
              workspaceId: ctx.workspaceId,
              userId: ctx.session.user.id,
              agentId: agent.id,
              archivedAt: null,
            },
          })
        : await getOrCreateDefaultThread({
            tx: ctx.db,
            workspaceId: ctx.workspaceId,
            userId: ctx.session.user.id,
            agentId: agent.id,
          });
      if (!thread) throw new TRPCError({ code: "NOT_FOUND", message: "Chat thread not found" });
      const message = await ctx.db.chatMessage.create({
        data: {
          workspaceId: ctx.workspaceId,
          threadId: thread.id,
          role: ChatRole.USER,
          body: input.body,
          contextSnapshot: (input.context ?? {}) as never,
          dispatchedAt: null,
        },
      });
      return { threadId: thread.id, messageId: message.id };
    }),

  /**
   * Dispatch a previously-created pending USER message once all required
   * chat-message attachments are finalized. Idempotent: duplicate calls do
   * not emit duplicate CHAT_MESSAGE_POSTED events.
   */
  dispatchMessage: workspaceProcedure
    .input(z.object({ messageId: idString }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const message = await tx.chatMessage.findFirst({
          where: { id: input.messageId, workspaceId: ctx.workspaceId },
          include: { thread: { select: { id: true, userId: true, agentId: true } } },
        });
        if (!message) throw new TRPCError({ code: "NOT_FOUND", message: "Message not found" });
        if (message.role !== ChatRole.USER) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Only user messages can be dispatched",
          });
        }
        if (message.thread.userId !== ctx.session.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only the thread owner may dispatch this message",
          });
        }
        const attachments = await tx.attachment.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            targetType: "chat-message",
            targetId: message.id,
            NOT: { url: { startsWith: "pending:" } },
          },
          orderBy: { createdAt: "asc" },
          select: chatAttachmentSelect,
        });
        if (message.body.trim().length === 0 && attachments.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Message must include text or at least one finalized attachment",
          });
        }
        if (message.dispatchedAt) {
          return { threadId: message.thread.id, messageId: message.id, dispatched: false };
        }
        const now = new Date();
        const updated = await tx.chatMessage.updateMany({
          where: { id: message.id, dispatchedAt: null },
          data: { dispatchedAt: now },
        });
        if (updated.count === 0) {
          return { threadId: message.thread.id, messageId: message.id, dispatched: false };
        }
        await tx.chatThread.update({
          where: { id: message.thread.id },
          data: { lastMessageAt: now },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "ChatMessage",
          entityId: message.id,
          action: "create",
          eventKind: EventKind.CHAT_MESSAGE_POSTED,
          subjectType: "chat-thread",
          subjectId: message.thread.id,
          payload: chatEventPayload({
            threadId: message.thread.id,
            messageId: message.id,
            agentId: message.thread.agentId,
            role: "USER",
            body: message.body,
            context: message.contextSnapshot ?? {},
            attachments: attachments as unknown as Prisma.InputJsonArray,
          }),
        });
        return { threadId: message.thread.id, messageId: message.id, dispatched: true };
      });
    }),

  /**
   * Agent-side append. Restricted to API keys whose linkedAgentId
   * matches the thread's agent.
   */
  appendAgentMessage: workspaceProcedure
    .input(
      z.object({
        threadId: idString,
        body: z.string().min(1).max(16_000),
        sourceRunId: idString.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const thread = await ctx.db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId },
        select: { id: true, agentId: true },
      });
      if (!thread) throw new TRPCError({ code: "NOT_FOUND" });
      const linkedAgentId = ctx.apiKey?.linkedAgentId ?? null;
      if (!linkedAgentId || linkedAgentId !== thread.agentId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the thread's agent may append" });
      }
      return ctx.db.$transaction(async (tx) => {
        const now = new Date();
        const pendingUserMessage = await tx.chatMessage.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            threadId: thread.id,
            role: ChatRole.USER,
            outputStartedAt: null,
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, acknowledgedAt: true },
        });
        if (pendingUserMessage) {
          await tx.chatMessage.update({
            where: { id: pendingUserMessage.id },
            data: {
              acknowledgedAt: pendingUserMessage.acknowledgedAt ?? now,
              outputStartedAt: now,
            },
          });
        }
        const message = await tx.chatMessage.create({
          data: {
            workspaceId: ctx.workspaceId,
            threadId: thread.id,
            role: ChatRole.AGENT,
            body: input.body,
            sourceRunId: input.sourceRunId ?? null,
          },
        });
        await tx.chatThread.update({
          where: { id: thread.id },
          data: { lastMessageAt: now },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: null,
          actorAgentId: linkedAgentId,
          entity: "ChatMessage",
          entityId: message.id,
          action: "create",
          eventKind: EventKind.CHAT_MESSAGE_POSTED,
          subjectType: "chat-thread",
          subjectId: thread.id,
          payload: chatEventPayload({
            threadId: thread.id,
            messageId: message.id,
            agentId: thread.agentId,
            role: "AGENT",
            sourceRunId: input.sourceRunId ?? null,
          }),
        });
        return { messageId: message.id };
      });
    }),

  threadDiagnostics: workspaceProcedure
    .input(z.object({ threadId: idString }))
    .query(async ({ ctx, input }) => {
      const thread = await ctx.db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId, userId: ctx.session.user.id },
        select: { id: true },
      });
      if (!thread) throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });
      return buildThreadDiagnostics(ctx.db, ctx.workspaceId, thread.id);
    }),

  /**
   * Whether a chat turn for this agent will actually reach a model — so the
   * composer can steer the operator (attach a chat-capable runtime / set a
   * model) instead of presenting an input that can only error. Resolves the
   * same provider+engine+backend the stream route uses; honours a per-thread
   * provider override when `threadId` is given.
   */
  chatReadiness: workspaceProcedure
    .input(z.object({ agentId: idString, threadId: idString.optional() }))
    .query(async ({ ctx, input }) => {
      const agent = await ctx.db.agent.findFirst({
        where: { id: input.agentId, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          provider: true,
          runEngine: true,
          webhookUrl: true,
          runtime: {
            select: {
              adapterKey: true,
              endpoint: true,
              secret: true,
              kind: true,
              config: true,
              disabledAt: true,
              name: true,
              lastProbeAttempted: true,
              lastProbeReachable: true,
              lastProbeDetail: true,
            },
          },
        },
      });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      let providerOverride: AgentProvider | null = null;
      if (input.threadId) {
        const thread = await ctx.db.chatThread.findFirst({
          where: {
            id: input.threadId,
            workspaceId: ctx.workspaceId,
            userId: ctx.session.user.id,
          },
          select: { providerOverride: true },
        });
        providerOverride = thread?.providerOverride ?? null;
      }
      const providerAvailable = await workspaceChatProviderAvailability(ctx.db, ctx.workspaceId);
      // A daemon/runtime authenticating as this agent (AGENT-kind ApiKey) is
      // the strongest "served via dispatch" signal.
      const daemonLinked =
        (await ctx.db.apiKey.count({
          where: { workspaceId: ctx.workspaceId, linkedAgentId: agent.id, revokedAt: null },
        })) > 0;
      return resolveChatReadiness({
        provider: agent.provider,
        runEngine: agent.runEngine,
        runtime: agent.runtime,
        webhookUrl: agent.webhookUrl,
        runtimeKind: agent.runtime?.kind ?? null,
        daemonLinked,
        providerOverride,
        providerAvailable,
      });
    }),

  retryLastUserMessage: workspaceProcedure
    .input(z.object({ threadId: idString }))
    .mutation(async ({ ctx, input }) => {
      const latest = await ctx.db.chatMessage.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          threadId: input.threadId,
          role: ChatRole.USER,
          dispatchedAt: { not: null },
          thread: { userId: ctx.session.user.id },
        },
        orderBy: { createdAt: "desc" },
        include: { thread: { select: { id: true, agentId: true, userId: true } } },
      });
      if (!latest) {
        return {
          ok: false,
          action: "retry",
          message: "No dispatched user message is available to retry.",
        } as const;
      }
      const attachments = await loadChatAttachmentsByMessageId(ctx.db, ctx.workspaceId, [
        latest.id,
      ]);
      await ctx.db.$transaction(async (tx) => {
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "ChatMessage",
          entityId: latest.id,
          action: "retry-dispatch",
          eventKind: EventKind.CHAT_MESSAGE_POSTED,
          subjectType: "chat-thread",
          subjectId: latest.thread.id,
          payload: {
            ...chatEventPayload({
              threadId: latest.thread.id,
              messageId: latest.id,
              agentId: latest.thread.agentId,
              role: "USER",
              body: latest.body,
              context: latest.contextSnapshot ?? {},
              attachments: (attachments.get(latest.id) ?? []) as unknown as Prisma.InputJsonArray,
            }),
            retry: true,
            retriedAt: new Date().toISOString(),
          },
        });
      });
      return {
        ok: true,
        action: "retry",
        message: "Retry event queued for the latest user message.",
      } as const;
    }),

  kickThreadRun: workspaceProcedure
    .input(z.object({ threadId: idString, runId: idString }))
    .mutation(async ({ ctx, input }) => {
      const thread = await ctx.db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId, userId: ctx.session.user.id },
        select: { id: true, agentId: true },
      });
      if (!thread) throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });
      const run = await ctx.db.agentRun.findFirst({
        where: { id: input.runId, workspaceId: ctx.workspaceId, agentId: thread.agentId },
        select: {
          id: true,
          issueId: true,
          status: true,
          lastEventAt: true,
          currentStep: true,
          agent: { select: { id: true, webhookUrl: true, webhookSecret: true } },
        },
      });
      if (!run)
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found for this thread agent." });
      if (run.status !== AgentRunStatus.ACTIVE) {
        return {
          ok: false,
          action: "kick",
          message: `Run is ${run.status}; only active stale runs can be kicked.`,
        } as const;
      }
      const idleMs = Date.now() - run.lastEventAt.getTime();
      if (idleMs < STALE_RUN_MS) {
        return {
          ok: true,
          action: "kick",
          kicked: false,
          idleMs,
          message: "Run is still fresh; no kick was sent.",
        } as const;
      }
      await ctx.db.$transaction(async (tx) => {
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "AgentRun",
          entityId: run.id,
          action: "kick",
          eventKind: EventKind.AGENT_RUN_KICKED,
          subjectType: "agent-run",
          subjectId: run.id,
          payload: {
            runId: run.id,
            issueId: run.issueId,
            agentId: run.agent.id,
            threadId: thread.id,
            idleMs,
            currentStep: run.currentStep,
          },
        });
      });
      if (run.agent.webhookUrl && run.agent.webhookSecret) {
        void deliverWebhook({
          url: run.agent.webhookUrl,
          secret: run.agent.webhookSecret,
          timeoutMs: 5000,
          body: {
            id: `chat-run-kick-${run.id}-${Date.now()}`,
            kind: "AGENT_RUN_KICKED",
            subjectType: "agent-run",
            subjectId: run.id,
            payload: {
              runId: run.id,
              issueId: run.issueId,
              agentId: run.agent.id,
              workspaceId: ctx.workspaceId,
              threadId: thread.id,
              idleMs,
              reason: "operator-chat-kick",
            },
            createdAt: new Date().toISOString(),
          },
        }).catch(() => {});
      }
      return {
        ok: true,
        action: "kick",
        kicked: true,
        idleMs,
        message: "Stale run kick event sent.",
      } as const;
    }),

  /**
   * Stop the live runtime session backing this thread's latest run. Only
   * meaningful for a RUNS-engine agent whose run is owned by a managed
   * runtime (Hermes today; a Codex app-server / ACP session later): we ask
   * the connector to terminate the provider-side run, then mark the Forge
   * `AgentRun` ABANDONED so its state isn't stuck ACTIVE. Best-effort on the
   * external call — a gateway that's already torn the run down shouldn't
   * leave Forge unable to close its mirror. A COMPLETIONS agent (Forge owns
   * the loop) has no external session to stop; the operator uses the chat
   * composer's Stop button for an in-flight stream instead.
   */
  stopThreadRun: workspaceProcedure
    .input(z.object({ threadId: idString, runId: idString }))
    .mutation(async ({ ctx, input }) => {
      const thread = await ctx.db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId, userId: ctx.session.user.id },
        select: { id: true, agentId: true },
      });
      if (!thread) throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });
      const run = await ctx.db.agentRun.findFirst({
        where: { id: input.runId, workspaceId: ctx.workspaceId, agentId: thread.agentId },
        select: {
          id: true,
          issueId: true,
          agentId: true,
          status: true,
          externalRunId: true,
          agent: {
            select: {
              provider: true,
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
      if (!run) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found for this thread agent." });
      }
      if (run.status !== AgentRunStatus.ACTIVE) {
        return {
          ok: true,
          action: "stop",
          stopped: false,
          message: `Run is ${run.status.toLowerCase()}; nothing to stop.`,
        } as const;
      }
      const connector = getRunsConnectorForAgent({
        provider: run.agent.provider,
        runtime: run.agent.runtime,
      });
      if (!connector?.stop || !run.externalRunId) {
        return {
          ok: false,
          action: "stop",
          stopped: false,
          message:
            "This run isn't backed by a stoppable runtime session (no managed runtime owns it).",
        } as const;
      }
      // Best-effort terminate the provider-side run; still close the mirror
      // even if the gateway has already dropped it.
      try {
        await connector.stop(run.externalRunId);
      } catch {
        /* gateway unreachable / run already gone — fall through and finalize */
      }
      await ctx.db.$transaction(async (tx) => {
        await finishRun(tx, {
          runId: run.id,
          workspaceId: ctx.workspaceId,
          issueId: run.issueId,
          agentId: run.agentId,
          status: "ABANDONED",
          summary: "Operator stopped the run from chat.",
          actorId: ctx.session.user.id,
        });
      });
      return { ok: true, action: "stop", stopped: true, message: "Run stopped." } as const;
    }),

  /**
   * Hard-delete a thread and everything it owns. Distinct from
   * `archiveThread` (reversible hide): this is irreversible and purges
   * persisted content. Order matters:
   *   1. Best-effort stop a live runs-backed run so we don't orphan a
   *      provider-side session (same connector path as `stopThreadRun`).
   *   2. Purge `chat-message` attachments — they're polymorphic (no FK), so
   *      cascade won't reach them; `deleteAttachment` removes the MinIO
   *      object and the row.
   *   3. Delete the `ChatThread`; `ChatMessage` rows cascade via FK.
   * Owner-scoped: only the thread's operator can delete it. A deleted
   * default thread simply re-creates empty the next time chat opens.
   */
  deleteThread: workspaceProcedure
    .input(z.object({ threadId: idString, stopRun: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      const thread = await ctx.db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId, userId: ctx.session.user.id },
        select: {
          id: true,
          title: true,
          isDefault: true,
          agentId: true,
          agent: {
            select: {
              provider: true,
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
      if (!thread) throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });

      // (1) Stop a live runs-backed run, if any. Resolve it the same way
      // diagnostics does — the most recent run referenced by a message in
      // this thread — and only act when it's still ACTIVE + externally owned.
      let stoppedRun = false;
      if (input.stopRun) {
        const lastSourceMessage = await ctx.db.chatMessage.findFirst({
          where: { workspaceId: ctx.workspaceId, threadId: thread.id, sourceRunId: { not: null } },
          orderBy: { createdAt: "desc" },
          select: { sourceRunId: true },
        });
        if (lastSourceMessage?.sourceRunId) {
          const run = await ctx.db.agentRun.findFirst({
            where: {
              id: lastSourceMessage.sourceRunId,
              workspaceId: ctx.workspaceId,
              agentId: thread.agentId,
              status: AgentRunStatus.ACTIVE,
            },
            select: { id: true, issueId: true, agentId: true, externalRunId: true },
          });
          const connector = getRunsConnectorForAgent({
            provider: thread.agent.provider,
            runtime: thread.agent.runtime,
          });
          if (run?.externalRunId && connector?.stop) {
            try {
              await connector.stop(run.externalRunId);
            } catch {
              /* best-effort */
            }
            await ctx.db.$transaction(async (tx) => {
              await finishRun(tx, {
                runId: run.id,
                workspaceId: ctx.workspaceId,
                issueId: run.issueId,
                agentId: run.agentId,
                status: "ABANDONED",
                summary: "Run stopped — chat thread deleted by operator.",
                actorId: ctx.session.user.id,
              });
            });
            stoppedRun = true;
          }
        }
      }

      // (2) Purge chat-message attachments (MinIO object + row). Polymorphic,
      // so no FK cascade reaches them.
      const messages = await ctx.db.chatMessage.findMany({
        where: { workspaceId: ctx.workspaceId, threadId: thread.id },
        select: { id: true },
      });
      const purgedAttachments = await purgeChatMessageAttachments(
        ctx.db,
        ctx.workspaceId,
        messages.map((m) => m.id),
      );

      // (3) Delete the thread; ChatMessage rows cascade via FK.
      await ctx.db.$transaction(async (tx) => {
        await tx.chatThread.delete({ where: { id: thread.id } });
        await tx.auditLog.create({
          data: {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            entity: "ChatThread",
            entityId: thread.id,
            action: "delete",
            before: {
              title: thread.title,
              isDefault: thread.isDefault,
              agentId: thread.agentId,
              messageCount: messages.length,
            },
          },
        });
      });
      return {
        ok: true,
        deleted: true,
        stoppedRun,
        purgedAttachments,
        messageCount: messages.length,
      } as const;
    }),

  archiveThread: workspaceProcedure
    .input(z.object({ threadId: idString }))
    .mutation(async ({ ctx, input }) => {
      const thread = await ctx.db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId, userId: ctx.session.user.id },
        select: { id: true, archivedAt: true },
      });
      if (!thread) throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });
      if (thread.archivedAt) return { ok: true, archived: true } as const;
      const now = new Date();
      await ctx.db.$transaction(async (tx) => {
        await tx.chatThread.update({ where: { id: thread.id }, data: { archivedAt: now } });
        await tx.auditLog.create({
          data: {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            entity: "ChatThread",
            entityId: thread.id,
            action: "archive",
            before: { archivedAt: null },
            after: { archivedAt: now.toISOString() },
          },
        });
      });
      return { ok: true, archived: true } as const;
    }),

  restoreThread: workspaceProcedure
    .input(z.object({ threadId: idString }))
    .mutation(async ({ ctx, input }) => {
      const thread = await ctx.db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId, userId: ctx.session.user.id },
        select: { id: true, archivedAt: true },
      });
      if (!thread) throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });
      if (!thread.archivedAt) return { ok: true, archived: false } as const;
      await ctx.db.$transaction(async (tx) => {
        await tx.chatThread.update({ where: { id: thread.id }, data: { archivedAt: null } });
        await tx.auditLog.create({
          data: {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            entity: "ChatThread",
            entityId: thread.id,
            action: "restore",
            before: { archivedAt: thread.archivedAt?.toISOString() ?? null },
            after: { archivedAt: null },
          },
        });
      });
      return { ok: true, archived: false } as const;
    }),

  /**
   * Paginate older messages.
   */
  history: workspaceProcedure
    .input(
      z.object({
        threadId: idString,
        before: z.coerce.date().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const thread = await ctx.db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId, userId: ctx.session.user.id },
        select: { id: true },
      });
      if (!thread) return [];
      return ctx.db.chatMessage.findMany({
        where: {
          threadId: input.threadId,
          OR: [{ role: { not: ChatRole.USER } }, { dispatchedAt: { not: null } }],
          ...(input.before ? { createdAt: { lt: input.before } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: input.limit,
      });
    }),
});
