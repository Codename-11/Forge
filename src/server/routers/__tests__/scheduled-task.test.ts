import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  Priority,
  ScheduledTaskAction,
  ScheduledTaskDeliveryType,
  ScheduledTaskRunTrigger,
  ScheduledTaskScheduleType,
} from "@prisma/client";
import {
  requireClaimedManualRun,
  scheduledTaskRouter,
} from "@/server/routers/scheduled-task";
import { executeScheduledTask, sweepScheduledTasks } from "@/server/services/scheduled-task";
import {
  buildContext,
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

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "ST" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = scheduledTaskRouter.createCaller(ctx);
  const project = await getPrisma().project.create({
    data: {
      workspaceId: fixture.workspace.id,
      name: "Automation output",
      key: `AUTO${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      createdById: fixture.user.id,
    },
  });
  return { fixture, caller, project };
}

const dailySchedule = {
  type: ScheduledTaskScheduleType.DAILY,
  timeOfDayMinutes: 9 * 60,
  timezone: "America/New_York",
} as const;

describe("scheduledTaskRouter", () => {
  it("rejects a manual run when its atomic claim is lost", () => {
    expect(() => requireClaimedManualRun(null)).toThrow(/changed before the run could start/i);
  });

  it("supports create, list, edit, pause, resume, run now, history, and confirmed delete", async () => {
    const { caller, project } = await setup();
    const created = await caller.create({
      name: "Morning brief",
      action: ScheduledTaskAction.CREATE_ISSUE,
      prompt: "Summarize overnight customer reports and list the top three follow-ups.",
      issueTitle: "Prepare morning customer brief",
      issuePriority: Priority.HIGH,
      deliveryType: ScheduledTaskDeliveryType.PROJECT,
      projectId: project.id,
      schedule: dailySchedule,
    });
    expect(created.nextRunAt).toBeInstanceOf(Date);

    const listed = await caller.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].project?.id).toBe(project.id);

    const updated = await caller.update({
      id: created.id,
      name: "Morning customer brief",
      action: ScheduledTaskAction.CREATE_ISSUE,
      prompt: "Summarize reports, identify owners, and list three follow-ups.",
      issueTitle: "Prepare customer brief",
      issuePriority: Priority.URGENT,
      deliveryType: ScheduledTaskDeliveryType.PROJECT,
      projectId: project.id,
      schedule: {
        type: ScheduledTaskScheduleType.WEEKLY,
        dayOfWeek: 1,
        timeOfDayMinutes: 8 * 60,
        timezone: "America/New_York",
      },
    });
    expect(updated.scheduleType).toBe(ScheduledTaskScheduleType.WEEKLY);

    const paused = await caller.pause({ id: created.id });
    expect(paused).toMatchObject({ enabled: false, status: "PAUSED", nextRunAt: null });
    await expect(caller.runNow({ id: created.id })).rejects.toThrow(/resume/i);

    const resumed = await caller.resume({ id: created.id });
    expect(resumed.enabled).toBe(true);
    expect(resumed.nextRunAt?.getTime()).toBeGreaterThan(Date.now());

    const result = await caller.runNow({ id: created.id });
    expect(result?.status).toBe("SUCCEEDED");
    const detail = await caller.get({ id: created.id });
    expect(detail.runs[0]).toMatchObject({ status: "SUCCEEDED", trigger: "MANUAL" });
    expect(detail.runs[0].outputIssue).toMatchObject({ title: "Prepare customer brief" });
    const issue = await getPrisma().issue.findUniqueOrThrow({
      where: { id: detail.runs[0].outputIssueId! },
    });
    expect(issue).toMatchObject({
      description: "Summarize reports, identify owners, and list three follow-ups.",
      projectId: project.id,
      priority: Priority.URGENT,
    });

    await getPrisma().scheduledTask.update({
      where: { id: created.id },
      data: { status: "RUNNING" },
    });
    const pausedWhileRunning = await caller.pause({ id: created.id });
    expect(pausedWhileRunning).toMatchObject({ enabled: false, status: "RUNNING" });
    await expect(caller.resume({ id: created.id })).rejects.toThrow(/current run/i);
    await getPrisma().scheduledTask.update({
      where: { id: created.id },
      data: { status: "SUCCEEDED" },
    });

    await expect(caller.delete({ id: created.id, confirmation: "wrong name" })).rejects.toThrow(
      /did not match/i,
    );
    await getPrisma().scheduledTask.update({
      where: { id: created.id },
      data: { status: "RUNNING" },
    });
    await expect(
      caller.delete({ id: created.id, confirmation: "Morning customer brief" }),
    ).rejects.toThrow(/running task cannot be deleted/i);
    await getPrisma().scheduledTask.update({
      where: { id: created.id },
      data: { status: "SUCCEEDED" },
    });
    await caller.delete({ id: created.id, confirmation: "Morning customer brief" });
    expect(await caller.list()).toEqual([]);
  });

  it("persists failure detail and advances a scheduled run to a future occurrence", async () => {
    const { caller, project } = await setup();
    const task = await caller.create({
      name: "Project follow-up",
      action: ScheduledTaskAction.CREATE_ISSUE,
      prompt: "Prepare the follow-up prompt.",
      issueTitle: "Project follow-up",
      issuePriority: Priority.NONE,
      deliveryType: ScheduledTaskDeliveryType.PROJECT,
      projectId: project.id,
      schedule: {
        type: ScheduledTaskScheduleType.INTERVAL,
        intervalMinutes: 30,
        timezone: "UTC",
      },
    });
    await getPrisma().project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });
    const dueAt = new Date(Date.now() - 60_000);
    await getPrisma().scheduledTask.update({
      where: { id: task.id },
      data: { nextRunAt: dueAt },
    });

    const result = await executeScheduledTask({
      taskId: task.id,
      trigger: ScheduledTaskRunTrigger.SCHEDULE,
      now: new Date(),
    });
    expect(result?.status).toBe("FAILED");

    const failed = await caller.get({ id: task.id });
    expect(failed.status).toBe("FAILED");
    expect(failed.lastError).toMatch(/project/i);
    expect(failed.consecutiveFailures).toBe(1);
    expect(failed.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    expect(failed.runs[0].error).toMatch(/project/i);
  });

  it("recovers stale runs and skips due tasks in archived workspaces", async () => {
    const { fixture, caller } = await setup();
    const task = await caller.create({
      name: "Recovery task",
      action: ScheduledTaskAction.CREATE_ISSUE,
      prompt: "Create a recovery issue.",
      issueTitle: "Recovery issue",
      issuePriority: Priority.NONE,
      deliveryType: ScheduledTaskDeliveryType.INBOX,
      projectId: null,
      schedule: {
        type: ScheduledTaskScheduleType.INTERVAL,
        intervalMinutes: 30,
        timezone: "UTC",
      },
    });
    const now = new Date();
    await getPrisma().scheduledTask.update({
      where: { id: task.id },
      data: {
        status: "RUNNING",
        lastRunAt: new Date(now.getTime() - 16 * 60_000),
        nextRunAt: new Date(now.getTime() + 14 * 60_000),
      },
    });
    await getPrisma().scheduledTaskRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        scheduledTaskId: task.id,
        trigger: ScheduledTaskRunTrigger.SCHEDULE,
        startedAt: new Date(now.getTime() - 16 * 60_000),
      },
    });

    const recovered = await sweepScheduledTasks(now);
    expect(recovered.recovered).toBe(1);
    const recoveredTask = await caller.get({ id: task.id });
    expect(recoveredTask).toMatchObject({ status: "FAILED", consecutiveFailures: 1 });
    expect(recoveredTask.runs[0]).toMatchObject({ status: "FAILED" });

    await getPrisma().scheduledTask.update({
      where: { id: task.id },
      data: { status: "ACTIVE", nextRunAt: new Date(now.getTime() - 60_000) },
    });
    await getPrisma().workspace.update({
      where: { id: fixture.workspace.id },
      data: { deletedAt: now },
    });
    const archived = await sweepScheduledTasks(now);
    expect(archived.claimed).toBe(0);
    expect(await getPrisma().scheduledTaskRun.count({ where: { scheduledTaskId: task.id } })).toBe(1);
    await getPrisma().workspace.update({
      where: { id: fixture.workspace.id },
      data: { deletedAt: null },
    });
  });

  it("requires an admin role for lifecycle mutations", async () => {
    const { fixture } = await setup();
    const member = scheduledTaskRouter.createCaller(
      await buildContext(fixture, { asUserId: fixture.secondUser.id }),
    );
    await expect(
      member.create({
        name: "No access",
        action: ScheduledTaskAction.CREATE_ISSUE,
        prompt: "Should not create.",
        issueTitle: "No access",
        issuePriority: Priority.NONE,
        deliveryType: ScheduledTaskDeliveryType.INBOX,
        projectId: null,
        schedule: dailySchedule,
      }),
    ).rejects.toThrow(/admin role required/i);
  });
});
