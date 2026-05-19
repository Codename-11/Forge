import { ChatContextMode, ChatRole, type Prisma, type PrismaClient } from "@prisma/client";

const DEFAULT_RECENT_LIMIT = 50;

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

type DbClient = Prisma.TransactionClient | PrismaClient;
type ChatAttachmentSummary = Prisma.AttachmentGetPayload<{ select: typeof chatAttachmentSelect }>;

type ContextSnapshot = {
  issueId?: string;
  selectedIds?: string[];
  pinnedRunIds?: string[];
  liveRunIds?: string[];
} | null;

async function loadChatAttachmentMap(
  db: DbClient,
  workspaceId: string,
  messageIds: string[],
): Promise<Map<string, ChatAttachmentSummary[]>> {
  if (messageIds.length === 0) return new Map();
  const attachments = await db.attachment.findMany({
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

function visibleMessageWhere(threadId: string, after?: Date | null): Prisma.ChatMessageWhereInput {
  return {
    threadId,
    OR: [{ role: { not: ChatRole.USER } }, { dispatchedAt: { not: null } }],
    ...(after ? { createdAt: { gt: after } } : {}),
  };
}

export async function buildChatContextBundle(
  db: DbClient,
  input: { workspaceId: string; threadId: string; limit?: number },
) {
  const limit = input.limit ?? DEFAULT_RECENT_LIMIT;
  const thread = await db.chatThread.findFirst({
    where: { id: input.threadId, workspaceId: input.workspaceId },
    select: {
      id: true,
      agentId: true,
      userId: true,
      title: true,
      topic: true,
      isDefault: true,
      contextMode: true,
      summaryMarkdown: true,
      summarizedUntilMessageId: true,
      summarizedAt: true,
      lastMessageAt: true,
      createdAt: true,
      archivedAt: true,
    },
  });
  if (!thread) throw new Error("Chat thread not found in this workspace.");

  const summarizedUntil = thread.summarizedUntilMessageId
    ? await db.chatMessage.findFirst({
        where: { id: thread.summarizedUntilMessageId, workspaceId: input.workspaceId },
        select: { id: true, createdAt: true },
      })
    : null;

  const includeSummary =
    thread.contextMode === ChatContextMode.SMART ||
    thread.contextMode === ChatContextMode.FULL_SUMMARY ||
    thread.contextMode === ChatContextMode.PINNED_CONTEXT;
  const afterSummary =
    thread.contextMode === ChatContextMode.SMART || thread.contextMode === ChatContextMode.PINNED_CONTEXT
      ? summarizedUntil?.createdAt
      : null;

  const messagesDesc = await db.chatMessage.findMany({
    where: visibleMessageWhere(thread.id, afterSummary),
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      role: true,
      body: true,
      contextSnapshot: true,
      sourceRunId: true,
      createdAt: true,
    },
  });
  const recentMessages = messagesDesc.reverse();
  const attachmentMap = await loadChatAttachmentMap(
    db,
    input.workspaceId,
    recentMessages.map((message) => message.id),
  );

  const issueIds = new Set<string>();
  const pinnedRunIds = new Set<string>();
  for (const message of recentMessages) {
    const snap = message.contextSnapshot as ContextSnapshot;
    if (snap?.issueId) issueIds.add(snap.issueId);
    for (const id of snap?.selectedIds ?? []) {
      if (/^[A-Z]+-\d+$/i.test(id)) issueIds.add(id);
    }
    for (const id of snap?.pinnedRunIds ?? []) pinnedRunIds.add(id);
    for (const id of snap?.liveRunIds ?? []) pinnedRunIds.add(id);
  }

  const linkedIssues = issueIds.size
    ? await db.issue.findMany({
        where: {
          workspaceId: input.workspaceId,
          id: { in: [...issueIds] },
        },
        select: {
          id: true,
          number: true,
          title: true,
          statusId: true,
          status: { select: { category: true, name: true } },
        },
        take: 10,
      })
    : [];

  const latestUser = [...recentMessages].reverse().find((m) => m.role === ChatRole.USER) ?? null;
  const latestAgent = [...recentMessages].reverse().find((m) => m.role === ChatRole.AGENT) ?? null;
  const waitingForReply = Boolean(
    latestUser && (!latestAgent || latestUser.createdAt.getTime() > latestAgent.createdAt.getTime()),
  );
  const now = Date.now();

  return {
    conversation: {
      id: thread.id,
      title: thread.title,
      topic: thread.topic,
      isDefault: thread.isDefault,
      contextMode: thread.contextMode,
      summaryMarkdown: includeSummary ? thread.summaryMarkdown : null,
      summarizedUntilMessageId: includeSummary ? thread.summarizedUntilMessageId : null,
      summarizedAt: includeSummary ? thread.summarizedAt : null,
    },
    thread,
    summary: includeSummary
      ? {
          markdown: thread.summaryMarkdown,
          summarizedUntilMessageId: thread.summarizedUntilMessageId,
          summarizedAt: thread.summarizedAt,
        }
      : null,
    recentMessages: recentMessages.map((message) => ({
      ...message,
      attachments: attachmentMap.get(message.id) ?? [],
    })),
    messages: recentMessages.map((message) => ({
      ...message,
      attachments: attachmentMap.get(message.id) ?? [],
    })),
    attachments: [...attachmentMap.values()].flat(),
    linkedIssues,
    diagnostics: {
      latestUserMessageId: latestUser?.id ?? null,
      latestUserMessageAt: latestUser?.createdAt ?? null,
      latestAgentMessageAt: latestAgent?.createdAt ?? null,
      waitingForReply,
      waitingMs: waitingForReply && latestUser ? Math.max(0, now - latestUser.createdAt.getTime()) : null,
    },
    contextPolicy: {
      mode: thread.contextMode,
      limit,
      includesSummary: includeSummary && Boolean(thread.summaryMarkdown),
      excludesSummarizedMessages: Boolean(afterSummary),
      pinnedRunIds: [...pinnedRunIds],
    },
  };
}
