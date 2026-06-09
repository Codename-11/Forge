import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EventKind } from "@prisma/client";
import { eventRouter } from "@/server/routers/event";
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
    const fixture = fixtures.pop()!;
    await fixture.cleanup();
  }
});

afterAll(async () => {
  await disconnectPrisma();
});

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "EVT" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const agent = await prisma.agent.create({
    data: {
      workspaceId: fixture.workspace.id,
      name: "Event Bot",
      profileKey: "event-bot",
    },
  });
  const caller = eventRouter.createCaller(await buildContext(fixture));
  const secondCaller = eventRouter.createCaller(
    await buildContext(fixture, { asUserId: fixture.secondUser.id }),
  );
  return { fixture, prisma, agent, caller, secondCaller };
}

describe("eventRouter", () => {
  it("includes owned chat activity without leaking another operator's threads", async () => {
    const { fixture, prisma, agent, caller, secondCaller } = await setup();
    const [ownedThread, otherThread] = await Promise.all([
      prisma.chatThread.create({
        data: {
          workspaceId: fixture.workspace.id,
          userId: fixture.user.id,
          agentId: agent.id,
          title: "Owned chat",
        },
      }),
      prisma.chatThread.create({
        data: {
          workspaceId: fixture.workspace.id,
          userId: fixture.secondUser.id,
          agentId: agent.id,
          title: "Other chat",
        },
      }),
    ]);

    const [ownedEvent, otherEvent] = await Promise.all([
      prisma.activityEvent.create({
        data: {
          workspaceId: fixture.workspace.id,
          kind: EventKind.CHAT_MESSAGE_POSTED,
          actorId: null,
          subjectType: "chat-thread",
          subjectId: ownedThread.id,
          payload: {
            threadId: ownedThread.id,
            messageId: "owned-message",
            agentId: agent.id,
            role: "AGENT",
            body: "owned reply",
          },
        },
      }),
      prisma.activityEvent.create({
        data: {
          workspaceId: fixture.workspace.id,
          kind: EventKind.CHAT_MESSAGE_POSTED,
          actorId: null,
          subjectType: "chat-thread",
          subjectId: otherThread.id,
          payload: {
            threadId: otherThread.id,
            messageId: "other-message",
            agentId: agent.id,
            role: "AGENT",
            body: "other reply",
          },
        },
      }),
    ]);

    const mine = await caller.recent({ limit: 20, mineOnly: false });
    expect(mine.events.map((event) => event.id)).toContain(ownedEvent.id);
    expect(mine.events.map((event) => event.id)).not.toContain(otherEvent.id);

    const mineOnly = await caller.recent({ limit: 20, mineOnly: true });
    expect(mineOnly.events.map((event) => event.id)).toContain(ownedEvent.id);
    expect(mineOnly.events.map((event) => event.id)).not.toContain(otherEvent.id);

    const other = await secondCaller.recent({ limit: 20, mineOnly: false });
    expect(other.events.map((event) => event.id)).toContain(otherEvent.id);
    expect(other.events.map((event) => event.id)).not.toContain(ownedEvent.id);

    await expect(caller.unreadCount({ since: new Date(0) })).resolves.toMatchObject({ count: 1 });
    await expect(secondCaller.unreadCount({ since: new Date(0) })).resolves.toMatchObject({
      count: 1,
    });
  });
});
