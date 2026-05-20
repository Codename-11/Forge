import { NextResponse, type NextRequest } from "next/server";
import { ChatRole, EventKind } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { recordChange } from "@/server/audit";
import {
  streamChatReply,
  type ChatStreamMessage,
} from "@/server/services/chat-stream";
import { logger } from "@/server/logger";

/**
 * Interactive chat streaming endpoint.
 *
 * The dispatch path (CHAT_MESSAGE_POSTED → WebhookDelivery → Hermes → MCP)
 * is still required for assignment-triggered wakes and existing tests.
 * This endpoint is the *interactive* path: the operator types, we open a
 * direct OpenAI-compatible streaming call to the provider configured on
 * `Agent.provider`, and pipe deltas back as Server-Sent Events.
 *
 * Lifecycle invariant: even on the streaming path, we still persist the USER
 * row with `dispatchedAt` set + emit CHAT_MESSAGE_POSTED via recordChange so
 * audit + activity-event consumers stay consistent. Payload carries
 * `streamed: true` so fan-out branches can skip the webhook dispatch.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface RequestBody {
  threadId: string;
  body: string;
  attachments?: string[];
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let parsed: RequestBody;
  try {
    parsed = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const threadId = String(parsed.threadId ?? "").trim();
  const body = String(parsed.body ?? "");
  if (!threadId || !body.trim()) {
    return NextResponse.json(
      { error: "threadId and non-empty body are required" },
      { status: 400 },
    );
  }
  if (body.length > 8000) {
    return NextResponse.json({ error: "body exceeds 8000 chars" }, { status: 400 });
  }

  // Owner + workspace scoping. We do this before opening the stream so
  // unauthorised requests get a clean 4xx instead of an empty SSE.
  const thread = await db.chatThread.findFirst({
    where: { id: threadId, userId, archivedAt: null },
    include: {
      agent: {
        select: {
          id: true,
          name: true,
          profileKey: true,
          provider: true,
          templateMarkdown: true,
          capabilities: true,
        },
      },
    },
  });
  if (!thread) {
    return NextResponse.json({ error: "Chat thread not found" }, { status: 404 });
  }
  const workspaceId = thread.workspaceId;
  const agent = thread.agent;

  // Persist the USER row and the audit/event in one transaction. Mirrors
  // `chat.send` so the inbox lifecycle stays honest, but tags the payload
  // `streamed: true` so the dispatch worker can no-op for this row.
  const { userMessageId } = await db.$transaction(async (tx) => {
    const now = new Date();
    await tx.chatThread.update({
      where: { id: thread.id },
      data: { lastMessageAt: now },
    });
    const message = await tx.chatMessage.create({
      data: {
        workspaceId,
        threadId: thread.id,
        role: ChatRole.USER,
        body,
        contextSnapshot: {} as never,
        dispatchedAt: now,
      },
    });
    await recordChange(tx, {
      workspaceId,
      actorId: userId,
      entity: "ChatMessage",
      entityId: message.id,
      action: "create",
      eventKind: EventKind.CHAT_MESSAGE_POSTED,
      subjectType: "chat-thread",
      subjectId: thread.id,
      payload: {
        threadId: thread.id,
        messageId: message.id,
        agentId: agent.id,
        role: "USER",
        body,
        streamed: true,
        attachments: [] as Prisma.InputJsonArray,
      },
    });
    return { userMessageId: message.id };
  });

  // Load recent history *after* the USER row is persisted so it appears in
  // the context array we send to the provider. Take last 20 chronological,
  // including the just-inserted user message.
  const recent = await db.chatMessage.findMany({
    where: {
      workspaceId,
      threadId: thread.id,
      OR: [{ role: { not: ChatRole.USER } }, { dispatchedAt: { not: null } }],
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { role: true, body: true },
  });
  const history = recent.reverse();

  const systemPrompt =
    `You are ${agent.name}. You're chatting with the operator inside Forge, a project ` +
    `management workspace. Be concise and direct. ` +
    (agent.capabilities && agent.capabilities.length > 0
      ? `Your capabilities: ${agent.capabilities.join(", ")}.\n\n`
      : "") +
    (agent.templateMarkdown ? `${agent.templateMarkdown}\n` : "");

  const messages: ChatStreamMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map<ChatStreamMessage>((m) => ({
      role: m.role === ChatRole.USER ? "user" : "assistant",
      content: m.body,
    })),
  ];

  // Create the placeholder AGENT row up front so the client gets a stable
  // messageId in the `meta` event — we fill its `body` + `contextSnapshot`
  // after the stream finishes (or aborts).
  const placeholder = await db.chatMessage.create({
    data: {
      workspaceId,
      threadId: thread.id,
      role: ChatRole.AGENT,
      body: "",
      outputStartedAt: new Date(),
    },
    select: { id: true },
  });
  const agentMessageId = placeholder.id;

  // Acknowledged-flag bookkeeping so the chat panel's dispatch state UI
  // transitions cleanly out of "wake-sent" when the streaming reply lands.
  void db.chatMessage
    .update({
      where: { id: userMessageId },
      data: { acknowledgedAt: new Date(), outputStartedAt: new Date() },
    })
    .catch(() => undefined);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* controller already closed */
        }
      };

      enqueue(sse("meta", { messageId: agentMessageId }));

      const assembled: string[] = [];
      const thinkingChunks: string[] = [];
      const toolBlocks: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
      const startedAt = Date.now();
      let errored = false;

      // Bridge the upstream provider stream → SSE writer.
      const abortController = new AbortController();
      req.signal.addEventListener("abort", () => abortController.abort());

      try {
        for await (const evt of streamChatReply({
          provider: agent.provider,
          messages,
          signal: abortController.signal,
        })) {
          if (req.signal.aborted) break;
          switch (evt.kind) {
            case "content":
              assembled.push(evt.delta);
              enqueue(sse("content", { delta: evt.delta }));
              break;
            case "thinking":
              thinkingChunks.push(evt.delta);
              enqueue(sse("thinking", { delta: evt.delta }));
              break;
            case "tool_use":
              toolBlocks.push({ id: evt.id, name: evt.name, args: evt.args });
              enqueue(
                sse("tool_use", { id: evt.id, name: evt.name, args: evt.args }),
              );
              break;
            case "error":
              errored = true;
              enqueue(sse("error", { message: evt.message }));
              break;
            case "done":
              // We finalise outside the loop so persistence happens once.
              break;
          }
        }
      } catch (err) {
        errored = true;
        const message = err instanceof Error ? err.message : "Stream failed.";
        enqueue(sse("error", { message }));
        logger.warn({ err, threadId: thread.id }, "chat-stream: route bridge failed");
      }

      const finalBody = assembled.join("");
      const thinkingFull = thinkingChunks.join("");
      const elapsedMs = Date.now() - startedAt;

      // Persist the AGENT row's final body + rehydration blocks. Even on
      // error we want the row populated (or removed) so the UI doesn't
      // leak an empty bubble. If the model produced nothing and we hit
      // an error, prefer a clear apology body over a blank row.
      const persistedBody =
        finalBody ||
        (errored
          ? "(no response — provider stream errored; check logs)"
          : "");

      try {
        if (!persistedBody && !thinkingFull && toolBlocks.length === 0) {
          // Nothing to keep — clean up the empty placeholder.
          await db.chatMessage.delete({ where: { id: agentMessageId } });
        } else {
          await db.chatMessage.update({
            where: { id: agentMessageId },
            data: {
              body: persistedBody,
              contextSnapshot: {
                streamed: true,
                provider: agent.provider,
                thinking: thinkingFull || undefined,
                tool_use: toolBlocks.length > 0 ? toolBlocks : undefined,
                elapsedMs,
              } as never,
            },
          });
          await db.chatThread.update({
            where: { id: thread.id },
            data: { lastMessageAt: new Date() },
          });
          // Emit CHAT_MESSAGE_POSTED for the persisted AGENT reply so other
          // browser tabs (and the threads-list invalidator) refresh.
          await recordChange(db, {
            workspaceId,
            actorId: null,
            entity: "ChatMessage",
            entityId: agentMessageId,
            action: "create",
            eventKind: EventKind.CHAT_MESSAGE_POSTED,
            subjectType: "chat-thread",
            subjectId: thread.id,
            payload: {
              threadId: thread.id,
              messageId: agentMessageId,
              agentId: agent.id,
              role: "AGENT",
              streamed: true,
              attachments: [] as Prisma.InputJsonArray,
            },
          });
        }
      } catch (err) {
        logger.warn(
          { err, threadId: thread.id },
          "chat-stream: failed to persist agent reply",
        );
      }

      enqueue(sse("done", { messageId: agentMessageId }));
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
