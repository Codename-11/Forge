import "server-only";
import {
  EventKind,
  ScheduledTaskRunStatus,
  ScheduledTaskRunTrigger,
  ScheduledTaskStatus,
} from "@prisma/client";
import { db } from "@/server/db";
import { recordChange } from "@/server/audit";
import { logger } from "@/server/logger";
import { createIssueWithSideEffects } from "@/server/services/issue-create";
import { nextScheduledRunAt, scheduleFromTask } from "@/server/services/scheduled-task-schedule";

const DUE_TASK_LIMIT = 50;
const STALE_RUN_MS = 15 * 60_000;
const STALE_RUN_ERROR =
  "The worker stopped before this run completed. Forge recovered the task; the next scheduled run remains active.";

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 8_000) || "Scheduled task failed with an unknown error.";
}

export async function executeScheduledTask(args: {
  taskId: string;
  trigger: ScheduledTaskRunTrigger;
  actorId?: string | null;
  now?: Date;
}) {
  const now = args.now ?? new Date();

  // Claim the task and persist the attempt before action execution. Scheduled
  // claims also advance nextRunAt in this transaction, making the future run
  // resilient to any action error that follows.
  const claimed = await db.$transaction(async (tx) => {
    const task = await tx.scheduledTask.findUnique({ where: { id: args.taskId } });
    if (!task || !task.enabled || task.status === ScheduledTaskStatus.RUNNING) return null;
    if (
      args.trigger === ScheduledTaskRunTrigger.SCHEDULE &&
      (!task.nextRunAt || task.nextRunAt.getTime() > now.getTime())
    ) {
      return null;
    }

    const scheduledForAt =
      args.trigger === ScheduledTaskRunTrigger.SCHEDULE ? task.nextRunAt : null;
    const overdueManualOccurrence =
      args.trigger === ScheduledTaskRunTrigger.MANUAL &&
      task.nextRunAt &&
      task.nextRunAt.getTime() <= now.getTime()
        ? task.nextRunAt
        : null;
    const occurrenceToAdvance = scheduledForAt ?? overdueManualOccurrence;
    const nextRunAt = occurrenceToAdvance
      ? nextScheduledRunAt(scheduleFromTask(task), now, occurrenceToAdvance)
      : task.nextRunAt;
    const updated = await tx.scheduledTask.updateMany({
      where: {
        id: task.id,
        enabled: true,
        status: { not: ScheduledTaskStatus.RUNNING },
        workspace: { deletedAt: null },
        ...(args.trigger === ScheduledTaskRunTrigger.SCHEDULE
          ? { nextRunAt: { not: null, lte: now } }
          : {}),
      },
      data: {
        status: ScheduledTaskStatus.RUNNING,
        lastRunAt: now,
        nextRunAt,
      },
    });
    if (updated.count !== 1) return null;

    const run = await tx.scheduledTaskRun.create({
      data: {
        workspaceId: task.workspaceId,
        scheduledTaskId: task.id,
        trigger: args.trigger,
        scheduledForAt,
        startedAt: now,
      },
    });
    await recordChange(tx, {
      workspaceId: task.workspaceId,
      actorId: args.actorId ?? task.createdById,
      entity: "ScheduledTaskRun",
      entityId: run.id,
      action: "start",
      after: { trigger: run.trigger, scheduledForAt, nextRunAt },
      eventKind: EventKind.SCHEDULED_TASK_RUN_STARTED,
      subjectType: "scheduled-task",
      subjectId: task.id,
      payload: { runId: run.id, trigger: run.trigger },
    });
    return { task, run, nextRunAt };
  });

  if (!claimed) return null;
  const { task, run } = claimed;

  try {
    if (task.action !== "CREATE_ISSUE") {
      throw new Error(`Unsupported scheduled task action: ${task.action}`);
    }
    if (task.deliveryType === "PROJECT" && !task.projectId) {
      throw new Error("The configured delivery project is no longer available.");
    }
    if (task.deliveryType === "PROJECT") {
      const project = await db.project.findFirst({
        where: {
          id: task.projectId!,
          workspaceId: task.workspaceId,
          archived: false,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!project) {
        throw new Error("The configured delivery project is no longer available.");
      }
    }

    const issue = await createIssueWithSideEffects({
      db,
      workspaceId: task.workspaceId,
      actorId: args.actorId ?? task.createdById,
      input: {
        title: task.issueTitle,
        description: task.prompt,
        priority: task.issuePriority,
        projectId: task.deliveryType === "PROJECT" ? task.projectId : null,
        eventPayload: {
          source: "scheduled-task",
          scheduledTaskId: task.id,
          scheduledTaskRunId: run.id,
        },
      },
    });

    const completedAt = new Date();
    await db.$transaction(async (tx) => {
      await tx.scheduledTaskRun.update({
        where: { id: run.id },
        data: {
          status: ScheduledTaskRunStatus.SUCCEEDED,
          outputIssueId: issue.id,
          completedAt,
        },
      });
      const current = await tx.scheduledTask.findUnique({
        where: { id: task.id },
        select: { enabled: true },
      });
      if (current) {
        await tx.scheduledTask.update({
          where: { id: task.id },
          data: {
            status: current.enabled ? ScheduledTaskStatus.SUCCEEDED : ScheduledTaskStatus.PAUSED,
            lastSucceededAt: completedAt,
            lastError: null,
            consecutiveFailures: 0,
          },
        });
      }
      await recordChange(tx, {
        workspaceId: task.workspaceId,
        actorId: args.actorId ?? task.createdById,
        entity: "ScheduledTaskRun",
        entityId: run.id,
        action: "succeed",
        after: { outputIssueId: issue.id, completedAt },
        eventKind: EventKind.SCHEDULED_TASK_RUN_SUCCEEDED,
        subjectType: "scheduled-task",
        subjectId: task.id,
        payload: { runId: run.id, issueId: issue.id },
      });
    });
    return { ...run, status: ScheduledTaskRunStatus.SUCCEEDED, outputIssueId: issue.id };
  } catch (error) {
    const message = errorMessage(error);
    const completedAt = new Date();
    await db.$transaction(async (tx) => {
      const existing = await tx.scheduledTaskRun.findUnique({ where: { id: run.id } });
      if (!existing) return;
      await tx.scheduledTaskRun.update({
        where: { id: run.id },
        data: { status: ScheduledTaskRunStatus.FAILED, error: message, completedAt },
      });
      const current = await tx.scheduledTask.findUnique({
        where: { id: task.id },
        select: { enabled: true },
      });
      if (current) {
        await tx.scheduledTask.update({
          where: { id: task.id },
          data: {
            status: current.enabled ? ScheduledTaskStatus.FAILED : ScheduledTaskStatus.PAUSED,
            lastError: message,
            consecutiveFailures: { increment: 1 },
          },
        });
      }
      await recordChange(tx, {
        workspaceId: task.workspaceId,
        actorId: args.actorId ?? task.createdById,
        entity: "ScheduledTaskRun",
        entityId: run.id,
        action: "fail",
        after: { error: message, completedAt },
        eventKind: EventKind.SCHEDULED_TASK_RUN_FAILED,
        subjectType: "scheduled-task",
        subjectId: task.id,
        payload: { runId: run.id, error: message },
      });
    });
    logger.warn({ err: error, taskId: task.id, runId: run.id }, "scheduled task run failed");
    return { ...run, status: ScheduledTaskRunStatus.FAILED, error: message };
  }
}

export async function sweepScheduledTasks(now = new Date()) {
  const staleBefore = new Date(now.getTime() - STALE_RUN_MS);
  const staleTasks = await db.scheduledTask.findMany({
    where: {
      status: ScheduledTaskStatus.RUNNING,
      lastRunAt: { lte: staleBefore },
      workspace: { deletedAt: null },
    },
    select: { id: true, workspaceId: true, createdById: true },
    take: DUE_TASK_LIMIT,
  });
  for (const task of staleTasks) {
    await db.$transaction(async (tx) => {
      const recovered = await tx.scheduledTask.updateMany({
        where: {
          id: task.id,
          status: ScheduledTaskStatus.RUNNING,
          lastRunAt: { lte: staleBefore },
        },
        data: {
          status: ScheduledTaskStatus.FAILED,
          lastError: STALE_RUN_ERROR,
          consecutiveFailures: { increment: 1 },
        },
      });
      if (recovered.count !== 1) return;
      const runs = await tx.scheduledTaskRun.updateMany({
        where: { scheduledTaskId: task.id, status: ScheduledTaskRunStatus.RUNNING },
        data: {
          status: ScheduledTaskRunStatus.FAILED,
          error: STALE_RUN_ERROR,
          completedAt: now,
        },
      });
      await recordChange(tx, {
        workspaceId: task.workspaceId,
        actorId: task.createdById,
        entity: "ScheduledTask",
        entityId: task.id,
        action: "recover-stale-run",
        after: { recoveredRuns: runs.count, error: STALE_RUN_ERROR },
        eventKind: EventKind.SCHEDULED_TASK_RUN_FAILED,
        subjectType: "scheduled-task",
        subjectId: task.id,
        payload: { recoveredRuns: runs.count, error: STALE_RUN_ERROR },
      });
    });
  }

  const due = await db.scheduledTask.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: now },
      status: { not: ScheduledTaskStatus.RUNNING },
      workspace: { deletedAt: null },
    },
    select: { id: true },
    orderBy: { nextRunAt: "asc" },
    take: DUE_TASK_LIMIT,
  });
  let succeeded = 0;
  let failed = 0;
  for (const task of due) {
    const result = await executeScheduledTask({
      taskId: task.id,
      trigger: ScheduledTaskRunTrigger.SCHEDULE,
      now,
    });
    if (result?.status === ScheduledTaskRunStatus.SUCCEEDED) succeeded += 1;
    if (result?.status === ScheduledTaskRunStatus.FAILED) failed += 1;
  }
  if (due.length) logger.info({ claimed: due.length, succeeded, failed }, "scheduled task sweep");
  return { recovered: staleTasks.length, claimed: due.length, succeeded, failed };
}
