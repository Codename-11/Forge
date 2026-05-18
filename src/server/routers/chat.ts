import { z } from "zod";
import { ChatRole, EventKind } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";

// Forge has mixed id formats across rows (some cuid v1, some hex). Use
// the same loose validator the rest of the codebase uses for entity ids.
const idString = z.string().min(1).max(40);

const ChatContextSchema = z.object({
  route: z.string().optional(),
  slug: z.string().optional(),
  issueId: z.string().optional(),
  selectedIds: z.array(z.string()).optional(),
  visibleEntities: z.array(z.object({ kind: z.string(), ids: z.array(z.string()) })).optional(),
  pinnedRunIds: z.array(z.string()).optional(),
  liveRunIds: z.array(z.string()).optional(),
}).partial();

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

export const chatRouter = router({
  /**
   * List chat threads the current user has with any agent. Empty when
   * the user hasn't started any chats yet.
   */
  threads: workspaceProcedure.query(async ({ ctx }) => {
    return ctx.db.chatThread.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        archivedAt: null,
      },
      orderBy: { lastMessageAt: "desc" },
      include: {
        agent: { select: { id: true, name: true, profileKey: true, avatar: true, status: true, role: true } },
        _count: { select: { messages: true } },
      },
      take: 50,
    });
  }),

  /**
   * Open / get a thread by agent. Upserts via the (workspaceId, userId,
   * agentId) unique. Returns thread + last 50 messages oldest-first.
   */
  thread: workspaceProcedure
    .input(z.object({ agentId: idString }))
    .mutation(async ({ ctx, input }) => {
      const agent = await ctx.db.agent.findFirst({
        where: { id: input.agentId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true, name: true, profileKey: true, avatar: true, status: true, role: true },
      });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      const thread = await ctx.db.chatThread.upsert({
        where: {
          workspaceId_userId_agentId: {
            workspaceId: ctx.workspaceId,
            userId: ctx.session.user.id,
            agentId: agent.id,
          },
        },
        create: {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
          agentId: agent.id,
        },
        update: {},
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

  /**
   * Send a user text-only message. This remains the immediate path: it
   * persists, marks dispatchedAt, then fans out CHAT_MESSAGE_POSTED so
   * webhooks/agents can respond.
   */
  send: workspaceProcedure
    .input(z.object({
      agentId: idString,
      body: z.string().min(1).max(8000),
      context: ChatContextSchema.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const now = new Date();
        const thread = await tx.chatThread.upsert({
          where: {
            workspaceId_userId_agentId: {
              workspaceId: ctx.workspaceId,
              userId: ctx.session.user.id,
              agentId: input.agentId,
            },
          },
          create: {
            workspaceId: ctx.workspaceId,
            userId: ctx.session.user.id,
            agentId: input.agentId,
            lastMessageAt: now,
          },
          update: { lastMessageAt: now },
        });
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
    .input(z.object({
      agentId: idString,
      body: z.string().max(8000).default(""),
      context: ChatContextSchema.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const agent = await ctx.db.agent.findFirst({
        where: { id: input.agentId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      const thread = await ctx.db.chatThread.upsert({
        where: {
          workspaceId_userId_agentId: {
            workspaceId: ctx.workspaceId,
            userId: ctx.session.user.id,
            agentId: input.agentId,
          },
        },
        create: {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
          agentId: input.agentId,
        },
        update: {},
      });
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
          throw new TRPCError({ code: "BAD_REQUEST", message: "Only user messages can be dispatched" });
        }
        if (message.thread.userId !== ctx.session.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only the thread owner may dispatch this message" });
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
    .input(z.object({
      threadId: idString,
      body: z.string().min(1).max(16_000),
      sourceRunId: idString.optional(),
    }))
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
          data: { lastMessageAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: null,
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

  /**
   * Paginate older messages.
   */
  history: workspaceProcedure
    .input(z.object({
      threadId: idString,
      before: z.coerce.date().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }))
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
