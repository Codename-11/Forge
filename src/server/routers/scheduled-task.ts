import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  EventKind,
  Priority,
  ScheduledTaskAction,
  ScheduledTaskDeliveryType,
  ScheduledTaskRunTrigger,
  ScheduledTaskScheduleType,
  ScheduledTaskStatus,
  type PrismaClient,
} from "@prisma/client";
import { adminProcedure, router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import {
  assertValidSchedule,
  nextScheduledRunAt,
  scheduleFromTask,
  type ScheduledTaskSchedule,
} from "@/server/services/scheduled-task-schedule";

const intervalSchedule = z.object({
  type: z.literal(ScheduledTaskScheduleType.INTERVAL),
  intervalMinutes: z.number().int().min(5).max(525_600),
  timezone: z.string().trim().min(1).max(100),
});
const dailySchedule = z.object({
  type: z.literal(ScheduledTaskScheduleType.DAILY),
  timeOfDayMinutes: z.number().int().min(0).max(1_439),
  timezone: z.string().trim().min(1).max(100),
});
const weeklySchedule = z.object({
  type: z.literal(ScheduledTaskScheduleType.WEEKLY),
  timeOfDayMinutes: z.number().int().min(0).max(1_439),
  dayOfWeek: z.number().int().min(0).max(6),
  timezone: z.string().trim().min(1).max(100),
});
const scheduleSchema = z.discriminatedUnion("type", [
  intervalSchedule,
  dailySchedule,
  weeklySchedule,
]);

const taskFields = {
  name: z.string().trim().min(1).max(100),
  action: z.nativeEnum(ScheduledTaskAction).default(ScheduledTaskAction.CREATE_ISSUE),
  prompt: z.string().trim().min(1).max(50_000),
  issueTitle: z.string().trim().min(1).max(300),
  issuePriority: z.nativeEnum(Priority).default(Priority.NONE),
  deliveryType: z.nativeEnum(ScheduledTaskDeliveryType),
  projectId: z.string().cuid().nullable(),
  schedule: scheduleSchema,
};

function flattenedSchedule(schedule: ScheduledTaskSchedule) {
  return {
    scheduleType: schedule.type,
    intervalMinutes: schedule.type === "INTERVAL" ? schedule.intervalMinutes : null,
    timeOfDayMinutes: schedule.type === "INTERVAL" ? null : schedule.timeOfDayMinutes,
    dayOfWeek: schedule.type === "WEEKLY" ? schedule.dayOfWeek : null,
    timezone: schedule.timezone,
  };
}

async function assertDeliveryTarget(
  db: PrismaClient,
  workspaceId: string,
  input: { deliveryType: ScheduledTaskDeliveryType; projectId: string | null },
) {
  if (input.deliveryType === ScheduledTaskDeliveryType.INBOX) {
    if (input.projectId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Inbox delivery cannot select a project.",
      });
    }
    return;
  }
  if (!input.projectId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a project delivery target." });
  }
  const project = await db.project.findFirst({
    where: { id: input.projectId, workspaceId, archived: false, deletedAt: null },
    select: { id: true },
  });
  if (!project) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Delivery project not found." });
  }
}

const taskInclude = {
  project: { select: { id: true, name: true, key: true, color: true } },
  runs: {
    orderBy: { createdAt: "desc" as const },
    take: 5,
    include: {
      outputIssue: { select: { id: true, number: true, title: true } },
    },
  },
};

export function requireClaimedManualRun<T>(result: T | null): T {
  if (!result) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "The task changed before the run could start. Refresh and try again.",
    });
  }
  return result;
}

export const scheduledTaskRouter = router({
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.db.scheduledTask.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: [{ enabled: "desc" }, { nextRunAt: "asc" }, { createdAt: "desc" }],
      include: taskInclude,
    }),
  ),

  get: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const task = await ctx.db.scheduledTask.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          ...taskInclude,
          runs: {
            orderBy: { createdAt: "desc" },
            take: 50,
            include: { outputIssue: { select: { id: true, number: true, title: true } } },
          },
        },
      });
      if (!task) throw new TRPCError({ code: "NOT_FOUND" });
      return task;
    }),

  create: adminProcedure.input(z.object(taskFields)).mutation(async ({ ctx, input }) => {
    try {
      assertValidSchedule(input.schedule as ScheduledTaskSchedule);
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: error instanceof Error ? error.message : "Invalid schedule.",
      });
    }
    await assertDeliveryTarget(ctx.db, ctx.workspaceId, input);
    const nextRunAt = nextScheduledRunAt(input.schedule as ScheduledTaskSchedule, new Date());
    return ctx.db.$transaction(async (tx) => {
      const task = await tx.scheduledTask.create({
        data: {
          workspaceId: ctx.workspaceId,
          createdById: ctx.session.user.id,
          name: input.name,
          action: input.action,
          prompt: input.prompt,
          issueTitle: input.issueTitle,
          issuePriority: input.issuePriority,
          deliveryType: input.deliveryType,
          projectId: input.projectId,
          ...flattenedSchedule(input.schedule as ScheduledTaskSchedule),
          nextRunAt,
        },
      });
      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        entity: "ScheduledTask",
        entityId: task.id,
        action: "create",
        after: { name: task.name, action: task.action, nextRunAt: nextRunAt.toISOString() },
        eventKind: EventKind.SCHEDULED_TASK_CREATED,
        subjectType: "scheduled-task",
        subjectId: task.id,
        payload: { name: task.name },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return task;
    });
  }),

  update: adminProcedure
    .input(z.object({ id: z.string().cuid(), ...taskFields }))
    .mutation(async ({ ctx, input }) => {
      try {
        assertValidSchedule(input.schedule as ScheduledTaskSchedule);
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Invalid schedule.",
        });
      }
      await assertDeliveryTarget(ctx.db, ctx.workspaceId, input);
      const current = await ctx.db.scheduledTask.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      if (!current) throw new TRPCError({ code: "NOT_FOUND" });
      if (current.status === ScheduledTaskStatus.RUNNING) {
        throw new TRPCError({ code: "CONFLICT", message: "Wait for the current run to finish." });
      }
      const nextRunAt = current.enabled
        ? nextScheduledRunAt(input.schedule as ScheduledTaskSchedule, new Date())
        : null;
      const task = await ctx.db.$transaction(async (tx) => {
        const updated = await tx.scheduledTask.updateMany({
          where: {
            id: current.id,
            workspaceId: ctx.workspaceId,
            enabled: current.enabled,
            status: { not: ScheduledTaskStatus.RUNNING },
          },
          data: {
            name: input.name,
            action: input.action,
            prompt: input.prompt,
            issueTitle: input.issueTitle,
            issuePriority: input.issuePriority,
            deliveryType: input.deliveryType,
            projectId: input.projectId,
            ...flattenedSchedule(input.schedule as ScheduledTaskSchedule),
            nextRunAt,
          },
        });
        if (updated.count !== 1) {
          throw new TRPCError({ code: "CONFLICT", message: "Wait for the current run to finish." });
        }
        const task = await tx.scheduledTask.findUniqueOrThrow({ where: { id: current.id } });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "ScheduledTask",
          entityId: task.id,
          action: "update",
          before: { name: current.name, nextRunAt: current.nextRunAt?.toISOString() ?? null },
          after: { name: task.name, nextRunAt: nextRunAt?.toISOString() ?? null },
          eventKind: EventKind.SCHEDULED_TASK_UPDATED,
          subjectType: "scheduled-task",
          subjectId: task.id,
          payload: { name: task.name },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return task;
      });
      return task;
    }),

  pause: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const current = await ctx.db.scheduledTask.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      if (!current) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.db.$transaction(async (tx) => {
        await tx.scheduledTask.update({
          where: { id: current.id },
          data: { enabled: false, nextRunAt: null },
        });
        await tx.scheduledTask.updateMany({
          where: { id: current.id, status: { not: ScheduledTaskStatus.RUNNING } },
          data: { status: ScheduledTaskStatus.PAUSED },
        });
        const task = await tx.scheduledTask.findUniqueOrThrow({ where: { id: current.id } });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "ScheduledTask",
          entityId: task.id,
          action: "pause",
          before: { enabled: current.enabled, nextRunAt: current.nextRunAt?.toISOString() ?? null },
          after: { enabled: false, nextRunAt: null },
          eventKind: EventKind.SCHEDULED_TASK_UPDATED,
          subjectType: "scheduled-task",
          subjectId: task.id,
          payload: { state: "paused" },
        });
        return task;
      });
    }),

  resume: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const current = await ctx.db.scheduledTask.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      if (!current) throw new TRPCError({ code: "NOT_FOUND" });
      if (current.status === ScheduledTaskStatus.RUNNING) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Wait for the current run to finish before resuming this task.",
        });
      }
      if (current.enabled) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This task is already active. Refresh to see its current schedule.",
        });
      }
      const schedule = scheduleFromTask(current);
      const nextRunAt = nextScheduledRunAt(schedule, new Date());
      return ctx.db.$transaction(async (tx) => {
        const updated = await tx.scheduledTask.updateMany({
          where: {
            id: current.id,
            workspaceId: ctx.workspaceId,
            enabled: false,
            status: { not: ScheduledTaskStatus.RUNNING },
          },
          data: { enabled: true, status: ScheduledTaskStatus.ACTIVE, nextRunAt },
        });
        if (updated.count !== 1) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "The task is already active or running. Refresh and try again.",
          });
        }
        const task = await tx.scheduledTask.findUniqueOrThrow({ where: { id: current.id } });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "ScheduledTask",
          entityId: task.id,
          action: "resume",
          before: { enabled: current.enabled },
          after: { enabled: true, nextRunAt: nextRunAt.toISOString() },
          eventKind: EventKind.SCHEDULED_TASK_UPDATED,
          subjectType: "scheduled-task",
          subjectId: task.id,
          payload: { state: "active" },
        });
        return task;
      });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().cuid(), confirmation: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const current = await ctx.db.scheduledTask.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      if (!current) throw new TRPCError({ code: "NOT_FOUND" });
      if (current.status === ScheduledTaskStatus.RUNNING) {
        throw new TRPCError({ code: "CONFLICT", message: "A running task cannot be deleted." });
      }
      if (input.confirmation !== current.name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Task name confirmation did not match.",
        });
      }
      return ctx.db.$transaction(async (tx) => {
        const deleted = await tx.scheduledTask.deleteMany({
          where: {
            id: current.id,
            workspaceId: ctx.workspaceId,
            status: { not: ScheduledTaskStatus.RUNNING },
          },
        });
        if (deleted.count !== 1) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A running task cannot be deleted.",
          });
        }
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "ScheduledTask",
          entityId: current.id,
          action: "delete",
          before: { name: current.name, action: current.action },
          eventKind: EventKind.SCHEDULED_TASK_DELETED,
          subjectType: "scheduled-task",
          subjectId: current.id,
          payload: { name: current.name },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return current;
      });
    }),

  runNow: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const task = await ctx.db.scheduledTask.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, enabled: true, status: true },
      });
      if (!task) throw new TRPCError({ code: "NOT_FOUND" });
      if (!task.enabled)
        throw new TRPCError({ code: "CONFLICT", message: "Resume this task first." });
      if (task.status === ScheduledTaskStatus.RUNNING) {
        throw new TRPCError({ code: "CONFLICT", message: "This task is already running." });
      }
      const { executeScheduledTask } = await import("@/server/services/scheduled-task");
      const result = await executeScheduledTask({
        taskId: task.id,
        trigger: ScheduledTaskRunTrigger.MANUAL,
        actorId: ctx.session.user.id,
      });
      return requireClaimedManualRun(result);
    }),
});
