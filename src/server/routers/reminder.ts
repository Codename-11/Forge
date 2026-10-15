import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, workspaceProcedure } from "@/server/trpc";
import { assertIssueForViewer } from "@/server/services/project-access";
import { visibleReminderWhere } from "@/server/services/issue-reminder";
import { isWebPushConfigured } from "@/server/services/web-push";

const futureDate = z
  .date()
  .refine((date) => date.getTime() > Date.now(), "Choose a future reminder time.");
const timezone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Choose a valid timezone.");

export const reminderRouter = router({
  deliveryOptions: protectedProcedure.query(async ({ ctx }) => ({
    browserPushAvailable:
      isWebPushConfigured() &&
      (await ctx.db.pushSubscription.count({
        where: { userId: ctx.session.user.id, revokedAt: null },
      })) > 0,
  })),
  forIssue: workspaceProcedure
    .input(z.object({ issueId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertIssueForViewer(ctx.db, ctx, input.issueId, "READ");
      return ctx.db.issueReminder.findFirst({
        where: {
          ...(await visibleReminderWhere(ctx.db, ctx.session.user.id, ctx.workspaceId)),
          issueId: input.issueId,
        },
      });
    }),

  set: workspaceProcedure
    .input(
      z.object({
        issueId: z.string().cuid(),
        remindAt: futureDate,
        timezone,
        browserPush: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        await assertIssueForViewer(tx, ctx, input.issueId, "READ");
        const issue = await tx.issue.findFirst({
          where: {
            id: input.issueId,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
            status: { category: { notIn: ["DONE", "CANCELED"] } },
          },
        });
        if (!issue)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Reminders are available on open items. Reopen this item before scheduling one.",
          });
        if (
          input.browserPush &&
          (!isWebPushConfigured() ||
            !(await tx.pushSubscription.count({
              where: { userId: ctx.session.user.id, revokedAt: null },
            })))
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Enable browser notifications before choosing browser delivery.",
          });
        }
        const data = {
          remindAt: input.remindAt,
          timezone: input.timezone,
          browserPush: input.browserPush,
          readAt: null,
          dismissedAt: null,
          notifiedAt: null,
        };
        const result = await tx.issueReminder.upsert({
          where: { userId_issueId: { userId: ctx.session.user.id, issueId: input.issueId } },
          create: {
            ...data,
            workspaceId: ctx.workspaceId,
            userId: ctx.session.user.id,
            issueId: input.issueId,
          },
          update: data,
        });
        // Personal scheduling is audited without a workspace ActivityEvent or agent wake.
        await tx.auditLog.create({
          data: {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            entity: "IssueReminder",
            entityId: result.id,
            action: "reminder-scheduled",
            after: {
              issueId: input.issueId,
              remindAt: input.remindAt.toISOString(),
              timezone: input.timezone,
              browserPush: input.browserPush,
            },
          },
        });
        return result;
      });
    }),

  due: protectedProcedure
    .input(
      z
        .object({ workspaceId: z.string().cuid().optional(), cursor: z.string().cuid().optional() })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const where = {
        ...(await visibleReminderWhere(ctx.db, ctx.session.user.id, input.workspaceId)),
        remindAt: { lte: new Date() },
      };
      const [items, total] = await Promise.all([
        ctx.db.issueReminder.findMany({
          where,
          orderBy: [{ remindAt: "desc" }, { id: "desc" }],
          take: 21,
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          include: {
            issue: { select: { id: true, number: true, title: true } },
            workspace: { select: { slug: true, key: true } },
          },
        }),
        ctx.db.issueReminder.count({ where }),
      ]);
      const hasMore = items.length > 20;
      const page = items.slice(0, 20);
      return { items: page, total, nextCursor: hasMore ? page[page.length - 1]?.id : undefined };
    }),

  read: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.issueReminder.updateMany({
        where: {
          id: input.id,
          userId: ctx.session.user.id,
          remindAt: { lte: new Date() },
          readAt: null,
        },
        data: { readAt: new Date() },
      });
    }),

  dismiss: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const reminder = await tx.issueReminder.findFirst({
          where: { id: input.id, userId: ctx.session.user.id },
        });
        if (!reminder) throw new TRPCError({ code: "NOT_FOUND" });
        const result = await tx.issueReminder.update({
          where: { id: reminder.id },
          data: { dismissedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            workspaceId: reminder.workspaceId,
            actorId: ctx.session.user.id,
            entity: "IssueReminder",
            entityId: reminder.id,
            action: "reminder-dismissed",
          },
        });
        return result;
      });
    }),

  snooze: protectedProcedure
    .input(z.object({ id: z.string().cuid(), remindAt: futureDate }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const reminder = await tx.issueReminder.findFirst({
          where: { ...(await visibleReminderWhere(tx, ctx.session.user.id)), id: input.id },
        });
        if (!reminder) throw new TRPCError({ code: "NOT_FOUND" });
        const result = await tx.issueReminder.update({
          where: { id: reminder.id },
          data: { remindAt: input.remindAt, readAt: null, notifiedAt: null },
        });
        await tx.auditLog.create({
          data: {
            workspaceId: reminder.workspaceId,
            actorId: ctx.session.user.id,
            entity: "IssueReminder",
            entityId: reminder.id,
            action: "reminder-rescheduled",
            after: { remindAt: input.remindAt.toISOString() },
          },
        });
        return result;
      });
    }),
});
