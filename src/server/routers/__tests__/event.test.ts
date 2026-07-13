import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AgentRunStatus, EventKind, NotificationSeverity } from "@prisma/client";
import { eventRouter } from "@/server/routers/event";
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

  it("maps workspace activity into display-ready timeline rows", async () => {
    const { fixture, prisma, agent, caller } = await setup();
    const issue = await createIssue(fixture, { title: "Runtime auth blocker" });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.STALLED,
        summary: "Refresh token was revoked.",
      },
    });
    const event = await prisma.activityEvent.create({
      data: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.AGENT_RUN_STALLED,
        actorId: null,
        subjectType: "agent-run",
        subjectId: run.id,
        payload: {
          runId: run.id,
          issueId: issue.id,
          agentId: agent.id,
          summary: "Refresh token was revoked.",
        },
      },
    });

    const result = await caller.timeline({ filter: "agents", limit: 5 });
    const row = result.items.find((item) => item.id === event.id);

    expect(row).toBeTruthy();
    expect(row).toMatchObject({
      category: "decision",
      tone: "danger",
      href: `/w/${fixture.workspace.slug}/i/${fixture.workspace.key}-${issue.number}`,
    });
    expect(row?.title).toContain("@event-bot");
    expect(row?.detail).toContain("Refresh token");
  });

  it("groups recurring attention signals for one subject into the newest timeline row", async () => {
    const { fixture, prisma, agent, caller } = await setup();
    const issue = await createIssue(fixture, { title: "Wake-word follow-through" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });

    const events = await Promise.all(
      Array.from({ length: 7 }, (_, index) =>
        prisma.activityEvent.create({
          data: {
            workspaceId: fixture.workspace.id,
            kind: EventKind.ISSUE_STALLED,
            actorId: null,
            subjectType: "issue",
            subjectId: issue.id,
            payload: {
              issueId: issue.id,
              assignedAgentId: agent.id,
              lastUpdate: new Date().toISOString(),
              sequence: index,
            },
          },
        }),
      ),
    );

    const result = await caller.timeline({ filter: "decisions", limit: 5 });
    const matching = result.items.filter(
      (item) => item.kind === EventKind.ISSUE_STALLED && item.subject.id === issue.id,
    );

    expect(matching).toHaveLength(1);
    expect(events.map((event) => event.id)).toContain(matching[0]?.id);
    expect(matching[0]).toMatchObject({
      occurrences: 7,
      category: "decision",
      tone: "warning",
    });
    expect(matching[0]?.detail).toContain("open the issue to choose the next step");
  });

  it("rolls up agent attention by questions and blocked runs", async () => {
    const { fixture, prisma, agent, caller } = await setup();
    const issue = await createIssue(fixture, { title: "Review runtime access" });
    await prisma.actionRequest.create({
      data: {
        workspaceId: fixture.workspace.id,
        title: "Need repo access",
        body: "Can I read /home/bailey/forge?",
        severity: NotificationSeverity.WARNING,
        requestedByAgentId: agent.id,
        issueId: issue.id,
      },
    });
    await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.STALLED,
        summary: "The runtime cannot refresh its token.",
      },
    });

    const result = await caller.agentAttention({ limit: 5, itemLimit: 5 });
    const row = result.agents.find((item) => item.agent.id === agent.id);

    expect(row?.counts.questions).toBe(1);
    expect(row?.counts.blocked).toBe(1);
    expect(row?.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["question", "blocked"]),
    );
  });

  it("counts a runtime approval once instead of duplicating it as active work", async () => {
    const { fixture, prisma, agent, caller } = await setup();
    const issue = await createIssue(fixture, { title: "Approve temporary runtime access" });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.ACTIVE,
        currentStep: "needs permission to inspect deployment logs",
        awaitingApprovalAt: new Date(),
        pendingApproval: {
          command: "docker compose logs forge",
          description: "Temporary access requested.",
        },
      },
    });

    const result = await caller.agentAttention({ limit: 5, itemLimit: 5 });
    const row = result.agents.find((item) => item.agent.id === agent.id);

    expect(row?.counts).toMatchObject({ approvals: 1, activeRuns: 0, total: 1 });
    expect(row?.items).toHaveLength(1);
    expect(row?.items[0]).toMatchObject({
      id: `approval:${run.id}`,
      kind: "approval",
      title: "Runtime approval needed",
    });
    expect(row?.items[0]?.detail).toContain(fixture.workspace.key);
    expect(row?.items[0]?.detail).toContain("needs permission to inspect deployment logs");
  });
});
