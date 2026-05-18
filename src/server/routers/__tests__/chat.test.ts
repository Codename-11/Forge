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
