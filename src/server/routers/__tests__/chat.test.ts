import { describe, it, expect, afterAll, afterEach } from "vitest";
import { AgentRunStatus, ChatContextMode, ChatRole, EventKind, WebhookDeliveryStatus } from "@prisma/client";
import { chatRouter } from "@/server/routers/chat";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) {
    const f = fixtures.pop()!;
    await f.cleanup();
  }
});

afterAll(async () => {
  await disconnectPrisma();
});

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "CHT" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const agent = await prisma.agent.create({
    data: { workspaceId: fixture.workspace.id, profileKey: `v-${Date.now()}`, name: "Victor" },
  });
  const ctx = await buildContext(fixture);
  const caller = chatRouter.createCaller(ctx);
  return { fixture, prisma, agent, caller };
}

describe("chatRouter deferred dispatch", () => {
  it("supports multiple named conversations with the same agent while preserving one default DM", async () => {
    const { agent, caller } = await setup();

    const defaultThread = await caller.thread({ agentId: agent.id });
    const planning = await caller.createConversation({
      agentId: agent.id,
      title: "Launch planning",
      topic: "Scope the launch",
      contextMode: ChatContextMode.FULL_SUMMARY,
    });
    const debugging = await caller.createConversation({ agentId: agent.id, title: "Debugging" });

    expect(defaultThread.thread.isDefault).toBe(true);
    expect(planning.thread.isDefault).toBe(false);
    expect(debugging.thread.isDefault).toBe(false);
    expect(new Set([defaultThread.thread.id, planning.thread.id, debugging.thread.id]).size).toBe(3);

    const threads = await caller.threads();
    expect(threads.map((thread) => thread.id)).toEqual(
      expect.arrayContaining([defaultThread.thread.id, planning.thread.id, debugging.thread.id]),
    );
    expect(threads.find((thread) => thread.id === planning.thread.id)).toMatchObject({
      title: "Launch planning",
      topic: "Scope the launch",
      contextMode: "FULL_SUMMARY",
    });
  });

  it("dispatches user messages to a selected named conversation", async () => {
    const { agent, caller } = await setup();
    const conversation = await caller.createConversation({ agentId: agent.id, title: "Named thread" });

    const sent = await caller.send({
      agentId: agent.id,
      threadId: conversation.thread.id,
      body: "stay inside the named thread",
    });

    const defaultThread = await caller.thread({ agentId: agent.id });
    expect(sent.threadId).toBe(conversation.thread.id);
    expect(defaultThread.thread.id).not.toBe(conversation.thread.id);
    expect(defaultThread.messages).toHaveLength(0);
  });

  it("compacts a conversation into durable summary metadata", async () => {
    const { agent, caller, prisma, fixture } = await setup();
    const conversation = await caller.createConversation({ agentId: agent.id, title: "Compaction" });
    for (let i = 0; i < 4; i += 1) {
      await prisma.chatMessage.create({
        data: {
          workspaceId: fixture.workspace.id,
          threadId: conversation.thread.id,
          role: i % 2 === 0 ? ChatRole.USER : ChatRole.AGENT,
          body: `decision ${i}: keep context compact`,
          dispatchedAt: new Date(),
        },
      });
    }

    const result = await caller.compactThread({ threadId: conversation.thread.id });
    const event = await prisma.activityEvent.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.CHAT_THREAD_COMPACTED,
        subjectId: conversation.thread.id,
      },
    });

    expect(result.thread.summaryMarkdown).toContain("Conversation Summary");
    expect(result.summarizedMessageCount).toBeGreaterThan(0);
    expect(event?.payload).toMatchObject({ threadId: conversation.thread.id });

    const eventCountAfterFirstCompact = await prisma.activityEvent.count({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.CHAT_THREAD_COMPACTED,
        subjectId: conversation.thread.id,
      },
    });
    const repeated = await caller.compactThread({ threadId: conversation.thread.id });
    const eventCountAfterRepeatedCompact = await prisma.activityEvent.count({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.CHAT_THREAD_COMPACTED,
        subjectId: conversation.thread.id,
      },
    });

    expect(repeated.summarizedMessageCount).toBe(0);
    expect(repeated.thread.summaryMarkdown).toBe(result.thread.summaryMarkdown);
    expect(eventCountAfterRepeatedCompact).toBe(eventCountAfterFirstCompact);
  });

  it("creates pending messages without dispatching until dispatchMessage is called", async () => {
    const { prisma, agent, caller, fixture } = await setup();

    const pending = await caller.createPendingMessage({
      agentId: agent.id,
      body: "please inspect this file",
      context: { route: "/w/test/inbox" },
    });

    const before = await prisma.activityEvent.count({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.CHAT_MESSAGE_POSTED,
        subjectId: pending.threadId,
      },
    });
    expect(before).toBe(0);

    const rowBefore = await prisma.chatMessage.findUniqueOrThrow({
      where: { id: pending.messageId },
      select: { dispatchedAt: true },
    });
    expect(rowBefore.dispatchedAt).toBeNull();

    const hidden = await caller.thread({ agentId: agent.id });
    expect(hidden.messages.map((m) => m.id)).not.toContain(pending.messageId);

    const dispatched = await caller.dispatchMessage({ messageId: pending.messageId });
    expect(dispatched.dispatched).toBe(true);

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.CHAT_MESSAGE_POSTED,
        subjectId: pending.threadId,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      threadId: pending.threadId,
      messageId: pending.messageId,
      agentId: agent.id,
      role: "USER",
      body: "please inspect this file",
    });

    const rowAfter = await prisma.chatMessage.findUniqueOrThrow({
      where: { id: pending.messageId },
      select: { dispatchedAt: true },
    });
    expect(rowAfter.dispatchedAt).toBeInstanceOf(Date);
    const visible = await caller.thread({ agentId: agent.id });
    expect(visible.messages.map((m) => m.id)).toContain(pending.messageId);

    const second = await caller.dispatchMessage({ messageId: pending.messageId });
    expect(second.dispatched).toBe(false);
    const afterSecond = await prisma.activityEvent.count({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.CHAT_MESSAGE_POSTED,
        subjectId: pending.threadId,
      },
    });
    expect(afterSecond).toBe(1);
  });

  it("lists workspace chat threads with latest visible message and attachment summary", async () => {
    const { prisma, agent, caller, fixture } = await setup();
    const sent = await caller.send({ agentId: agent.id, body: "review the screenshots" });
    await prisma.attachment.create({
      data: {
        workspaceId: fixture.workspace.id,
        targetType: "chat-message",
        targetId: sent.messageId,
        kind: "FILE",
        filename: "screen.png",
        mimeType: "image/png",
        size: 12,
        url: "s3://bucket/screen.png",
      },
    });

    const threads = await caller.threads();

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: sent.threadId,
      latestMessage: {
        id: sent.messageId,
        role: "USER",
        body: "review the screenshots",
        attachmentCount: 1,
        hasImageAttachment: true,
      },
    });
  });

  it("fetches a selected chat thread by id with visible messages and attachment metadata", async () => {
    const { prisma, agent, caller, fixture } = await setup();
    const sent = await caller.send({ agentId: agent.id, body: "thread deep-link" });
    const attachment = await prisma.attachment.create({
      data: {
        workspaceId: fixture.workspace.id,
        targetType: "chat-message",
        targetId: sent.messageId,
        kind: "LINK",
        filename: "Runbook",
        mimeType: "text/url",
        size: 0,
        url: "https://example.com/runbook",
        externalUrl: "https://example.com/runbook",
        linkTitle: "Runbook",
      },
    });

    const thread = await caller.getThread({ threadId: sent.threadId });

    expect(thread).not.toBeNull();
    if (!thread) throw new Error("expected chat thread to be visible to owner");
    expect(thread.id).toBe(sent.threadId);
    expect(thread.agent.id).toBe(agent.id);
    expect(thread.messages).toHaveLength(1);
    expect(thread.diagnostics).toMatchObject({ latestUserMessageId: sent.messageId });
    expect(thread.messages[0]).toMatchObject({
      id: sent.messageId,
      body: "thread deep-link",
      attachments: [
        {
          id: attachment.id,
          filename: "Runbook",
          mimeType: "text/url",
          externalUrl: "https://example.com/runbook",
          targetType: "chat-message",
          targetId: sent.messageId,
        },
      ],
    });
  });

  it("does not expose chat threads owned by a different workspace member", async () => {
    const { agent, caller, fixture } = await setup();
    const sent = await caller.send({ agentId: agent.id, body: "private operator thread" });
    const secondCtx = await buildContext(fixture, { asUserId: fixture.secondUser.id });
    const secondCaller = chatRouter.createCaller(secondCtx);

    const threads = await secondCaller.threads();
    const fetched = await secondCaller.getThread({ threadId: sent.threadId });

    expect(threads.map((thread) => thread.id)).not.toContain(sent.threadId);
    expect(fetched).toBeNull();
  });

  it("includes finalized chat attachments in the dispatch payload and allows bodyless attachment dispatch", async () => {
    const { prisma, agent, caller, fixture } = await setup();
    const pending = await caller.createPendingMessage({ agentId: agent.id, body: "" });
    const att = await prisma.attachment.create({
      data: {
        workspaceId: fixture.workspace.id,
        targetType: "chat-message",
        targetId: pending.messageId,
        kind: "LINK",
        filename: "Spec",
        mimeType: "text/url",
        size: 0,
        url: "https://example.com/spec",
        externalUrl: "https://example.com/spec",
        linkTitle: "Spec",
      },
    });

    await caller.dispatchMessage({ messageId: pending.messageId });
    const event = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.CHAT_MESSAGE_POSTED,
        subjectId: pending.threadId,
      },
    });
    expect(event.payload).toMatchObject({
      messageId: pending.messageId,
      attachments: [
        {
          id: att.id,
          filename: "Spec",
          mimeType: "text/url",
          size: 0,
          kind: "LINK",
          externalUrl: "https://example.com/spec",
          targetType: "chat-message",
          targetId: pending.messageId,
        },
      ],
    });
  });

  it("keeps text-only chat.send as an immediate dispatch path", async () => {
    const { prisma, agent, caller, fixture } = await setup();
    const sent = await caller.send({ agentId: agent.id, body: "plain ping" });
    const message = await prisma.chatMessage.findUniqueOrThrow({
      where: { id: sent.messageId },
      select: { dispatchedAt: true },
    });
    expect(message.dispatchedAt).toBeInstanceOf(Date);
    const events = await prisma.activityEvent.count({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.CHAT_MESSAGE_POSTED,
        subjectId: sent.threadId,
      },
    });
    expect(events).toBe(1);
  });

  it("exposes diagnostics when the latest user message is waiting for a reply", async () => {
    const { agent, caller } = await setup();
    const sent = await caller.send({ agentId: agent.id, body: "are you there?" });

    const diagnostics = await caller.threadDiagnostics({ threadId: sent.threadId });
    const threads = await caller.threads({ state: "waiting" });

    expect(diagnostics).toMatchObject({
      latestUserMessageId: sent.messageId,
      latestAgentMessageAt: null,
      waitingForReply: true,
      lastRun: null,
    });
    expect(diagnostics.waitingMs).toBeGreaterThanOrEqual(0);
    expect(threads.map((thread) => thread.id)).toContain(sent.threadId);
  });

  it("clears waiting diagnostics when an agent reply is newer than the user message", async () => {
    const { prisma, agent, caller, fixture } = await setup();
    const sent = await caller.send({ agentId: agent.id, body: "ping" });
    await prisma.chatMessage.create({
      data: {
        workspaceId: fixture.workspace.id,
        threadId: sent.threadId,
        role: ChatRole.AGENT,
        body: "pong",
      },
    });

    const diagnostics = await caller.threadDiagnostics({ threadId: sent.threadId });
    expect(diagnostics.waitingForReply).toBe(false);
    expect(diagnostics.waitingMs).toBeNull();
    expect(diagnostics.latestAgentMessageAt).toBeInstanceOf(Date);
  });

  it("resolves linked sourceRunId diagnostics and redacts failed delivery text", async () => {
    const { prisma, agent, caller, fixture } = await setup();
    const issue = await createIssue(fixture, { title: "Chat-linked run" });
    const sent = await caller.send({ agentId: agent.id, body: "debug delivery" });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.ACTIVE,
        startedAt: new Date(Date.now() - 120_000),
        lastEventAt: new Date(Date.now() - 120_000),
        currentStep: "waiting on Hermes",
      },
    });
    await prisma.chatMessage.create({
      data: {
        workspaceId: fixture.workspace.id,
        threadId: sent.threadId,
        role: ChatRole.AGENT,
        body: "working on it",
        sourceRunId: run.id,
      },
    });
    const webhook = await prisma.webhook.create({
      data: {
        workspaceId: fixture.workspace.id,
        url: "https://example.invalid/webhook",
        secret: "secret",
        events: [EventKind.CHAT_MESSAGE_POSTED],
      },
    });
    const event = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.CHAT_MESSAGE_POSTED,
        subjectId: sent.threadId,
      },
      orderBy: { createdAt: "desc" },
    });
    await prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        eventId: event.id,
        status: WebhookDeliveryStatus.FAILED,
        attempt: 2,
        responseStatus: 500,
        responseBody:
          "Bearer super-secret-token url=https://forge.axiom-labs.dev/api/mcp/rpc token=abc123",
      },
    });

    const diagnostics = await caller.threadDiagnostics({ threadId: sent.threadId });
    expect(diagnostics.lastSourceRunId).toBe(run.id);
    expect(diagnostics.lastRun).toMatchObject({
      id: run.id,
      status: AgentRunStatus.ACTIVE,
      currentStep: "waiting on Hermes",
    });
    expect(diagnostics.lastDelivery).toMatchObject({
      status: WebhookDeliveryStatus.FAILED,
      attempts: 2,
    });
    expect(diagnostics.lastDelivery?.lastError).toContain("[REDACTED]");
    expect(diagnostics.lastDelivery?.lastError).not.toContain("super-secret-token");
    expect(diagnostics.lastDelivery?.lastError).not.toContain("forge.axiom-labs.dev");
  });

  it("archives and restores owner-scoped chat threads", async () => {
    const { agent, caller, fixture } = await setup();
    const sent = await caller.send({ agentId: agent.id, body: "archive me" });
    const secondCtx = await buildContext(fixture, { asUserId: fixture.secondUser.id });
    const secondCaller = chatRouter.createCaller(secondCtx);

    await expect(secondCaller.archiveThread({ threadId: sent.threadId })).rejects.toThrow();
    await caller.archiveThread({ threadId: sent.threadId });
    expect((await caller.threads()).map((thread) => thread.id)).not.toContain(sent.threadId);
    expect((await caller.threads({ archived: true })).map((thread) => thread.id)).toContain(
      sent.threadId,
    );
    await caller.restoreThread({ threadId: sent.threadId });
    expect((await caller.threads()).map((thread) => thread.id)).toContain(sent.threadId);
  });

  it("retries the latest dispatched user message with an audited dispatch event", async () => {
    const { prisma, agent, caller, fixture } = await setup();
    const sent = await caller.send({ agentId: agent.id, body: "retry this" });
    const before = await prisma.activityEvent.count({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.CHAT_MESSAGE_POSTED,
        subjectId: sent.threadId,
      },
    });

    const result = await caller.retryLastUserMessage({ threadId: sent.threadId });
    const after = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.CHAT_MESSAGE_POSTED,
        subjectId: sent.threadId,
      },
      orderBy: { createdAt: "asc" },
    });

    expect(result.ok).toBe(true);
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)?.payload).toMatchObject({ messageId: sent.messageId, retry: true });
  });

  it("kicks an active stale run only when it belongs to the thread agent", async () => {
    const { prisma, agent, caller, fixture } = await setup();
    const issue = await createIssue(fixture, { title: "Kickable run" });
    const sent = await caller.send({ agentId: agent.id, body: "stalled?" });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.ACTIVE,
        lastEventAt: new Date(Date.now() - 10 * 60_000),
        currentStep: "stalled in chat",
      },
    });

    const result = await caller.kickThreadRun({ threadId: sent.threadId, runId: run.id });
    const event = await prisma.activityEvent.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.AGENT_RUN_KICKED,
        subjectId: run.id,
      },
    });

    expect(result).toMatchObject({ ok: true, action: "kick", kicked: true });
    expect(event?.payload).toMatchObject({ runId: run.id, threadId: sent.threadId });
  });
});
