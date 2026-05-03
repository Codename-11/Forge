import { z } from "zod";
import { PinTargetType } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { hydratePinTargets, type HydratedPin } from "./pin";

/**
 * Recent items — per-(user, workspace, target) LRU log driven by the
 * client `track` call on entity-detail mounts. Powers the command
 * palette empty-state and the optional recent-items rail.
 *
 * Storage is the `RecentItem` table (migration 0023). Each row holds
 * `visitedAt`; `track` upserts with the same composite-unique key the
 * Pin table uses, so a re-visit just bumps the timestamp without
 * spawning a duplicate row.
 *
 * Server-side debounce: if the row's existing `visitedAt` is within
 * the last 5 seconds, `track` is a no-op. Keeps fast nav (rapid
 * back/forward) from spamming writes while letting the typical
 * "open this thing" path always update.
 */

const TRACK_DEBOUNCE_SECONDS = 5;

export const recentItemRouter = router({
  /**
   * Ordered (most-recent first) list of recent items in this workspace,
   * hydrated with the same target cards `pin.listAll` returns. Dead
   * targets are dropped silently. Items shaped like Pin so consumers
   * can share rendering helpers (the type is widened to `HydratedPin`'s
   * structure with a synthesized `orderIndex` of 0 — the index isn't
   * meaningful for recents, ordering comes from `visitedAt`).
   */
  list: workspaceProcedure
    .input(
      z.object({
        limit: z.number().int().positive().max(50).default(12),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.recentItem.findMany({
        where: {
          userId: ctx.session.user.id,
          workspaceId: ctx.workspaceId,
        },
        orderBy: { visitedAt: "desc" },
        take: input.limit,
      });

      const targets = await hydratePinTargets(ctx.db, ctx.session.user.id, rows);
      return rows
        .map(
          (r): HydratedPin & { visitedAt: Date } => ({
            id: r.id,
            userId: r.userId,
            workspaceId: r.workspaceId,
            targetType: r.targetType,
            targetId: r.targetId,
            orderIndex: 0,
            createdAt: r.visitedAt,
            visitedAt: r.visitedAt,
            target: targets.get(`${r.targetType}:${r.targetId}`) ?? null,
          }),
        )
        .filter((r) => r.target !== null);
    }),

  /**
   * Upsert a recent-item row. Called from page/detail mounts to record
   * "the user just looked at this." Returns the new `trackedAt`
   * timestamp; when the existing row's visitedAt is newer than
   * `now - 5s` the call is a no-op and the existing timestamp is
   * returned.
   */
  track: workspaceProcedure
    .input(
      z.object({
        targetType: z.nativeEnum(PinTargetType),
        targetId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const existing = await ctx.db.recentItem.findUnique({
        where: {
          userId_workspaceId_targetType_targetId: {
            userId: ctx.session.user.id,
            workspaceId: ctx.workspaceId,
            targetType: input.targetType,
            targetId: input.targetId,
          },
        },
      });
      if (existing) {
        const ageMs = now.getTime() - existing.visitedAt.getTime();
        if (ageMs < TRACK_DEBOUNCE_SECONDS * 1000) {
          return { trackedAt: existing.visitedAt };
        }
        await ctx.db.recentItem.update({
          where: { id: existing.id },
          data: { visitedAt: now },
        });
        return { trackedAt: now };
      }
      // Race-tolerant upsert in case two parallel `track` calls hit
      // the unique constraint at the same time. Postgres will reject
      // the second insert, which we swallow as "already tracked."
      try {
        await ctx.db.recentItem.create({
          data: {
            userId: ctx.session.user.id,
            workspaceId: ctx.workspaceId,
            targetType: input.targetType,
            targetId: input.targetId,
            visitedAt: now,
          },
        });
      } catch {
        // Lost the create race — just bump the now-existing row.
        await ctx.db.recentItem.update({
          where: {
            userId_workspaceId_targetType_targetId: {
              userId: ctx.session.user.id,
              workspaceId: ctx.workspaceId,
              targetType: input.targetType,
              targetId: input.targetId,
            },
          },
          data: { visitedAt: now },
        });
      }
      return { trackedAt: now };
    }),
});
