import { afterAll, afterEach, describe, expect, it } from "vitest";
import { reminderRouter } from "@/server/routers/reminder";
import { issueRouter } from "@/server/routers/issue";
import { notificationRouter } from "@/server/routers/notification";
import {
  countDueReminders,
  markDueRemindersRead,
  sweepIssueReminders,
} from "@/server/services/issue-reminder";
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
  while (fixtures.length) await fixtures.pop()!.cleanup();
});
afterAll(disconnectPrisma);
const future = () => new Date(Date.now() + 3600_000);

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "RM" });
  fixtures.push(fixture);
  const issue = await createIssue(fixture);
  const owner = reminderRouter.createCaller(await buildContext(fixture));
  const member = reminderRouter.createCaller(
    await buildContext(fixture, { asUserId: fixture.secondUser.id }),
  );
  return { fixture, issue, owner, member, db: getPrisma() };
}

describe("private issue reminders", () => {
  it("reschedules one personal reminder without changing work or emitting agent activity", async () => {
    const { fixture, issue, owner, db } = await setup();
    const before = await db.activityEvent.count({ where: { workspaceId: fixture.workspace.id } });
    const first = await owner.set({
      issueId: issue.id,
      remindAt: future(),
      timezone: "America/New_York",
    });
    const second = await owner.set({
      issueId: issue.id,
      remindAt: new Date(Date.now() + 7200_000),
      timezone: "UTC",
    });
    expect(second.id).toBe(first.id);
    const concurrent = await Promise.all([
      owner.set({ issueId: issue.id, remindAt: new Date(Date.now() + 10800_000), timezone: "UTC" }),
      owner.set({ issueId: issue.id, remindAt: new Date(Date.now() + 14400_000), timezone: "UTC" }),
    ]);
    expect(new Set(concurrent.map((row) => row.id)).size).toBe(1);
    expect(await db.issueReminder.count({ where: { issueId: issue.id } })).toBe(1);
    expect(await db.activityEvent.count({ where: { workspaceId: fixture.workspace.id } })).toBe(
      before,
    );
    expect((await db.issue.findUniqueOrThrow({ where: { id: issue.id } })).dueDate).toBeNull();
    await expect(
      owner.set({ issueId: issue.id, remindAt: new Date(0), timezone: "UTC" }),
    ).rejects.toThrow(/future/);
    await expect(
      owner.set({ issueId: issue.id, remindAt: future(), timezone: "Invalid/Zone" }),
    ).rejects.toThrow(/timezone/);
  });

  it("isolates reminders by recipient and workspace, including unread lifecycle", async () => {
    const { fixture, issue, owner, member, db } = await setup();
    const reminder = await owner.set({ issueId: issue.id, remindAt: future(), timezone: "UTC" });
    await db.issueReminder.update({
      where: { id: reminder.id },
      data: { remindAt: new Date(Date.now() - 1000) },
    });
    expect((await owner.due({})).items.map((row) => row.id)).toEqual([reminder.id]);
    expect((await member.due({})).items).toEqual([]);
    expect(await member.forIssue({ issueId: issue.id })).toBeNull();
    await expect(member.dismiss({ id: reminder.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(member.snooze({ id: reminder.id, remindAt: future() })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await countDueReminders(db, fixture.user.id)).toBe(1);
    await markDueRemindersRead(db, fixture.user.id, fixture.workspace.id);
    expect(await countDueReminders(db, fixture.user.id)).toBe(0);
    expect((await owner.due({})).items).toHaveLength(1);
    await owner.snooze({ id: reminder.id, remindAt: future() });
    expect((await owner.due({})).items).toEqual([]);
    const other = await setup();
    expect((await owner.due({ workspaceId: other.fixture.workspace.id })).items).toEqual([]);
    await expect(
      owner.set({ issueId: other.issue.id, remindAt: future(), timezone: "UTC" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rechecks project access before surfacing or delivering a reminder", async () => {
    const { fixture, issue, member, db } = await setup();
    const project = await db.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "RM",
        name: "Restricted later",
        createdById: fixture.user.id,
      },
    });
    await db.issue.update({ where: { id: issue.id }, data: { projectId: project.id } });
    const reminder = await member.set({ issueId: issue.id, remindAt: future(), timezone: "UTC" });
    await db.issueReminder.update({
      where: { id: reminder.id },
      data: { remindAt: new Date(0), browserPush: true },
    });
    await db.project.update({ where: { id: project.id }, data: { visibility: "RESTRICTED" } });
    expect((await member.due({})).items).toEqual([]);
    expect(await countDueReminders(db, fixture.secondUser.id)).toBe(0);
    await sweepIssueReminders(db);
    expect(
      (await db.issueReminder.findUniqueOrThrow({ where: { id: reminder.id } })).dismissedAt,
    ).not.toBeNull();
  });

  it("completion cancels reminders permanently even if the issue is reopened", async () => {
    const { fixture, issue, owner, db } = await setup();
    const reminder = await owner.set({ issueId: issue.id, remindAt: future(), timezone: "UTC" });
    const done = await db.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });
    const todo = await db.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "TODO" },
    });
    const issues = issueRouter.createCaller(await buildContext(fixture));
    await issues.update({ id: issue.id, statusId: done.id });
    expect(
      (await db.issueReminder.findUniqueOrThrow({ where: { id: reminder.id } })).dismissedAt,
    ).not.toBeNull();
    await expect(
      owner.set({ issueId: issue.id, remindAt: future(), timezone: "UTC" }),
    ).rejects.toThrow(/open items/);
    await issues.update({ id: issue.id, statusId: todo.id });
    expect(await owner.forIssue({ issueId: issue.id })).toBeNull();
  });

  it("claims optional push only once across concurrent sweeps and respects rescheduling", async () => {
    const { fixture, issue, owner, db } = await setup();
    const reminder = await owner.set({ issueId: issue.id, remindAt: future(), timezone: "UTC" });
    await db.issueReminder.update({
      where: { id: reminder.id },
      data: { remindAt: new Date(0), browserPush: true },
    });
    const results = await Promise.all([sweepIssueReminders(db), sweepIssueReminders(db)]);
    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
    expect(await countDueReminders(db, fixture.user.id)).toBe(1);
    expect((await sweepIssueReminders(db)).claimed).toBe(0);
    await owner.snooze({ id: reminder.id, remindAt: future() });
    expect((await sweepIssueReminders(db)).claimed).toBe(0);
    expect(
      (await db.issueReminder.findUniqueOrThrow({ where: { id: reminder.id } })).notifiedAt,
    ).toBeNull();
  });

  it("cancels archived work and suppresses suspended recipients", async () => {
    const { fixture, issue, owner, db } = await setup();
    const reminder = await owner.set({ issueId: issue.id, remindAt: future(), timezone: "UTC" });
    const issues = issueRouter.createCaller(await buildContext(fixture));
    await issues.archive({ id: issue.id });
    expect(
      (await db.issueReminder.findUniqueOrThrow({ where: { id: reminder.id } })).dismissedAt,
    ).not.toBeNull();
    await issues.restore({ id: issue.id });
    await owner.set({ issueId: issue.id, remindAt: future(), timezone: "UTC" });
    await db.issueReminder.update({
      where: { id: reminder.id },
      data: { remindAt: new Date(0), browserPush: true },
    });
    await db.user.update({ where: { id: fixture.user.id }, data: { status: "SUSPENDED" } });
    expect((await owner.due({})).items).toEqual([]);
    expect((await sweepIssueReminders(db)).claimed).toBe(0);
  });

  it("includes private reminders in both bells and marks them read without dismissing", async () => {
    const { fixture, issue, owner, db } = await setup();
    const reminder = await owner.set({ issueId: issue.id, remindAt: future(), timezone: "UTC" });
    await db.issueReminder.update({ where: { id: reminder.id }, data: { remindAt: new Date(0) } });
    const notifications = notificationRouter.createCaller(await buildContext(fixture));
    expect((await notifications.unreadCount()).count).toBe(1);
    expect(await notifications.globalUnreadCount()).toMatchObject({
      count: 1,
      alerts: 0,
      reminders: 1,
    });
    expect((await notifications.globalMarkRead()).count).toBe(1);
    expect((await notifications.unreadCount()).count).toBe(0);
    expect((await owner.due({})).items).toHaveLength(1);
  });
});
