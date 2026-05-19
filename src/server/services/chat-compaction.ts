import { ChatRole, EventKind, type Prisma, type PrismaClient } from "@prisma/client";
import { recordChange } from "@/server/audit";

const COMPACTION_MESSAGE_THRESHOLD = 80;
const COMPACTION_CHAR_THRESHOLD = 32_000;
const SUMMARY_KEEP_RECENT = 30;

type DbClient = Prisma.TransactionClient | PrismaClient;

function cleanLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function bulletFromMessage(message: { role: ChatRole; body: string; createdAt: Date }): string | null {
  const body = cleanLine(message.body);
  if (!body) return null;
  const clipped = body.length > 180 ? `${body.slice(0, 177)}…` : body;
  const speaker = message.role === ChatRole.USER ? "Operator" : message.role === ChatRole.AGENT ? "Agent" : "System";
  return `- ${speaker} (${message.createdAt.toISOString()}): ${clipped}`;
}

export function buildExtractiveChatSummary(input: {
  existingSummary?: string | null;
  messages: Array<{ id: string; role: ChatRole; body: string; createdAt: Date }>;
}): string {
  const bullets = input.messages.map(bulletFromMessage).filter(Boolean).slice(-40) as string[];
  const decisions = input.messages
    .filter((m) => /\b(decided|decision|ship|goal|plan|blocker|todo|follow[- ]?up)\b/i.test(m.body))
    .map(bulletFromMessage)
    .filter(Boolean)
    .slice(-15) as string[];
  const last = input.messages.at(-1);

  return [
    "## Conversation Summary",
    "",
    "### Prior summary",
    input.existingSummary?.trim() || "- _No prior summary._",
    "",
    "### Durable facts",
    ...(bullets.length ? bullets : ["- _No durable facts extracted yet._"]),
    "",
    "### Decisions / open threads",
    ...(decisions.length ? decisions : ["- _No explicit decisions or blockers detected._"]),
    "",
    "### Last summarized message",
    last ? `- ${last.id} at ${last.createdAt.toISOString()}` : "- _No messages summarized._",
  ].join("\n");
}

export async function findThreadsNeedingCompaction(
  db: DbClient,
  input: { workspaceId?: string; take?: number } = {},
) {
  const threads = await db.chatThread.findMany({
    where: {
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      archivedAt: null,
    },
    select: {
      id: true,
      workspaceId: true,
      summaryMarkdown: true,
      summarizedUntilMessageId: true,
      _count: { select: { messages: true } },
      messages: {
        where: { OR: [{ role: { not: ChatRole.USER } }, { dispatchedAt: { not: null } }] },
        orderBy: { createdAt: "desc" },
        take: 120,
        select: { body: true },
      },
    },
    take: input.take ?? 50,
  });

  return threads.filter((thread) => {
    const charCount = thread.messages.reduce((sum, message) => sum + message.body.length, 0);
    return thread._count.messages > COMPACTION_MESSAGE_THRESHOLD || charCount > COMPACTION_CHAR_THRESHOLD;
  });
}

export async function compactChatThread(
  db: DbClient,
  input: { workspaceId: string; threadId: string; actorId?: string | null; actor?: "worker" | "manual" },
) {
  const thread = await db.chatThread.findFirst({
    where: { id: input.threadId, workspaceId: input.workspaceId },
  });
  if (!thread) throw new Error("Chat thread not found in this workspace.");

  const messages = await db.chatMessage.findMany({
    where: {
      workspaceId: input.workspaceId,
      threadId: thread.id,
      OR: [{ role: { not: ChatRole.USER } }, { dispatchedAt: { not: null } }],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, body: true, createdAt: true },
  });
  const summarizedCursorIndex = thread.summarizedUntilMessageId
    ? messages.findIndex((message) => message.id === thread.summarizedUntilMessageId)
    : -1;
  const unsummarizedMessages = summarizedCursorIndex >= 0 ? messages.slice(summarizedCursorIndex + 1) : messages;

  if (unsummarizedMessages.length === 0) {
    return {
      thread,
      summarizedUntilMessageId: thread.summarizedUntilMessageId,
      summarizedMessageCount: 0,
    };
  }

  const compactable = unsummarizedMessages.slice(0, Math.max(0, unsummarizedMessages.length - SUMMARY_KEEP_RECENT));
  const source = compactable.length > 0 ? compactable : unsummarizedMessages;
  const summarizedUntil = source.at(-1) ?? null;
  const summaryMarkdown = buildExtractiveChatSummary({
    existingSummary: thread.summaryMarkdown,
    messages: source,
  });

  const updated = await db.chatThread.update({
    where: { id: thread.id },
    data: {
      summaryMarkdown,
      summarizedUntilMessageId: summarizedUntil?.id ?? thread.summarizedUntilMessageId,
      summarizedAt: new Date(),
    },
  });

  await recordChange(db, {
    workspaceId: input.workspaceId,
    actorId: input.actorId ?? null,
    entity: "ChatThread",
    entityId: thread.id,
    action: "compact",
    eventKind: EventKind.CHAT_THREAD_COMPACTED,
    subjectType: "chat-thread",
    subjectId: thread.id,
    payload: {
      threadId: thread.id,
      summarizedUntilMessageId: summarizedUntil?.id ?? thread.summarizedUntilMessageId,
      summarizedMessageCount: source.length,
      actor: input.actor ?? "manual",
    } as Prisma.InputJsonObject,
  });

  return {
    thread: updated,
    summarizedUntilMessageId: summarizedUntil?.id ?? thread.summarizedUntilMessageId,
    summarizedMessageCount: source.length,
  };
}

export async function sweepChatCompaction(db: DbClient, input: { workspaceId?: string } = {}) {
  const candidates = await findThreadsNeedingCompaction(db, { workspaceId: input.workspaceId, take: 25 });
  let compacted = 0;
  for (const candidate of candidates) {
    await compactChatThread(db, {
      workspaceId: candidate.workspaceId,
      threadId: candidate.id,
      actor: "worker",
    });
    compacted += 1;
  }
  return { compacted };
}
