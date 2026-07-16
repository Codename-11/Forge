import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { ChatRole, EventKind } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { getRunsConnectorForAgent } from "@/server/services/dispatch/registry";
import { requestChatStreamStop } from "@/server/services/chat-stream-state";
import { logger } from "@/server/logger";
import { publish } from "@/server/realtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type StopBody = {
  threadId?: unknown;
  messageId?: unknown;
};

function readRunExternalId(value: Prisma.JsonValue | null): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const runExternalId = (value as Record<string, unknown>).runExternalId;
  return typeof runExternalId === "string" && runExternalId.length > 0 ? runExternalId : null;
}

function mergeContext(
  value: Prisma.JsonValue | null,
  patch: Record<string, unknown>,
): Prisma.InputJsonObject {
  const base =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return { ...base, ...patch } as Prisma.InputJsonObject;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let parsed: StopBody;
  try {
    parsed = (await req.json()) as StopBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const threadId = typeof parsed.threadId === "string" ? parsed.threadId.trim() : "";
  const messageId = typeof parsed.messageId === "string" ? parsed.messageId.trim() : "";
  if (!threadId || !messageId) {
    return NextResponse.json({ error: "threadId and messageId are required" }, { status: 400 });
  }

  const message = await db.chatMessage.findFirst({
    where: {
      id: messageId,
      threadId,
      role: ChatRole.AGENT,
      thread: {
        userId: session.user.id,
        archivedAt: null,
      },
    },
    include: {
      thread: {
        include: {
          agent: {
            select: {
              id: true,
              provider: true,
              runtime: {
                select: {
                  adapterKey: true,
                  endpoint: true,
                  secret: true,
                  disabledAt: true,
                  name: true,
                  config: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!message) {
    return NextResponse.json({ error: "Streaming reply not found" }, { status: 404 });
  }
  const membership = await db.membership.findUnique({
    where: {
      userId_workspaceId: {
        userId: session.user.id,
        workspaceId: message.thread.workspaceId,
      },
    },
    select: { id: true },
  });
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const currentSnapshot =
    message.contextSnapshot &&
    typeof message.contextSnapshot === "object" &&
    !Array.isArray(message.contextSnapshot)
      ? (message.contextSnapshot as Record<string, unknown>)
      : {};
  const currentStatus =
    typeof currentSnapshot.status === "string" ? currentSnapshot.status.toLowerCase() : "";
  if (
    currentSnapshot.running !== true ||
    currentSnapshot.stopped === true ||
    ["stopped", "completed", "failed", "cancelled"].includes(currentStatus)
  ) {
    return NextResponse.json({
      ok: true,
      alreadyTerminal: true,
      runExternalId: readRunExternalId(message.contextSnapshot),
    });
  }

  const runExternalId = readRunExternalId(message.contextSnapshot);
  const effectiveProvider = message.thread.providerOverride ?? message.thread.agent.provider;
  const connector = getRunsConnectorForAgent({
    provider: effectiveProvider,
    runtime: message.thread.agent.runtime,
  });
  let remoteHandled = false;
  try {
    if (runExternalId && connector?.stop) {
      await connector.stop(runExternalId);
      remoteHandled = true;
    }
    await requestChatStreamStop(message.id, remoteHandled);
  } catch (err) {
    logger.warn({ err, threadId, messageId, runExternalId }, "chat-stream: stop failed");
    const failedAt = new Date().toISOString();
    const result = await db.chatMessage.updateMany({
      where: {
        id: message.id,
        contextSnapshot: { path: ["running"], equals: true },
      },
      data: {
        contextSnapshot: mergeContext(message.contextSnapshot, {
          stopFailedAt: failedAt,
          stopError: "Runtime rejected the stop request.",
          running: true,
          status: "running",
          streamUpdatedAt: failedAt,
        }),
      },
    });
    if (result.count === 0) {
      return NextResponse.json({ ok: true, alreadyTerminal: true, runExternalId });
    }
    await publish({
      id: randomUUID(),
      workspaceId: message.workspaceId,
      kind: EventKind.CHAT_MESSAGE_POSTED,
      subjectType: "chat-thread-state",
      subjectId: threadId,
      payload: { phase: "stop-failed", threadId, messageId },
      actorId: session.user.id,
      createdAt: failedAt,
    }).catch(() => undefined);
    return NextResponse.json({ error: "Failed to stop runtime run" }, { status: 502 });
  }

  const stoppedAt = new Date().toISOString();
  await db.chatMessage.update({
    where: { id: message.id },
    data: {
      body: message.body || "_(Reply stopped.)_",
      contextSnapshot: mergeContext(message.contextSnapshot, {
        stopRequestedAt: new Date().toISOString(),
        stopRequestedByUserId: session.user.id,
        stoppedAt,
        finishedAt: stoppedAt,
        stopped: true,
        running: false,
        status: "stopped",
        streamUpdatedAt: stoppedAt,
      }),
    },
  });

  await publish({
    id: randomUUID(),
    workspaceId: message.workspaceId,
    kind: EventKind.CHAT_MESSAGE_POSTED,
    subjectType: "chat-thread-state",
    subjectId: threadId,
    payload: { phase: "stopped", threadId, messageId, runExternalId },
    actorId: session.user.id,
    createdAt: stoppedAt,
  }).catch(() => undefined);

  return NextResponse.json({ ok: true, runExternalId, remoteHandled });
}
