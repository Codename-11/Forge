import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { router, adminProcedure } from "@/server/trpc";
import { webhookQueue } from "@/server/queues";
import {
  AGENT_DISPATCH_WEBHOOK_URL,
  agentDispatchUrlFor,
} from "@/server/audit";

/**
 * Cap on `responseBody` length we ship to the client. The worker
 * already trims to 8KB on write, but the inspection UI only needs the
 * head — 2KB is plenty to eyeball a failure without hauling giant
 * payloads over the wire.
 */
const RESPONSE_BODY_PREVIEW_BYTES = 2_048;
const webhookDeliveryStatus = z.enum([
  "PENDING",
  "SUCCESS",
  "FAILED",
  "DEAD_LETTER",
]);
const agentIdFilter = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-zA-Z0-9_-]+$/);

const webhookDeliveryInclude = {
  webhook: {
    select: {
      id: true,
      url: true,
      pluginId: true,
      events: true,
    },
  },
  event: {
    select: {
      id: true,
      kind: true,
      subjectType: true,
      subjectId: true,
      createdAt: true,
      payload: true,
    },
  },
} satisfies Prisma.WebhookDeliveryInclude;

function truncateResponseBody(body: string | null): string | null {
  if (body == null) return null;
  return body.length > RESPONSE_BODY_PREVIEW_BYTES
    ? body.slice(0, RESPONSE_BODY_PREVIEW_BYTES)
    : body;
}

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

  /**
   * Dead-letter queue inspection + recovery. Lives under its own nested
   * router so call-sites read as `admin.webhookDeliveries.list` /
   * `.retry` — matches the UI routing and leaves the shallow
   * `admin.deliveries` surface free for future compact summaries.
   */
  webhookDeliveries: router({
    list: adminProcedure
      .input(
        z.object({
          status: webhookDeliveryStatus.optional(),
          deliveryId: z.string().min(1).max(40).optional(),
          agentId: agentIdFilter.optional(),
          limit: z.number().int().min(1).max(200).default(50),
          cursor: z.string().optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const where: Prisma.WebhookDeliveryWhereInput = {
          webhook: { workspaceId: ctx.workspaceId },
          ...(input.status ? { status: input.status } : {}),
        };

        if (input.agentId) {
          where.OR = [
            {
              webhook: {
                workspaceId: ctx.workspaceId,
                url: agentDispatchUrlFor(input.agentId),
              },
            },
            {
              webhook: {
                workspaceId: ctx.workspaceId,
                url: AGENT_DISPATCH_WEBHOOK_URL,
              },
              event: {
                payload: {
                  path: ["agentId"],
                  equals: input.agentId,
                } as Prisma.JsonFilter,
              },
            },
          ];
        }

        const rows = await ctx.db.webhookDelivery.findMany({
          where,
          orderBy: [{ scheduledAt: "desc" }, { id: "desc" }],
          take: input.limit + 1,
          cursor: input.cursor ? { id: input.cursor } : undefined,
          skip: input.cursor ? 1 : 0,
          include: webhookDeliveryInclude,
        });
        let nextCursor: string | undefined;
        if (rows.length > input.limit) nextCursor = rows.pop()!.id;
        if (input.deliveryId && !rows.some((row) => row.id === input.deliveryId)) {
          const selected = await ctx.db.webhookDelivery.findFirst({
            where: {
              id: input.deliveryId,
              webhook: { workspaceId: ctx.workspaceId },
            },
            include: webhookDeliveryInclude,
          });
          if (selected) rows.unshift(selected);
        }
        // Truncate response bodies before handing the payload back to
        // the caller so we never ship an 8KB blob per row in a table.
        const items = rows.map((r) => ({
          ...r,
          responseBody: truncateResponseBody(r.responseBody),
        }));
        return { items, nextCursor };
      }),

    /**
     * Reset a dead-letter (or otherwise stuck) delivery back onto the
     * queue so the BullMQ worker will pick it up again. Resets
     * `attempt` to 0, `status` to PENDING, and `scheduledAt` to now, and
     * writes an audit entry so the retry is traceable.
     */
    retry: adminProcedure
      .input(z.object({ id: z.string().cuid() }))
      .mutation(async ({ ctx, input }) => {
        const existing = await ctx.db.webhookDelivery.findFirst({
          where: {
            id: input.id,
            webhook: { workspaceId: ctx.workspaceId },
          },
          select: {
            id: true,
            status: true,
            attempt: true,
            scheduledAt: true,
            webhookId: true,
            eventId: true,
          },
        });
        if (!existing) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Webhook delivery not found.",
          });
        }

        const now = new Date();
        const updated = await ctx.db.$transaction(async (tx) => {
          const row = await tx.webhookDelivery.update({
            where: { id: input.id },
            data: {
              status: "PENDING",
              attempt: 0,
              scheduledAt: now,
              responseStatus: null,
              responseBody: null,
              deliveredAt: null,
            },
          });
          // Direct AuditLog write — no matching EventKind for admin
          // retry actions, and we don't want to pollute the activity
          // feed / fan out more webhook deliveries for this.
          await tx.auditLog.create({
            data: {
              workspaceId: ctx.workspaceId,
              actorId: ctx.session.user.id,
              entity: "WebhookDelivery",
              entityId: row.id,
              action: "retry",
              before: {
                status: existing.status,
                attempt: existing.attempt,
                scheduledAt: existing.scheduledAt.toISOString(),
              },
              after: {
                status: row.status,
                attempt: row.attempt,
                scheduledAt: row.scheduledAt.toISOString(),
              },
              ip: ctx.ip ?? undefined,
              userAgent: ctx.userAgent ?? undefined,
            },
          });
          return row;
        });

        // Best-effort enqueue — if Redis is unavailable the row is
        // already PENDING, so a worker sweep or the next BullMQ
        // connection will pick it up. We don't want admin retry to
        // fail just because the queue connection is flaky.
        try {
          await webhookQueue.add(
            "deliver",
            { deliveryId: updated.id },
            { attempts: 6, backoff: { type: "exponential", delay: 5_000 } },
          );
        } catch {
          // swallow — row state is the source of truth
        }

        return updated;
      }),
  }),
});
