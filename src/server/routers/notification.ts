import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  EventKind,
  NotificationDelivery,
  NotificationSeverity,
  NotificationStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import { protectedProcedure, router, workspaceProcedure } from "@/server/trpc";
import {
  ACTIVE_NOTIFICATION_STATUSES,
  ALERTABLE_EVENT_KINDS,
  buildNotificationListItems,
  loadEffectivePreferenceMap,
  materializeRecentNotifications,
  notificationStateInclude,
  reconcileRecoveredNotifications,
} from "@/server/services/notifications";
import {
  getWebPushPublicKey,
  isWebPushConfigured,
  revokeBrowserPushSubscription,
  upsertBrowserPushSubscription,
} from "@/server/services/web-push";

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

const pushSubscriptionInput = z.object({
  endpoint: z.string().url().max(4096),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});

const unsubscribePushInput = z.object({
  endpoint: z.string().url().max(4096),
});

export const notificationRouter = router({
  pushConfig: protectedProcedure.query(() => ({
    enabled: isWebPushConfigured(),
    publicKey: getWebPushPublicKey(),
  })),

  subscribePush: protectedProcedure
    .input(pushSubscriptionInput)
    .mutation(async ({ ctx, input }) => {
      if (!isWebPushConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Web Push is not configured for this Forge instance.",
        });
      }
      const row = await upsertBrowserPushSubscription(ctx.db, {
        userId: ctx.session.user.id,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: ctx.userAgent,
      });
      return { id: row.id, endpoint: row.endpoint };
    }),

  unsubscribePush: protectedProcedure
    .input(unsubscribePushInput)
    .mutation(async ({ ctx, input }) => {
      return revokeBrowserPushSubscription(ctx.db, {
        userId: ctx.session.user.id,
        endpoint: input.endpoint,
      });
    }),

  list: workspaceProcedure.input(listInput).query(async ({ ctx, input }) => {
    await materializeRecentNotifications(ctx.db, {
      workspaceId: ctx.workspaceId,
      userId: ctx.session.user.id,
      limit: Math.max(input.limit * 3, 100),
    });
    await reconcileRecoveredNotifications(ctx.db, {
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
    const notifications = await buildNotificationListItems(ctx.db, ctx.workspaceId, page);

    return {
      notifications,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }),

  unreadCount: workspaceProcedure.query(async ({ ctx }) => {
    await materializeRecentNotifications(ctx.db, {
      workspaceId: ctx.workspaceId,
      userId: ctx.session.user.id,
      limit: 100,
    });
    await reconcileRecoveredNotifications(ctx.db, {
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
      const [item] = await buildNotificationListItems(ctx.db, ctx.workspaceId, [row]);
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

  /**
   * Return the calling user's notification preferences merged with
   * defaults. The result includes one row per *alertable* EventKind
   * the materializer cares about — kinds without an explicit row
   * default to `{ enabled: true, delivery: "INBOX_ONLY" }`, matching
   * the "no row = no opt-out" rule.
   *
   * Workspace-scoped preference rows take precedence over global
   * rows for the same kind. Pass `workspaceId` (defaulted to the
   * caller's current workspace) to see effective values for that
   * workspace; pass an explicit `null` via the `scope` argument to
   * list only global preferences.
   */
  preferences: workspaceProcedure
    .input(
      z
        .object({
          /**
           * Optional scope filter. Defaults to the caller's current
           * workspace, mirroring the workspaceProcedure context.
           * Pass `"global"` to list only the user's global rows.
           */
          scope: z.enum(["workspace", "global"]).default("workspace"),
        })
        .default({ scope: "workspace" }),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const scopeWorkspaceId = input.scope === "global" ? null : ctx.workspaceId;
      const effective = await loadEffectivePreferenceMap(ctx.db, {
        userId,
        workspaceId: scopeWorkspaceId,
      });
      // Render the merged view as one row per alertable EventKind so
      // the settings UI can checkbox-toggle each one without having
      // to know which rows actually exist in the DB.
      const items = ALERTABLE_EVENT_KINDS.map((kind) => {
        const row = effective.get(kind);
        return {
          eventKind: kind,
          enabled: row?.enabled ?? true,
          delivery: row?.delivery ?? NotificationDelivery.INBOX_ONLY,
          /** Which scope produced the effective value (null = default). */
          source: row?.source ?? ("default" as "workspace" | "global" | "default"),
        };
      });
      return { items, scopeWorkspaceId };
    }),

  /**
   * Upsert a notification preference for the calling user. Pass
   * `scope: "global"` to set the cross-workspace default. Otherwise
   * the row applies only to the caller's current workspace.
   */
  setPreference: workspaceProcedure
    .input(
      z.object({
        eventKind: z.nativeEnum(EventKind),
        enabled: z.boolean(),
        delivery: z.nativeEnum(NotificationDelivery).optional(),
        scope: z.enum(["workspace", "global"]).default("workspace"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const workspaceId = input.scope === "global" ? null : ctx.workspaceId;
      // Postgres treats NULL as distinct in multi-column unique
      // indexes — we add a partial unique index in the migration to
      // close that loophole, but Prisma's @@unique with a nullable
      // column won't model it. Run upsert via findFirst + create-or-
      // update so we don't fight the type system here.
      const existing = await ctx.db.notificationPreference.findFirst({
        where: {
          userId,
          workspaceId,
          eventKind: input.eventKind,
        },
        select: { id: true },
      });
      const data: Prisma.NotificationPreferenceUncheckedUpdateInput = {
        enabled: input.enabled,
        delivery: input.delivery ?? NotificationDelivery.INBOX_ONLY,
      };
      const row = existing
        ? await ctx.db.notificationPreference.update({
            where: { id: existing.id },
            data,
          })
        : await ctx.db.notificationPreference.create({
            data: {
              userId,
              workspaceId,
              eventKind: input.eventKind,
              enabled: input.enabled,
              delivery: input.delivery ?? NotificationDelivery.INBOX_ONLY,
            },
          });
      return row;
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
