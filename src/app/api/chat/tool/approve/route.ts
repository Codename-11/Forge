import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { EventKind, type Prisma } from "@prisma/client";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import {
  getPendingChatApproval,
  resolvePendingChatApproval,
} from "@/server/services/chat-stream-state";
import { publish } from "@/server/realtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ApproveBody {
  callId: string;
  approved: boolean;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ApproveBody;
  try {
    body = (await req.json()) as ApproveBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const callId = String(body.callId ?? "").trim();
  if (!callId) {
    return NextResponse.json({ error: "callId required" }, { status: 400 });
  }
  const approved = body.approved === true;

  const pending = await getPendingChatApproval(callId);
  if (!pending || pending.userId !== session.user.id) {
    return NextResponse.json(
      { ok: false, reason: "No pending approval for that callId." },
      { status: 404 },
    );
  }

  const message = await db.chatMessage.findFirst({
    where: {
      id: pending.messageId,
      workspaceId: pending.workspaceId,
      threadId: pending.threadId,
      thread: { userId: session.user.id, archivedAt: null },
    },
    select: { id: true, contextSnapshot: true },
  });
  if (!message) {
    return NextResponse.json({ error: "Approval chat turn not found" }, { status: 404 });
  }

  const resolved = await resolvePendingChatApproval(callId, { approved });
  if (!resolved) {
    return NextResponse.json(
      { ok: false, reason: "Approval was already resolved or expired." },
      { status: 409 },
    );
  }

  const snapshot =
    message.contextSnapshot &&
    typeof message.contextSnapshot === "object" &&
    !Array.isArray(message.contextSnapshot)
      ? ({ ...message.contextSnapshot } as Record<string, Prisma.JsonValue>)
      : {};
  const calls = Array.isArray(snapshot.tool_calls)
    ? snapshot.tool_calls.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const call = entry as Record<string, Prisma.JsonValue>;
        if (call.id !== callId) return entry;
        return {
          ...call,
          status: approved ? "approved" : "declined",
          summary: approved ? "Approved by operator." : "Declined by operator.",
          approvalResolvedAt: new Date().toISOString(),
        };
      })
    : [];
  await db.chatMessage.update({
    where: { id: message.id },
    data: {
      contextSnapshot: {
        ...snapshot,
        tool_calls: calls,
        streamUpdatedAt: new Date().toISOString(),
      } as Prisma.InputJsonObject,
    },
  });

  await publish({
    id: randomUUID(),
    workspaceId: pending.workspaceId,
    kind: EventKind.CHAT_MESSAGE_POSTED,
    subjectType: "chat-thread-state",
    subjectId: pending.threadId,
    payload: {
      phase: "approval-resolved",
      threadId: pending.threadId,
      messageId: pending.messageId,
      callId,
      approved,
    },
    actorId: session.user.id,
    createdAt: new Date().toISOString(),
  }).catch(() => undefined);

  return NextResponse.json({ ok: true, approved });
}
