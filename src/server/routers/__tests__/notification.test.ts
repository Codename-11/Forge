import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  EventKind,
  NotificationStatus,
  ProjectAccessRole,
  ProjectVisibility,
} from "@prisma/client";
import { notificationRouter } from "@/server/routers/notification";
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "NTF" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = notificationRouter.createCaller(ctx);
  const prisma = getPrisma();
  const issue = await createIssue(fixture, { title: "Alerted issue" });
  const agent = await prisma.agent.create({
    data: {
      workspaceId: fixture.workspace.id,
      name: "Victor",
      profileKey: "victor",
      status: "ONLINE",
    },
  });
  await prisma.issue.update({
    where: { id: issue.id },
    data: { assignedAgentId: agent.id },
  });
  return { fixture, caller, prisma, issue, agent };
}

async function createStalledEvent(params: Awaited<ReturnType<typeof setup>>, createdAt: Date) {
  return params.prisma.activityEvent.create({
    data: {
      workspaceId: params.fixture.workspace.id,
      kind: EventKind.ISSUE_STALLED,
      actorId: params.fixture.user.id,
      subjectType: "issue",
      subjectId: params.issue.id,
      payload: {
        assignedAgentId: params.agent.id,
        agentProfileKey: params.agent.profileKey,
        slaMinutes: 15,
      },
      createdAt,
    },
  });
}

describe("notificationRouter", () => {
  it("does not fan out restricted alerts and hides already-materialized rows after revocation", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "NPA" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const membership = await prisma.membership.findUniqueOrThrow({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
    });
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "SECRET",
        name: "Secret",
        visibility: ProjectVisibility.RESTRICTED,
        createdById: fixture.user.id,
      },
    });
    const issue = await createIssue(fixture, { projectId: project.id, title: "Secret alert" });
    const agent = await prisma.agent.create({
      data: { workspaceId: fixture.workspace.id, name: "Private", profileKey: "private-alert" },
    });
    const event = await prisma.activityEvent.create({
      data: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.ISSUE_STALLED,
        subjectType: "issue",
        subjectId: issue.id,
        payload: { issueId: issue.id, assignedAgentId: agent.id },
      },
    });
    const caller = notificationRouter.createCaller(
      await buildContext(fixture, { asUserId: fixture.secondUser.id }),
    );

    expect((await caller.list({ limit: 10 })).notifications).toEqual([]);
    expect(
      await prisma.notificationState.count({
        where: { userId: fixture.secondUser.id, eventId: event.id },
      }),
    ).toBe(0);

    const grant = await prisma.projectAccess.create({
      data: {
        workspaceId: fixture.workspace.id,
        projectId: project.id,
        membershipId: membership.id,
        role: ProjectAccessRole.VIEWER,
        grantedById: fixture.user.id,
      },
    });
    expect((await caller.list({ limit: 10 })).notifications).toHaveLength(1);
    await prisma.projectAccess.delete({ where: { id: grant.id } });
    expect(await caller.unreadCount()).toEqual({ count: 0 });
    expect((await caller.list({ limit: 10 })).notifications).toEqual([]);
  });

  it("materializes alertable activity events into persisted notification state", async () => {
    const setupData = await setup();
    const event = await createStalledEvent(setupData, new Date("2026-04-26T12:00:00Z"));

    const unread = await setupData.caller.unreadCount();
    expect(unread.count).toBe(1);

    const list = await setupData.caller.list({ limit: 10 });
    expect(list.notifications).toHaveLength(1);
    expect(list.notifications[0].event.id).toBe(event.id);
    expect(list.notifications[0].status).toBe(NotificationStatus.UNREAD);
    expect(list.notifications[0].notification.summary).toContain("stalled");
    expect(list.notifications[0].notification.primaryHref).toContain(
      `/issues/${setupData.issue.id}`,
    );

    const state = await setupData.prisma.notificationState.findUniqueOrThrow({
      where: {
        workspaceId_userId_eventId: {
          workspaceId: setupData.fixture.workspace.id,
          userId: setupData.fixture.user.id,
          eventId: event.id,
        },
      },
    });
    expect(state.replacementKey).toBe(`issue:${setupData.issue.id}:stalled`);
    expect(state.importance).toBeGreaterThan(0);
    expect(state.createdAt.toISOString()).toBe(event.createdAt.toISOString());
  });

  it("shares unread alerts through the cross-workspace notification lifecycle", async () => {
    const setupData = await setup();
    const event = await createStalledEvent(setupData, new Date("2026-04-26T12:30:00Z"));

    await expect(setupData.caller.globalUnreadCount()).resolves.toEqual({ count: 1 });
    const alerts = await setupData.caller.globalList();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      status: NotificationStatus.UNREAD,
      workspace: {
        id: setupData.fixture.workspace.id,
        slug: setupData.fixture.workspace.slug,
      },
      event: { id: event.id },
    });

    await expect(setupData.caller.globalMarkRead()).resolves.toMatchObject({ count: 1 });
    await expect(setupData.caller.globalUnreadCount()).resolves.toEqual({ count: 0 });
    await expect(
      setupData.prisma.user.findUniqueOrThrow({
        where: { id: setupData.fixture.user.id },
        select: { lastInboxVisitAt: true },
      }),
    ).resolves.toMatchObject({ lastInboxVisitAt: expect.any(Date) });
  });

  it("persists read, acknowledge, dismiss, and resolve lifecycle state", async () => {
    const setupData = await setup();
    await createStalledEvent(setupData, new Date("2026-04-26T13:00:00Z"));
    const list = await setupData.caller.list({ limit: 10 });
    const id = list.notifications[0].id;

    await setupData.caller.markRead({ id });
    let state = await setupData.prisma.notificationState.findUniqueOrThrow({
      where: { id },
    });
    expect(state.status).toBe(NotificationStatus.READ);
    expect(state.readAt).toBeInstanceOf(Date);
    expect((await setupData.caller.unreadCount()).count).toBe(0);

    await setupData.caller.acknowledge({ id });
    state = await setupData.prisma.notificationState.findUniqueOrThrow({
      where: { id },
    });
    expect(state.status).toBe(NotificationStatus.ACKNOWLEDGED);
    expect(state.acknowledgedAt).toBeInstanceOf(Date);

    await setupData.caller.dismiss({ id });
    state = await setupData.prisma.notificationState.findUniqueOrThrow({
      where: { id },
    });
    expect(state.status).toBe(NotificationStatus.DISMISSED);
    expect(state.dismissedAt).toBeInstanceOf(Date);
    expect((await setupData.caller.list({ limit: 10 })).notifications).toHaveLength(0);

    await setupData.caller.resolve({ id });
    state = await setupData.prisma.notificationState.findUniqueOrThrow({
      where: { id },
    });
    expect(state.status).toBe(NotificationStatus.RESOLVED);
    expect(state.resolvedAt).toBeInstanceOf(Date);
  });

  it("uses replacementKey to keep only the latest matching alert active", async () => {
    const setupData = await setup();
    const older = await createStalledEvent(setupData, new Date("2026-04-26T14:00:00Z"));
    const newer = await createStalledEvent(setupData, new Date("2026-04-26T14:05:00Z"));

    const list = await setupData.caller.list({ limit: 10 });
    expect(list.notifications.map((n) => n.event.id)).toEqual([newer.id]);

    const states = await setupData.prisma.notificationState.findMany({
      where: {
        workspaceId: setupData.fixture.workspace.id,
        userId: setupData.fixture.user.id,
        eventId: { in: [older.id, newer.id] },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(states.map((state) => state.status)).toEqual([
      NotificationStatus.RESOLVED,
      NotificationStatus.UNREAD,
    ]);
    expect(states[0].replacementKey).toBe(states[1].replacementKey);
  });

  it("auto-resolves a stalled alert after later issue activity proves recovery", async () => {
    const setupData = await setup();
    const stalled = await createStalledEvent(setupData, new Date("2026-04-26T15:00:00Z"));

    expect((await setupData.caller.list({ limit: 10 })).notifications).toHaveLength(1);

    await setupData.prisma.activityEvent.create({
      data: {
        workspaceId: setupData.fixture.workspace.id,
        kind: EventKind.COMMENT_CREATED,
        actorId: setupData.fixture.user.id,
        subjectType: "issue",
        subjectId: setupData.issue.id,
        payload: { issueId: setupData.issue.id, body: "Are you still working on this?" },
        createdAt: new Date("2026-04-26T15:00:30Z"),
      },
    });
    expect((await setupData.caller.list({ limit: 10 })).notifications).toHaveLength(1);

    await setupData.prisma.activityEvent.create({
      data: {
        workspaceId: setupData.fixture.workspace.id,
        kind: EventKind.COMMENT_CREATED,
        actorAgentId: setupData.agent.id,
        subjectType: "issue",
        subjectId: setupData.issue.id,
        payload: { issueId: setupData.issue.id, body: "Recovered and replied." },
        createdAt: new Date("2026-04-26T15:01:00Z"),
      },
    });

    expect((await setupData.caller.list({ limit: 10 })).notifications).toHaveLength(0);
    expect((await setupData.caller.unreadCount()).count).toBe(0);

    const state = await setupData.prisma.notificationState.findUniqueOrThrow({
      where: {
        workspaceId_userId_eventId: {
          workspaceId: setupData.fixture.workspace.id,
          userId: setupData.fixture.user.id,
          eventId: stalled.id,
        },
      },
    });
    expect(state.status).toBe(NotificationStatus.RESOLVED);
    expect(state.resolvedAt).toBeInstanceOf(Date);
  });
});
