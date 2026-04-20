import { z } from "zod";
import { router, adminProcedure } from "@/server/trpc";

/**
 * Admin-only server-wide observability: audit log, activity events,
 * webhook deliveries, workspace health. Gated to ADMIN/OWNER via
 * `adminProcedure`.
 */
export const adminRouter = router({
  stats: adminProcedure.query(async ({ ctx }) => {
    const [
      users,
      issues,
      openIssues,
      projects,
      plugins,
      approvedPlugins,
      apiKeys,
      activeApiKeys,
      webhookFailures,
      recentEvents,
    ] = await Promise.all([
      ctx.db.membership.count({ where: { workspaceId: ctx.workspaceId } }),
      ctx.db.issue.count({ where: { workspaceId: ctx.workspaceId, deletedAt: null } }),
      ctx.db.issue.count({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          status: { category: { notIn: ["DONE", "CANCELED"] } },
        },
      }),
      ctx.db.project.count({
        where: { workspaceId: ctx.workspaceId, deletedAt: null, archived: false },
      }),
      ctx.db.plugin.count({ where: { workspaceId: ctx.workspaceId } }),
      ctx.db.plugin.count({ where: { workspaceId: ctx.workspaceId, status: "APPROVED" } }),
      ctx.db.apiKey.count({ where: { workspaceId: ctx.workspaceId } }),
      ctx.db.apiKey.count({
        where: { workspaceId: ctx.workspaceId, revokedAt: null },
      }),
      ctx.db.webhookDelivery.count({
        where: {
          webhook: { workspaceId: ctx.workspaceId },
          status: "FAILED",
          scheduledAt: { gte: new Date(Date.now() - 86_400_000 * 7) },
        },
      }),
      ctx.db.activityEvent.count({
        where: {
          workspaceId: ctx.workspaceId,
          createdAt: { gte: new Date(Date.now() - 86_400_000) },
        },
      }),
    ]);
    return {
      users,
      issues,
      openIssues,
      projects,
      plugins,
      approvedPlugins,
      apiKeys,
      activeApiKeys,
      webhookFailures,
      recentEvents,
    };
  }),

  audit: adminProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
        entity: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.auditLog.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(input.entity ? { entity: input.entity } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        cursor: input.cursor ? { id: input.cursor } : undefined,
        include: { actor: { select: { id: true, name: true, email: true, image: true } } },
      });
      let nextCursor: string | undefined;
      if (rows.length > input.limit) nextCursor = rows.pop()!.id;
      return { items: rows, nextCursor };
    }),

  events: adminProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.activityEvent.findMany({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        cursor: input.cursor ? { id: input.cursor } : undefined,
        include: { actor: { select: { id: true, name: true, image: true } } },
      });
      let nextCursor: string | undefined;
      if (rows.length > input.limit) nextCursor = rows.pop()!.id;
      return { items: rows, nextCursor };
    }),

  deliveries: adminProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(200).default(50),
        status: z.enum(["PENDING", "SUCCESS", "FAILED", "DEAD_LETTER"]).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      return ctx.db.webhookDelivery.findMany({
        where: {
          webhook: { workspaceId: ctx.workspaceId },
          ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { scheduledAt: "desc" },
        take: input.limit,
        include: {
          webhook: { select: { id: true, url: true } },
          event: { select: { id: true, kind: true, subjectType: true, subjectId: true } },
        },
      });
    }),
});
