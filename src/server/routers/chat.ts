import { z } from "zod";
import { ChatRole, EventKind } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";

const ChatContextSchema = z.object({
  route: z.string().optional(),
  slug: z.string().optional(),
  issueId: z.string().optional(),
  selectedIds: z.array(z.string()).optional(),
  visibleEntities: z.array(z.object({ kind: z.string(), ids: z.array(z.string()) })).optional(),
  pinnedRunIds: z.array(z.string()).optional(),
  liveRunIds: z.array(z.string()).optional(),
}).partial();

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
    .input(z.object({ agentId: z.string().cuid() }))
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
        where: { threadId: thread.id },
        orderBy: { createdAt: "asc" },
        take: 50,
      });
      return { thread, agent, messages };
    }),

  /**
   * Send a user message. Persists, fans out via CHAT_MESSAGE_POSTED so
   * the audit/webhook layer dispatches to the agent.
   */
  send: workspaceProcedure
    .input(z.object({
      agentId: z.string().cuid(),
      body: z.string().min(1).max(8000),
      context: ChatContextSchema.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
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
            lastMessageAt: new Date(),
          },
          update: { lastMessageAt: new Date() },
        });
        const message = await tx.chatMessage.create({
          data: {
            workspaceId: ctx.workspaceId,
            threadId: thread.id,
            role: ChatRole.USER,
            body: input.body,
            contextSnapshot: (input.context ?? {}) as never,
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
          payload: {
            threadId: thread.id,
            messageId: message.id,
            agentId: input.agentId,
            role: "USER",
            body: input.body,
            context: input.context ?? {},
          },
        });
        return { threadId: thread.id, messageId: message.id };
      });
    }),

  /**
   * Agent-side append. Restricted to API keys whose linkedAgentId
   * matches the thread's agent.
   *
   * NOTE: ctx.apiKey exists on BaseContext (nullable). We read
   * ctx.apiKey?.linkedAgentId. On session-authenticated requests
   * (humans) this is null, so the FORBIDDEN check fires. Agents
   * calling this procedure must authenticate via an ApiKey that has
   * linkedAgentId set to the target agent's id.
   */
  appendAgentMessage: workspaceProcedure
    .input(z.object({
      threadId: z.string().cuid(),
      body: z.string().min(1).max(16_000),
      sourceRunId: z.string().cuid().optional(),
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
          payload: {
            threadId: thread.id,
            messageId: message.id,
            agentId: thread.agentId,
            role: "AGENT",
            sourceRunId: input.sourceRunId ?? null,
          },
        });
        return { messageId: message.id };
      });
    }),

  /**
   * Paginate older messages.
   */
  history: workspaceProcedure
    .input(z.object({
      threadId: z.string().cuid(),
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
          ...(input.before ? { createdAt: { lt: input.before } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: input.limit,
      });
    }),
});
