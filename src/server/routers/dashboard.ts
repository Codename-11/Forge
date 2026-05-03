import { z } from "zod";
import { router, workspaceProcedure } from "@/server/trpc";

/**
 * Dashboard zero-state suggestions. Three buckets — current sprint,
 * unassigned-in-my-projects, and stalled — each capped at `limit` so the
 * dashboard can render a "what should I do next" panel without a wall of
 * text. Phase 1 will mount this on `/w/[slug]/dashboard`.
 *
 * Buckets are independent queries (no shared filter) so callers can
 * cheaply skip any bucket by ignoring its array. Order within each
 * bucket is best-effort: priority desc then createdAt desc.
 */

const SUGGESTION_FIELDS = {
  id: true,
  number: true,
  title: true,
  priority: true,
  statusId: true,
  projectId: true,
  cycleId: true,
  updatedAt: true,
  createdAt: true,
  status: { select: { id: true, name: true, category: true, color: true } },
  project: { select: { id: true, key: true, name: true, color: true, icon: true } },
} as const;

export const dashboardRouter = router({
  suggestions: workspaceProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(20).default(6),
        })
        .default({ limit: 6 }),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const limit = input.limit;

      // 1. Current sprint slice — unassigned first (so the bucket reads as
      //    "next thing for the team"), then assigned. The active cycle is
      //    workspace-scoped; null = no active cycle right now.
      const activeCycle = await ctx.db.cycle.findFirst({
        where: { workspaceId: ctx.workspaceId, status: "ACTIVE" },
        orderBy: { startsAt: "desc" },
        select: { id: true, name: true },
      });

      let currentSprintSlice: Array<
        Awaited<ReturnType<typeof fetchSlice>>[number]
      > = [];
      if (activeCycle) {
        currentSprintSlice = await fetchSlice(ctx.db, {
          workspaceId: ctx.workspaceId,
          where: {
            cycleId: activeCycle.id,
            status: { category: { notIn: ["DONE", "CANCELED"] } },
          },
          orderBy: [
            // Unassigned first via a synthetic boolean order, then priority.
            // Prisma can't order by `assignees.none` directly, so we run two
            // queries and concat — keeps the SQL simple and the cap stable.
          ],
          take: 0,
        });

        const [unassignedSlice, assignedSlice] = await Promise.all([
          fetchSlice(ctx.db, {
            workspaceId: ctx.workspaceId,
            where: {
              cycleId: activeCycle.id,
              status: { category: { notIn: ["DONE", "CANCELED"] } },
              assignees: { none: {} },
              assignedAgentId: null,
            },
            orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
            take: limit,
          }),
          fetchSlice(ctx.db, {
            workspaceId: ctx.workspaceId,
            where: {
              cycleId: activeCycle.id,
              status: { category: { notIn: ["DONE", "CANCELED"] } },
              OR: [
                { assignees: { some: {} } },
                { assignedAgentId: { not: null } },
              ],
            },
            orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
            take: limit,
          }),
        ]);
        currentSprintSlice = [...unassignedSlice, ...assignedSlice].slice(0, limit);
      }

      // 2. Unassigned in my projects — projects where the current user has
      //    any assignment OR has authored an issue recently (recent
      //    activity heuristic stays cheap because it reuses authorId).
      const myProjectIds = await myProjectIdSet(ctx.db, {
        workspaceId: ctx.workspaceId,
        userId,
      });
      const unassignedInMyProjects = myProjectIds.size
        ? await fetchSlice(ctx.db, {
            workspaceId: ctx.workspaceId,
            where: {
              projectId: { in: Array.from(myProjectIds) },
              assignees: { none: {} },
              assignedAgentId: null,
              status: { category: { notIn: ["DONE", "CANCELED"] } },
            },
            orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
            take: limit,
          })
        : [];

      // 3. Stalled — issues whose `updatedAt` is older than the
      //    workspace's `stalledThresholdDays` and aren't terminal. The
      //    threshold is settings-driven (workspace column added in this
      //    migration); 0 disables the bucket.
      //
      //    Phase 0 split (2026-05-02): the previous query implicitly
      //    filtered by `assignees: { some: {} }` via fetchSlice's
      //    workspace scope. That's been dropped so unassigned work
      //    that's gone quiet also surfaces. We also expose an
      //    `agentStalled` slice — issues with `assignedAgentId` set
      //    where the agent has been silent past threshold — so the
      //    Phase 1 dashboard can render them as a distinct lane.
      //    Snoozed rows (snoozedUntil > now) are filtered from both
      //    slices.
      const ws = await ctx.db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { stalledThresholdDays: true },
      });
      let stalled: Array<Awaited<ReturnType<typeof fetchSlice>>[number]> = [];
      let agentStalled: Array<Awaited<ReturnType<typeof fetchSlice>>[number]> =
        [];
      if (ws.stalledThresholdDays > 0) {
        const cutoff = new Date(
          Date.now() - ws.stalledThresholdDays * 24 * 60 * 60 * 1000,
        );
        const now = new Date();
        const notSnoozed = {
          OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
        };
        stalled = await fetchSlice(ctx.db, {
          workspaceId: ctx.workspaceId,
          where: {
            updatedAt: { lt: cutoff },
            status: { category: { notIn: ["DONE", "CANCELED"] } },
            ...notSnoozed,
          },
          orderBy: [{ updatedAt: "asc" }],
          take: limit,
        });
        agentStalled = await fetchSlice(ctx.db, {
          workspaceId: ctx.workspaceId,
          where: {
            updatedAt: { lt: cutoff },
            assignedAgentId: { not: null },
            status: { category: { notIn: ["DONE", "CANCELED"] } },
            ...notSnoozed,
          },
          orderBy: [{ updatedAt: "asc" }],
          take: limit,
        });
      }

      return {
        currentSprintSlice,
        unassignedInMyProjects,
        stalled,
        agentStalled,
        activeCycle,
        stalledThresholdDays: ws.stalledThresholdDays,
      };
    }),

  /**
   * In-progress issues that are quiet past `stalledThresholdDays`. Lifted
   * out of `dashboard/page.tsx` (which previously hardcoded 3 days) so
   * the threshold is settings-driven and consumers can't double-filter.
   * Phase 1B: the dashboard "Stalled" column should consume this OR a
   * `dashboard.suggestions.stalled` bucket — pick whichever fits.
   *
   * Returns a flat list of issues (status category IN_PROGRESS only —
   * we want "started but quiet", not "untouched in backlog"), sorted
   * by `updatedAt` ascending. Snoozed rows are excluded.
   */
  stalledInProgress: workspaceProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(50).default(8),
        })
        .default({ limit: 8 }),
    )
    .query(async ({ ctx, input }) => {
      const ws = await ctx.db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { stalledThresholdDays: true },
      });
      if (ws.stalledThresholdDays <= 0) {
        return { items: [], stalledThresholdDays: 0 };
      }
      const cutoff = new Date(
        Date.now() - ws.stalledThresholdDays * 24 * 60 * 60 * 1000,
      );
      const now = new Date();
      const items = await fetchSlice(ctx.db, {
        workspaceId: ctx.workspaceId,
        where: {
          updatedAt: { lt: cutoff },
          status: { category: "IN_PROGRESS" },
          OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
        },
        orderBy: [{ updatedAt: "asc" }],
        take: input.limit,
      });
      return {
        items,
        stalledThresholdDays: ws.stalledThresholdDays,
      };
    }),
});

// -- helpers ----------------------------------------------------------------

type DB = typeof import("@/server/db").db;

async function fetchSlice(
  db: DB,
  args: {
    workspaceId: string;
    where: Record<string, unknown>;
    orderBy: Array<Record<string, "asc" | "desc">>;
    take: number;
  },
) {
  if (args.take === 0) return [];
  return db.issue.findMany({
    where: { workspaceId: args.workspaceId, deletedAt: null, ...args.where },
    orderBy: args.orderBy,
    take: args.take,
    select: SUGGESTION_FIELDS,
  });
}

/**
 * Resolve the project ids the current user has any "stake" in — either
 * an open assignment or authorship in the last 30 days. The 30-day
 * window keeps the heuristic fresh; tweaking it is cheap, but bake-in
 * here so the dashboard query stays a single round-trip.
 */
async function myProjectIdSet(
  db: DB,
  args: { workspaceId: string; userId: string },
): Promise<Set<string>> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [assigned, authored] = await Promise.all([
    db.issueAssignee.findMany({
      where: {
        userId: args.userId,
        issue: { workspaceId: args.workspaceId, deletedAt: null, projectId: { not: null } },
      },
      select: { issue: { select: { projectId: true } } },
    }),
    db.issue.findMany({
      where: {
        workspaceId: args.workspaceId,
        authorId: args.userId,
        createdAt: { gte: since },
        projectId: { not: null },
        deletedAt: null,
      },
      select: { projectId: true },
    }),
  ]);
  const ids = new Set<string>();
  for (const r of assigned) {
    if (r.issue?.projectId) ids.add(r.issue.projectId);
  }
  for (const r of authored) {
    if (r.projectId) ids.add(r.projectId);
  }
  return ids;
}
