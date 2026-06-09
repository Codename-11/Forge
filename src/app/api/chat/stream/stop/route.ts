import { NextResponse, type NextRequest } from "next/server";
import { ChatRole } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { getRunsConnectorForAgent } from "@/server/services/dispatch/registry";
import { logger } from "@/server/logger";

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

  const runExternalId = readRunExternalId(message.contextSnapshot);
  if (!runExternalId) {
    return NextResponse.json({ error: "No live runtime run is linked yet" }, { status: 409 });
  }

  const effectiveProvider = message.thread.providerOverride ?? message.thread.agent.provider;
  const connector = getRunsConnectorForAgent({
    provider: effectiveProvider,
    runtime: message.thread.agent.runtime,
  });
  if (!connector?.stop) {
    return NextResponse.json({ error: "Runtime does not support stop" }, { status: 409 });
  }

  try {
    await connector.stop(runExternalId);
  } catch (err) {
    logger.warn({ err, threadId, messageId, runExternalId }, "chat-stream: stop failed");
    return NextResponse.json({ error: "Failed to stop runtime run" }, { status: 502 });
  }

  await db.chatMessage.update({
    where: { id: message.id },
    data: {
      body: message.body || "_(Reply stopped.)_",
      contextSnapshot: mergeContext(message.contextSnapshot, {
        stopRequestedAt: new Date().toISOString(),
        stopRequestedByUserId: session.user.id,
      }),
    },
  });

  return NextResponse.json({ ok: true, runExternalId });
}
