import { z } from "zod";
import { AgentRunStatus, type Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { STALE_RUN_MS } from "@/server/services/agent-presence";
import { presenceAvailability } from "@/lib/transport-display";

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

/**
 * Rich-card field set for the "You" zone (Focus + Pick-up). Extends
 * SUGGESTION_FIELDS with the four signals the dashboard card surfaces —
 * people (assignees + assigned agent), context (labels / due / SLA /
 * description snippet), progress (sub-issue rollup), and activity (latest
 * run). Bounded to ~6 rows per slice, so the two extra relation pulls
 * (children + latest run) stay cheap. The shared `issue.list` is left
 * lean on purpose — this enrichment lives only where the cards render.
 */
const CARD_FIELDS = {
  ...SUGGESTION_FIELDS,
  description: true,
  dueDate: true,
  slaMinutes: true,
  kind: true,
  parentId: true,
  labels: {
    select: { label: { select: { id: true, name: true, color: true } } },
  },
  assignees: {
    select: { user: { select: { id: true, name: true, image: true } } },
  },
  assignedAgent: {
    select: {
      id: true,
      name: true,
      profileKey: true,
      avatar: true,
      status: true,
      provider: true,
      runtimeMode: true,
      lastHeartbeatAt: true,
      webhookUrl: true,
      runtimeId: true,
    },
  },
  // Sub-issue rows (status category only) — rolled up to done/total in JS.
  // Cheap because the parent slice is capped at ~6.
  children: {
    where: { deletedAt: null },
    select: { status: { select: { category: true } } },
  },
  // Newest run, terminal or not — drives the activity chip (running /
  // waiting / stalled / blocked). Mirrors the issue-detail `byId` shape.
  agentRuns: {
    orderBy: [{ lastEventAt: "desc" }, { startedAt: "desc" }],
    take: 1,
    select: {
      id: true,
      status: true,
      currentStep: true,
      lastEventAt: true,
      startedAt: true,
      agent: { select: { name: true, profileKey: true, avatar: true } },
    },
  },
} satisfies Prisma.IssueSelect;

/**
 * Roll a card row's children + latest run into the compact shape the
 * client card consumes. `childTotal` excludes canceled sub-issues;
 * `childDone` counts DONE. `latestRun` is null when the issue has never
 * had a run.
 */
function shapeCard<
  T extends {
    children: Array<{ status: { category: string } }>;
    agentRuns: Array<{
      id: string;
      status: AgentRunStatus;
      currentStep: string | null;
      lastEventAt: Date | null;
      startedAt: Date;
      agent: { name: string | null; profileKey: string | null; avatar: string | null } | null;
    }>;
  },
>(row: T) {
  const { children, agentRuns, ...rest } = row;
  const childTotal = children.filter((c) => c.status.category !== "CANCELED").length;
  const childDone = children.filter((c) => c.status.category === "DONE").length;
  const latestRun = agentRuns[0] ?? null;
  return { ...rest, childDone, childTotal, latestRun };
}

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
   * "Today widget" — the focused this-week tile that sits above
   * Quick Notes on the dashboard. Three regions:
   *
   *   1. Active sprint countdown (id + name + endsAt). Re-uses
   *      `cycle.current` semantics inline so the dashboard makes a
   *      single round-trip.
   *   2. Due-soon issues (next 7 days, not in DONE/CANCELED), capped
   *      at 5 and ordered by dueDate ascending. Includes overdue
   *      rows that aren't yet closed (so a missed deadline still
   *      surfaces).
   *   3. Week peek — Mon–Sun of the *current ISO week* with
   *      per-day counts of issues whose dueDate falls on that day.
   *      Uses UTC date keys (`YYYY-MM-DD`) so the client can match
   *      day cells without timezone math; the user's timezone
   *      shifts what "today" means visually but the backing data
   *      is workspace-wide so it's fine to anchor on UTC.
   *
   * Tile renders empty-states inline; the proc never returns null.
   */
  today: workspaceProcedure.query(async ({ ctx }) => {
    const now = new Date();

    // 1. Active sprint countdown.
    const activeCycle = await ctx.db.cycle.findFirst({
      where: { workspaceId: ctx.workspaceId, status: "ACTIVE" },
      orderBy: { startsAt: "desc" },
      select: { id: true, name: true, endsAt: true },
    });

    // 2 + 3 share the date math. Anchor "this week" to UTC Monday →
    // Sunday so the strip always shows seven contiguous days.
    const todayUtcMidnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    // getUTCDay: 0=Sun, 1=Mon, ..., 6=Sat. Convert to 0=Mon..6=Sun.
    const isoDow = (todayUtcMidnight.getUTCDay() + 6) % 7;
    const weekStart = new Date(todayUtcMidnight);
    weekStart.setUTCDate(weekStart.getUTCDate() - isoDow);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

    // Due soon — next 7 days from now (NOT week-aligned). Includes
    // already-overdue rows so the operator sees them too. Cap 5.
    const dueSoonCutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const dueSoonRows = await ctx.db.issue.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        dueDate: { not: null, lte: dueSoonCutoff },
        status: { category: { notIn: ["DONE", "CANCELED"] } },
      },
      orderBy: [{ dueDate: "asc" }, { priority: "desc" }],
      take: 5,
      select: {
        id: true,
        number: true,
        title: true,
        priority: true,
        dueDate: true,
        status: { select: { id: true, name: true, category: true, color: true } },
        project: { select: { id: true, key: true, name: true, color: true, icon: true } },
      },
    });
    // Build the issue-key string client-side; we already have number.
    // (Workspace.key is workspace-static and the client knows it from
    // useWorkspace.)
    const dueSoon = dueSoonRows.map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      priority: r.priority,
      dueDate: r.dueDate,
      status: r.status,
      project: r.project,
    }));

    // 3. Week peek — count of issues whose dueDate falls inside the
    // [weekStart, weekEnd) range, grouped by UTC date.
    const weekIssues = await ctx.db.issue.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        dueDate: { gte: weekStart, lt: weekEnd },
        status: { category: { notIn: ["DONE", "CANCELED"] } },
      },
      select: { dueDate: true },
    });
    const counts = new Map<string, number>();
    for (const r of weekIssues) {
      if (!r.dueDate) continue;
      const d = new Date(r.dueDate);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const weekPeek: { date: string; count: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setUTCDate(d.getUTCDate() + i);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      weekPeek.push({ date: key, count: counts.get(key) ?? 0 });
    }

    return { activeCycle, dueSoon, weekPeek };
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

  /**
   * "You" zone — the two personal work slices the redesigned dashboard
   * leads with, enriched into rich-card rows server-side so the page
   * doesn't filter a 100-issue `issue.list` client-side:
   *
   *   - focus  — my non-done assigned issues, priority-desc then due-asc.
   *              "What's important for me right now."
   *   - resume — my non-done issues (assigned OR authored) by recency.
   *              "Pick up where you left off." De-duped against focus so
   *              the same card never appears in both rows.
   *
   * Each row carries people / context / progress / activity (see
   * CARD_FIELDS). Capped small so the child + run pulls stay cheap.
   */
  myWork: workspaceProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(12).default(6) })
        .default({ limit: 6 }),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const limit = input.limit;

      const [focusRows, resumeRows] = await Promise.all([
        ctx.db.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            deletedAt: null,
            assignees: { some: { userId } },
            status: { category: { notIn: ["DONE", "CANCELED"] } },
          },
          orderBy: [
            { priority: "desc" },
            { dueDate: "asc" },
            { updatedAt: "desc" },
          ],
          take: limit,
          select: CARD_FIELDS,
        }),
        // Pull extra so the focus de-dup still leaves a full row.
        ctx.db.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            deletedAt: null,
            status: { category: { notIn: ["DONE", "CANCELED"] } },
            OR: [{ assignees: { some: { userId } } }, { authorId: userId }],
          },
          orderBy: [{ updatedAt: "desc" }],
          take: limit * 2,
          select: CARD_FIELDS,
        }),
      ]);

      const focus = focusRows.map(shapeCard);
      const focusIds = new Set(focus.map((f) => f.id));
      const resume = resumeRows
        .filter((r) => !focusIds.has(r.id))
        .slice(0, limit)
        .map(shapeCard);

      return { focus, resume };
    }),

  /**
   * Agent Activity tile — per-agent at-a-glance health for the
   * dashboard. Composed server-side so the client doesn't have to
   * juggle three tRPC queries and join them itself.
   *
   * Per agent (non-archived):
   *   - identity (id, profileKey, name, avatar, status)
   *   - lastHeartbeatAt
   *   - load = currently-active runs for this agent
   *   - maxConcurrent (0 = ∞)
   *   - stalledRuns = active runs older than `STALE_RUN_MS`
   *   - stalledIssues = issues assigned to this agent past
   *     `Workspace.stalledThresholdDays` (0 disables the count, returns 0)
   *
   * Sort: stalledRuns desc → stalledIssues desc → load desc → name asc.
   * Empty array when no agents exist (the client hides the tile).
   */
  agentActivity: workspaceProcedure.query(async ({ ctx }) => {
    const agents = await ctx.db.agent.findMany({
      where: { workspaceId: ctx.workspaceId, archivedAt: null },
      orderBy: { name: "asc" },
      select: {
        id: true,
        profileKey: true,
        name: true,
        avatar: true,
        status: true,
        lastHeartbeatAt: true,
        maxConcurrent: true,
        // Presence inputs so the tile can read on-demand agents correctly.
        provider: true,
        runtimeMode: true,
        runtimeId: true,
        webhookUrl: true,
      },
    });

    if (agents.length === 0) {
      return { agents: [], stalledThresholdDays: 0 };
    }

    const ws = await ctx.db.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: { stalledThresholdDays: true },
    });

    const agentIds = agents.map((a) => a.id);
    const now = Date.now();
    const runCutoff = new Date(now - STALE_RUN_MS);

    // Active-run load + stalled-run count, both grouped by agent in
    // a single sweep over the active rows. Bounded by the workspace's
    // active-run cardinality (typically <100; if it ever blows up we
    // can switch to GROUP BY).
    const activeRuns = await ctx.db.agentRun.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        agentId: { in: agentIds },
        status: AgentRunStatus.ACTIVE,
      },
      select: { agentId: true, lastEventAt: true },
    });
    const loadByAgent = new Map<string, number>();
    const stalledRunsByAgent = new Map<string, number>();
    for (const r of activeRuns) {
      loadByAgent.set(r.agentId, (loadByAgent.get(r.agentId) ?? 0) + 1);
      if (r.lastEventAt < runCutoff) {
        stalledRunsByAgent.set(
          r.agentId,
          (stalledRunsByAgent.get(r.agentId) ?? 0) + 1,
        );
      }
    }

    // Stalled-issue count per agent — single grouped query when the
    // workspace setting is enabled.
    const stalledIssuesByAgent = new Map<string, number>();
    if (ws.stalledThresholdDays > 0) {
      const issueCutoff = new Date(
        now - ws.stalledThresholdDays * 24 * 60 * 60 * 1000,
      );
      const snoozeNow = new Date();
      const stalledIssues = await ctx.db.issue.groupBy({
        by: ["assignedAgentId"],
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          assignedAgentId: { in: agentIds },
          updatedAt: { lt: issueCutoff },
          status: { category: { in: ["IN_PROGRESS", "IN_REVIEW"] } },
          OR: [
            { snoozedUntil: null },
            { snoozedUntil: { lte: snoozeNow } },
          ],
        },
        _count: { _all: true },
      });
      for (const r of stalledIssues) {
        if (r.assignedAgentId) {
          stalledIssuesByAgent.set(r.assignedAgentId, r._count._all);
        }
      }
    }

    const rows = agents.map((a) => ({
      id: a.id,
      profileKey: a.profileKey,
      name: a.name,
      avatar: a.avatar,
      status: a.status,
      lastHeartbeatAt: a.lastHeartbeatAt,
      // On-demand agents (managed app server) read "on-demand", not "offline".
      availability: presenceAvailability(a),
      load: loadByAgent.get(a.id) ?? 0,
      maxConcurrent: a.maxConcurrent,
      stalledRuns: stalledRunsByAgent.get(a.id) ?? 0,
      stalledIssues: stalledIssuesByAgent.get(a.id) ?? 0,
    }));

    rows.sort((a, b) => {
      if (a.stalledRuns !== b.stalledRuns) return b.stalledRuns - a.stalledRuns;
      if (a.stalledIssues !== b.stalledIssues)
        return b.stalledIssues - a.stalledIssues;
      if (a.load !== b.load) return b.load - a.load;
      return a.name.localeCompare(b.name);
    });

    return {
      agents: rows,
      stalledThresholdDays: ws.stalledThresholdDays,
    };
  }),
});

// -- helpers ----------------------------------------------------------------

type DB = PrismaClient;

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
