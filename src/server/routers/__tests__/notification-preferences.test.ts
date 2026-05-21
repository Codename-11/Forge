import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EventKind, NotificationDelivery } from "@prisma/client";
import { notificationRouter } from "@/server/routers/notification";
import { materializeRecentNotifications } from "@/server/services/notifications";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

/**
 * Notification preferences (migration 0050) — per-user, per-eventKind
 * opt-out. Default is enabled (no row = no opt-out); explicit
 * `setPreference({ enabled: false })` rows cause the materializer to
 * skip writing a NotificationState row for that user.
 */

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

async function setupWithAlertable() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "PRF" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const prisma = getPrisma();
  const caller = notificationRouter.createCaller(ctx);
  const issue = await createIssue(fixture);
  const agent = await prisma.agent.create({
    data: {
      workspaceId: fixture.workspace.id,
      name: "Victor",
      profileKey: `vic-${Date.now().toString(36)}`,
      status: "ONLINE",
    },
  });
  await prisma.issue.update({
    where: { id: issue.id },
    data: { assignedAgentId: agent.id },
  });
  return { fixture, ctx, caller, prisma, issue, agent };
}

async function emitStalled(
  setup: Awaited<ReturnType<typeof setupWithAlertable>>,
) {
  return setup.prisma.activityEvent.create({
    data: {
      workspaceId: setup.fixture.workspace.id,
      kind: EventKind.ISSUE_STALLED,
      actorId: setup.fixture.user.id,
      subjectType: "issue",
      subjectId: setup.issue.id,
      payload: {
        assignedAgentId: setup.agent.id,
        agentProfileKey: setup.agent.profileKey,
        slaMinutes: 15,
      },
      createdAt: new Date(),
    },
  });
}

describe("notificationRouter.preferences + setPreference", () => {
  it("upserts a workspace-scoped preference and renders it in preferences()", async () => {
    const setup = await setupWithAlertable();
    // First call → creates a new row.
    const row = await setup.caller.setPreference({
      eventKind: EventKind.ISSUE_STALLED,
      enabled: false,
    });
    expect(row.enabled).toBe(false);
    expect(row.workspaceId).toBe(setup.fixture.workspace.id);
    expect(row.delivery).toBe(NotificationDelivery.INBOX_ONLY);

    // Second call → updates the same row (upsert semantics).
    const updated = await setup.caller.setPreference({
      eventKind: EventKind.ISSUE_STALLED,
      enabled: true,
      delivery: NotificationDelivery.INBOX_AND_DIGEST,
    });
    expect(updated.id).toBe(row.id);
    expect(updated.enabled).toBe(true);
    expect(updated.delivery).toBe(NotificationDelivery.INBOX_AND_DIGEST);

    // Only one row in the table — upsert, not insert.
    const all = await setup.prisma.notificationPreference.count({
      where: { userId: setup.fixture.user.id },
    });
    expect(all).toBe(1);

    // preferences() renders this kind with the workspace source.
    const prefs = await setup.caller.preferences({ scope: "workspace" });
    const matched = prefs.items.find((i) => i.eventKind === EventKind.ISSUE_STALLED);
    expect(matched?.enabled).toBe(true);
    expect(matched?.source).toBe("workspace");
  });

  it("defaults every alertable kind to enabled when no row exists", async () => {
    const setup = await setupWithAlertable();
    const prefs = await setup.caller.preferences({ scope: "workspace" });
    for (const item of prefs.items) {
      expect(item.enabled).toBe(true);
      expect(item.source).toBe("default");
    }
  });

  it("materializer skips disabled kinds", async () => {
    const setup = await setupWithAlertable();
    // Disable ISSUE_STALLED for this workspace.
    await setup.caller.setPreference({
      eventKind: EventKind.ISSUE_STALLED,
      enabled: false,
    });
    // Emit a stalled event AFTER the preference is set.
    const event = await emitStalled(setup);

    // Force a materialization pass that includes our event id.
    await materializeRecentNotifications(setup.prisma, {
      workspaceId: setup.fixture.workspace.id,
      userId: setup.fixture.user.id,
      eventIds: [event.id],
    });

    // No NotificationState row should exist for this user+event.
    const state = await setup.prisma.notificationState.findFirst({
      where: {
        workspaceId: setup.fixture.workspace.id,
        userId: setup.fixture.user.id,
        eventId: event.id,
      },
    });
    expect(state).toBeNull();

    // The router's list view also sees nothing.
    const list = await setup.caller.list({ limit: 10 });
    const ids = list.notifications.map((n) => n.event.id);
    expect(ids).not.toContain(event.id);
  });

  it("workspace-scoped preference wins over a global preference for the same kind", async () => {
    const setup = await setupWithAlertable();
    // Global: disabled.
    await setup.caller.setPreference({
      eventKind: EventKind.ISSUE_STALLED,
      enabled: false,
      scope: "global",
    });
    // Workspace: explicitly re-enabled.
    await setup.caller.setPreference({
      eventKind: EventKind.ISSUE_STALLED,
      enabled: true,
      scope: "workspace",
    });

    const prefs = await setup.caller.preferences({ scope: "workspace" });
    const matched = prefs.items.find((i) => i.eventKind === EventKind.ISSUE_STALLED);
    expect(matched?.enabled).toBe(true);
    expect(matched?.source).toBe("workspace");

    // The materializer should write a row (workspace pref wins).
    const event = await emitStalled(setup);
    await materializeRecentNotifications(setup.prisma, {
      workspaceId: setup.fixture.workspace.id,
      userId: setup.fixture.user.id,
      eventIds: [event.id],
    });
    const state = await setup.prisma.notificationState.findFirst({
      where: {
        workspaceId: setup.fixture.workspace.id,
        userId: setup.fixture.user.id,
        eventId: event.id,
      },
    });
    expect(state).not.toBeNull();
  });
});
