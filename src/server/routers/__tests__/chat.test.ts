import { describe, it, expect, afterAll, afterEach } from "vitest";
import { EventKind } from "@prisma/client";
import { chatRouter } from "@/server/routers/chat";
import {
  buildContext,
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
});
