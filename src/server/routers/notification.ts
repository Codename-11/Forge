import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  NotificationSeverity,
  NotificationStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import {
  ACTIVE_NOTIFICATION_STATUSES,
  buildNotificationListItems,
  materializeRecentNotifications,
  notificationStateInclude,
} from "@/server/services/notifications";

const listInput = z
  .object({
    status: z.array(z.nativeEnum(NotificationStatus)).min(1).optional(),
    severity: z.array(z.nativeEnum(NotificationSeverity)).min(1).optional(),
    cursor: z.string().cuid().optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .default({ limit: 30 });

const idInput = z.object({
  id: z.string().cuid(),
});

const markReadInput = z
  .object({
    id: z.string().cuid().optional(),
    all: z.boolean().default(false),
  })
  .refine((input) => input.all || Boolean(input.id), {
    message: "Provide `id` or set `all`.",
  });

export const notificationRouter = router({
  list: workspaceProcedure.input(listInput).query(async ({ ctx, input }) => {
    await materializeRecentNotifications(ctx.db, {
      workspaceId: ctx.workspaceId,
      userId: ctx.session.user.id,
      limit: Math.max(input.limit * 3, 100),
    });

    const cursorRow = input.cursor
      ? await ctx.db.notificationState.findFirst({
          where: {
            id: input.cursor,
            workspaceId: ctx.workspaceId,
            userId: ctx.session.user.id,
          },
          select: { createdAt: true },
        })
      : null;

    const where: Prisma.NotificationStateWhereInput = {
      workspaceId: ctx.workspaceId,
      userId: ctx.session.user.id,
      status: {
        in: input.status ?? [...ACTIVE_NOTIFICATION_STATUSES],
      },
      ...(input.severity ? { severity: { in: input.severity } } : {}),
      ...(cursorRow ? { createdAt: { lt: cursorRow.createdAt } } : {}),
    };

    const rows = await ctx.db.notificationState.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      include: notificationStateInclude(),
    });

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const notifications = await buildNotificationListItems(
      ctx.db,
      ctx.workspaceId,
      page,
    );

    return {
      notifications,
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    };
  }),

  unreadCount: workspaceProcedure.query(async ({ ctx }) => {
    await materializeRecentNotifications(ctx.db, {
      workspaceId: ctx.workspaceId,
      userId: ctx.session.user.id,
      limit: 100,
    });
    const count = await ctx.db.notificationState.count({
      where: {
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        status: NotificationStatus.UNREAD,
      },
    });
    return { count };
  }),

  upsert: workspaceProcedure
    .input(z.object({ eventId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await materializeRecentNotifications(ctx.db, {
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        eventIds: [input.eventId],
      });
      const row = await ctx.db.notificationState.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
          eventId: input.eventId,
        },
        include: notificationStateInclude(),
      });
      if (!row) return null;
      const [item] = await buildNotificationListItems(ctx.db, ctx.workspaceId, [
        row,
      ]);
      return item ?? null;
    }),

  markRead: workspaceProcedure.input(markReadInput).mutation(async ({ ctx, input }) => {
    const now = new Date();
    if (input.all) {
      await materializeRecentNotifications(ctx.db, {
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        limit: 100,
      });
      const result = await ctx.db.notificationState.updateMany({
        where: {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
          status: NotificationStatus.UNREAD,
        },
        data: {
          status: NotificationStatus.READ,
          readAt: now,
        },
      });
      return { count: result.count };
    }

    const item = await updateNotificationState(ctx, input.id!, {
      status: NotificationStatus.READ,
      readAt: now,
    });
    return { notification: item };
  }),

  dismiss: workspaceProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const now = new Date();
    const item = await updateNotificationState(ctx, input.id, {
      status: NotificationStatus.DISMISSED,
      readAt: now,
      dismissedAt: now,
    });
    return { notification: item };
  }),

  acknowledge: workspaceProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const now = new Date();
    const item = await updateNotificationState(ctx, input.id, {
      status: NotificationStatus.ACKNOWLEDGED,
      readAt: now,
      acknowledgedAt: now,
    });
    return { notification: item };
  }),

  resolve: workspaceProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const now = new Date();
    const item = await updateNotificationState(ctx, input.id, {
      status: NotificationStatus.RESOLVED,
      readAt: now,
      resolvedAt: now,
    });
    return { notification: item };
  }),
});

async function updateNotificationState(
  ctx: {
    db: PrismaClient | Prisma.TransactionClient;
    workspaceId: string;
    session: { user: { id: string } };
  },
  id: string,
  patch: Prisma.NotificationStateUpdateInput,
) {
  const existing = await ctx.db.notificationState.findFirst({
    where: {
      id,
      workspaceId: ctx.workspaceId,
      userId: ctx.session.user.id,
    },
    select: { id: true, readAt: true },
  });
  if (!existing) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Notification not found.",
    });
  }

  const data = {
    ...patch,
    readAt: existing.readAt ? undefined : patch.readAt,
  };
  const row = await ctx.db.notificationState.update({
    where: { id },
    data,
    include: notificationStateInclude(),
  });
  const [item] = await buildNotificationListItems(ctx.db, ctx.workspaceId, [row]);
  return item ?? null;
}
