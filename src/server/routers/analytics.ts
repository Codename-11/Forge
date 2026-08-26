import { z } from "zod";
import { router, workspaceProcedure } from "@/server/trpc";
import {
  buildIssueAccessWhere,
  buildProjectAccessWhere,
} from "@/server/services/authorization";

/**
 * Analytics endpoints return precomputed rollups from MetricAggregate, with
 * a fallback to live SQL aggregation for metrics not yet warmed. Scheduled
 * jobs (BullMQ) keep the table fresh — see src/server/worker.ts.
 *
 * The `dispatch` sub-router reads raw ActivityEvent rows (kind =
 * AGENT_ASSIGNED / ISSUE_STATUS_CHANGED / COMMENT_CREATED / ISSUE_UPDATED)
 * and joins them windowed per-assignment. The auto-dispatcher writes a
 * rich provenance payload on AGENT_ASSIGNED (see dispatcher.ts) that we
 * consume here for mode distribution; manual assignments omit `mode` and
 * bucket under MANUAL_ONLY.
 */

/** Default window for dispatch analytics. */
const DEFAULT_DISPATCH_WINDOW_DAYS = 30;

/**
 * Row shape returned by the TTFA aggregation CTE. One row per
 * AGENT_ASSIGNED event; `firstActionMs` is null when the assignment
 * window never saw a follow-up action (excluded from the mean on the
 * caller side).
 */
interface TtfaRow {
  agentId: string;
  firstActionMs: number | null;
}

/**
 * Sub-router for dispatch observability. Reads from ActivityEvent + Issue;
 * no new tables. All SQL is workspace-scoped via bind parameters to keep
 * the plans simple under Postgres' planner.
 */
const dispatchRouter = router({
  /**
   * Per-agent rollup within the window. `since` defaults to now-30d. When
   * `agentId` is supplied, the response is filtered to that single agent.
   */
  summary: workspaceProcedure
    .input(
      z
        .object({
          since: z.date().optional(),
          agentId: z
            .string()
            .min(1)
            .max(40)
            .regex(/^[a-zA-Z0-9_-]+$/)
            .optional(),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const since =
        input.since ??
        new Date(Date.now() - DEFAULT_DISPATCH_WINDOW_DAYS * 86_400_000);

      // Pull agents up front so a silent agent (zero assignments in the
      // window) still shows up in the table. When the caller narrows by
      // agentId we respect that — otherwise all non-archived agents in
      // the workspace are candidates.
      const agents = await ctx.db.agent.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: null,
          ...(input.agentId ? { id: input.agentId } : {}),
        },
        select: {
          id: true,
          name: true,
          profileKey: true,
          avatar: true,
          status: true,
        },
      });
      // --------- Assignment counts (per agent, within window) ------------
      // Read AGENT_ASSIGNED events and extract `agentId` from payload. We
      // filter in SQL rather than Prisma groupBy so the payload JSON path
      // stays server-side (Prisma's groupBy can't index by payload keys).
      // When the caller narrows by agentId we filter in TS — the agent
      // population is tiny (O(10s)) so there's no planner benefit to
      // injecting another WHERE clause into the raw query.
      const assignmentRowsRaw = await ctx.db.$queryRaw<
        { agentId: string; count: bigint }[]
      >`
        SELECT payload->>'agentId' AS "agentId",
               COUNT(*)::bigint    AS "count"
        FROM "ActivityEvent"
        WHERE "workspaceId" = ${ctx.workspaceId}
          AND kind = 'AGENT_ASSIGNED'
          AND "createdAt" >= ${since}
          AND payload->>'agentId' IS NOT NULL
        GROUP BY 1
      `;
      const assignmentRows = input.agentId
        ? assignmentRowsRaw.filter((r) => r.agentId === input.agentId)
        : assignmentRowsRaw;

      // --------- Mode distribution (global over the window) --------------
      // `payload->>'mode'` is populated by the auto-dispatcher;
      // manual-assignment events leave it null — we bucket those under
      // MANUAL_ONLY so the distribution adds up to total assignments.
      const modeRows = await ctx.db.$queryRaw<
        { mode: string | null; count: bigint }[]
      >`
        SELECT payload->>'mode' AS mode,
               COUNT(*)::bigint AS "count"
        FROM "ActivityEvent"
        WHERE "workspaceId" = ${ctx.workspaceId}
          AND kind = 'AGENT_ASSIGNED'
          AND "createdAt" >= ${since}
        GROUP BY 1
      `;
      const modeDistribution: Record<string, number> = {
        ROUND_ROBIN: 0,
        PRIORITY_MATCH: 0,
        CAPABILITY_MATCH: 0,
        MANUAL_ONLY: 0,
      };
      for (const r of modeRows) {
        const key = r.mode ?? "MANUAL_ONLY";
        modeDistribution[key] = (modeDistribution[key] ?? 0) + Number(r.count);
      }

      // --------- Time-to-first-action (TTFA) ----------------------------
      // For every AGENT_ASSIGNED event within the window we look ahead on
      // the same issue for the next AGENT_ASSIGNED (window end) and for
      // the first follow-up event of interest (STATUS_CHANGED /
      // COMMENT_CREATED / TIME_STARTED). We use a LATERAL subquery so
      // the planner can stream per-assign without materialising the whole
      // event table per window. Returning rows with NULL ms preserves
      // the "never acted" case so the caller can exclude them from the
      // mean explicitly.
      //
      // Gotcha: an unassign/re-assign produces two AGENT_ASSIGNED rows on
      // the same issue; the inner `MIN("createdAt") < nextAssign.createdAt`
      // bound makes sure a later agent's action isn't attributed to an
      // earlier agent. When there is no next assignment, the bound falls
      // back to "infinity" so the window stays open.
      const ttfaRowsRaw = await ctx.db.$queryRaw<TtfaRow[]>`
        WITH assigns AS (
          SELECT id,
                 "subjectId"                     AS issue_id,
                 payload->>'agentId'             AS agent_id,
                 "createdAt"                     AS assigned_at
          FROM "ActivityEvent"
          WHERE "workspaceId" = ${ctx.workspaceId}
            AND kind = 'AGENT_ASSIGNED'
            AND "subjectType" = 'issue'
            AND "createdAt" >= ${since}
            AND payload->>'agentId' IS NOT NULL
        )
        SELECT a.agent_id AS "agentId",
               EXTRACT(
                 EPOCH FROM (first_action.first_at - a.assigned_at)
               ) * 1000 AS "firstActionMs"
        FROM assigns a
        LEFT JOIN LATERAL (
          SELECT "createdAt" AS next_at
          FROM "ActivityEvent" nx
          WHERE nx."workspaceId" = ${ctx.workspaceId}
            AND nx.kind = 'AGENT_ASSIGNED'
            AND nx."subjectType" = 'issue'
            AND nx."subjectId" = a.issue_id
            AND nx."createdAt" > a.assigned_at
          ORDER BY nx."createdAt" ASC
          LIMIT 1
        ) next_assign ON TRUE
        LEFT JOIN LATERAL (
          SELECT MIN(ae."createdAt") AS first_at
          FROM "ActivityEvent" ae
          WHERE ae."workspaceId" = ${ctx.workspaceId}
            AND ae."subjectType" = 'issue'
            AND ae."subjectId" = a.issue_id
            AND ae."createdAt" > a.assigned_at
            AND ae."createdAt" < COALESCE(next_assign.next_at, 'infinity'::timestamp)
            AND (
              ae.kind = 'ISSUE_STATUS_CHANGED'
              OR ae.kind = 'COMMENT_CREATED'
              OR (ae.kind = 'ISSUE_UPDATED' AND ae.payload->>'event' = 'time.start')
            )
        ) first_action ON TRUE
      `;
      const ttfaRows = input.agentId
        ? ttfaRowsRaw.filter((r) => r.agentId === input.agentId)
        : ttfaRowsRaw;

      // --------- Time-to-completion (TTC) --------------------------------
      // Each assignment's "completion" is the issue's completedAt, but
      // only if that completion happened strictly between the assignment
      // and the next assignment on the same issue (so re-assigned-then-
      // completed doesn't double-count). When the issue is still open
      // we leave it out of the mean — surfaced as `openAssignments` in
      // the per-agent rollup so the UI can flag them.
      const ttcRowsRaw = await ctx.db.$queryRaw<
        { agentId: string; completionMs: number | null }[]
      >`
        WITH assigns AS (
          SELECT id,
                 "subjectId"                     AS issue_id,
                 payload->>'agentId'             AS agent_id,
                 "createdAt"                     AS assigned_at
          FROM "ActivityEvent"
          WHERE "workspaceId" = ${ctx.workspaceId}
            AND kind = 'AGENT_ASSIGNED'
            AND "subjectType" = 'issue'
            AND "createdAt" >= ${since}
            AND payload->>'agentId' IS NOT NULL
        )
        SELECT a.agent_id AS "agentId",
               CASE
                 WHEN i."completedAt" IS NULL THEN NULL
                 WHEN i."completedAt" <= a.assigned_at THEN NULL
                 WHEN next_assign.next_at IS NOT NULL
                   AND i."completedAt" >= next_assign.next_at THEN NULL
                 ELSE EXTRACT(EPOCH FROM (i."completedAt" - a.assigned_at)) * 1000
               END AS "completionMs"
        FROM assigns a
        JOIN "Issue" i ON i.id = a.issue_id
        LEFT JOIN LATERAL (
          SELECT "createdAt" AS next_at
          FROM "ActivityEvent" nx
          WHERE nx."workspaceId" = ${ctx.workspaceId}
            AND nx.kind = 'AGENT_ASSIGNED'
            AND nx."subjectType" = 'issue'
            AND nx."subjectId" = a.issue_id
            AND nx."createdAt" > a.assigned_at
          ORDER BY nx."createdAt" ASC
          LIMIT 1
        ) next_assign ON TRUE
      `;
      const ttcRows = input.agentId
        ? ttcRowsRaw.filter((r) => r.agentId === input.agentId)
        : ttcRowsRaw;

      // --------- Throughput (7d) -----------------------------------------
      // "Most-recent assignee" is whatever the dispatcher/issue router
      // last set — we trust Issue.assignedAgentId at read time since
      // completion already implies the agent stayed assigned through
      // the Done transition (or was re-assigned away first, in which
      // case the current assignedAgentId wins by design).
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      const throughputRows = await ctx.db.issue.groupBy({
        by: ["assignedAgentId"],
        where: {
          workspaceId: ctx.workspaceId,
          completedAt: { gte: sevenDaysAgo, not: null },
          assignedAgentId: { not: null },
          ...(input.agentId ? { assignedAgentId: input.agentId } : {}),
        },
        _count: { _all: true },
      });

      // --------- Stitch per-agent rollups --------------------------------
      const assignedCount = new Map<string, number>();
      for (const r of assignmentRows)
        assignedCount.set(r.agentId, Number(r.count));

      const ttfaByAgent = new Map<string, number[]>();
      const ttfaNullByAgent = new Map<string, number>();
      for (const r of ttfaRows) {
        if (!r.firstActionMs) {
          ttfaNullByAgent.set(
            r.agentId,
            (ttfaNullByAgent.get(r.agentId) ?? 0) + 1,
          );
          continue;
        }
        const arr = ttfaByAgent.get(r.agentId) ?? [];
        arr.push(Number(r.firstActionMs));
        ttfaByAgent.set(r.agentId, arr);
      }

      const ttcByAgent = new Map<string, number[]>();
      const ttcOpenByAgent = new Map<string, number>();
      for (const r of ttcRows) {
        if (r.completionMs === null) {
          ttcOpenByAgent.set(
            r.agentId,
            (ttcOpenByAgent.get(r.agentId) ?? 0) + 1,
          );
          continue;
        }
        const arr = ttcByAgent.get(r.agentId) ?? [];
        arr.push(Number(r.completionMs));
        ttcByAgent.set(r.agentId, arr);
      }

      const throughputByAgent = new Map<string, number>();
      for (const r of throughputRows) {
        if (r.assignedAgentId)
          throughputByAgent.set(r.assignedAgentId, r._count._all);
      }

      const perAgent = agents
        .map((a) => ({
          agentId: a.id,
          name: a.name,
          profileKey: a.profileKey,
          avatar: a.avatar,
          status: a.status,
          assignments: assignedCount.get(a.id) ?? 0,
          meanTimeToFirstAction: mean(ttfaByAgent.get(a.id) ?? []),
          /** Number of assignments with no follow-up event in-window. */
          assignmentsWithoutAction: ttfaNullByAgent.get(a.id) ?? 0,
          meanTimeToCompletion: mean(ttcByAgent.get(a.id) ?? []),
          /** Assignments still open (excluded from TTC mean). */
          openAssignments: ttcOpenByAgent.get(a.id) ?? 0,
          throughputLast7d: throughputByAgent.get(a.id) ?? 0,
        }))
        // Drop silent agents when there's some activity to show. If no
        // agent saw activity in the window (fresh workspace / quiet
        // period) we keep everyone so the table isn't empty.
        .filter((row) => {
          if (input.agentId) return row.agentId === input.agentId;
          if (assignmentRows.length === 0) return true;
          return row.assignments > 0 || row.throughputLast7d > 0;
        });

      // Totals across the window (cards at the top of the UI).
      const totalAssignments = assignmentRows.reduce(
        (acc, r) => acc + Number(r.count),
        0,
      );
      const allTtfa: number[] = [];
      for (const arr of ttfaByAgent.values()) allTtfa.push(...arr);
      const allTtc: number[] = [];
      for (const arr of ttcByAgent.values()) allTtc.push(...arr);
      const totalThroughput = Array.from(throughputByAgent.values()).reduce(
        (a, b) => a + b,
        0,
      );

      return {
        since: since.toISOString(),
        totals: {
          assignments: totalAssignments,
          meanTimeToFirstAction: mean(allTtfa),
          meanTimeToCompletion: mean(allTtc),
          throughputLast7d: totalThroughput,
        },
        modeDistribution: modeDistribution as Record<
          "ROUND_ROBIN" | "PRIORITY_MATCH" | "CAPABILITY_MATCH" | "MANUAL_ONLY",
          number
        >,
        perAgent,
      };
    }),

  /**
   * Time-bucketed assignments + completions. `bucket` selects the
   * date_trunc granularity. Zero-buckets are included (assignments or
   * completions = 0) so the chart gets a continuous x-axis when there
   * are lulls in activity. `since` defaults to now-30d.
   */
  timeseries: workspaceProcedure
    .input(
      z
        .object({
          since: z.date().optional(),
          bucket: z.enum(["day", "hour"]).default("day"),
        })
        .default({ bucket: "day" }),
    )
    .query(async ({ ctx, input }) => {
      const since =
        input.since ??
        new Date(Date.now() - DEFAULT_DISPATCH_WINDOW_DAYS * 86_400_000);

      // Assignments per bucket.
      const assignRows = await ctx.db.$queryRawUnsafe<
        { bucket: Date; count: bigint }[]
      >(
        `
        SELECT date_trunc($1, "createdAt") AS bucket,
               COUNT(*)::bigint            AS count
        FROM "ActivityEvent"
        WHERE "workspaceId" = $2
          AND kind = 'AGENT_ASSIGNED'
          AND "createdAt" >= $3
        GROUP BY 1
        ORDER BY 1 ASC
        `,
        input.bucket,
        ctx.workspaceId,
        since,
      );

      // Completions per bucket: use Issue.completedAt so we count a
      // completion even when the ISSUE_STATUS_CHANGED event predates
      // the window (rare but possible when the dispatcher back-fills).
      const doneRows = await ctx.db.$queryRawUnsafe<
        { bucket: Date; count: bigint }[]
      >(
        `
        SELECT date_trunc($1, "completedAt") AS bucket,
               COUNT(*)::bigint              AS count
        FROM "Issue"
        WHERE "workspaceId" = $2
          AND "completedAt" IS NOT NULL
          AND "completedAt" >= $3
          AND "assignedAgentId" IS NOT NULL
        GROUP BY 1
        ORDER BY 1 ASC
        `,
        input.bucket,
        ctx.workspaceId,
        since,
      );

      const map = new Map<
        string,
        { bucket: string; assignments: number; completions: number }
      >();
      for (const r of assignRows) {
        const k = r.bucket.toISOString();
        map.set(k, {
          bucket: k,
          assignments: Number(r.count),
          completions: 0,
        });
      }
      for (const r of doneRows) {
        const k = r.bucket.toISOString();
        const existing = map.get(k);
        if (existing) existing.completions = Number(r.count);
        else
          map.set(k, { bucket: k, assignments: 0, completions: Number(r.count) });
      }
      return Array.from(map.values()).sort((a, b) =>
        a.bucket < b.bucket ? -1 : 1,
      );
    }),
});

export const analyticsRouter = router({
  summary: workspaceProcedure.query(async ({ ctx }) => {
    const issueAccess = buildIssueAccessWhere({
      workspaceId: ctx.workspaceId,
      membershipId: ctx.membership.id,
      membershipRole: ctx.membership.role,
      action: "READ",
    });
    const [openIssues, doneIssues, overdue, totalProjects] = await Promise.all([
      ctx.db.issue.count({
        where: {
          ...issueAccess,
          status: { category: { notIn: ["DONE", "CANCELED"] } },
        },
      }),
      ctx.db.issue.count({
        where: {
          ...issueAccess,
          status: { category: "DONE" },
        },
      }),
      ctx.db.issue.count({
        where: {
          ...issueAccess,
          dueDate: { lt: new Date() },
          status: { category: { notIn: ["DONE", "CANCELED"] } },
        },
      }),
      ctx.db.project.count({
        where: {
          ...buildProjectAccessWhere({
            workspaceId: ctx.workspaceId,
            membershipId: ctx.membership.id,
            membershipRole: ctx.membership.role,
            action: "READ",
          }),
          archived: false,
          deletedAt: null,
        },
      }),
    ]);
    return { openIssues, doneIssues, overdue, totalProjects };
  }),

  statusDistribution: workspaceProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.issue.groupBy({
      by: ["statusId"],
      where: buildIssueAccessWhere({
        workspaceId: ctx.workspaceId,
        membershipId: ctx.membership.id,
        membershipRole: ctx.membership.role,
        action: "READ",
      }),
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
      const since = new Date(Date.now() - input.lookbackDays * 86_400_000);
      const rows = await ctx.db.issue.findMany({
        where: {
          ...buildIssueAccessWhere({
            workspaceId: ctx.workspaceId,
            membershipId: ctx.membership.id,
            membershipRole: ctx.membership.role,
            action: "READ",
          }),
          completedAt: { not: null, gte: since },
        },
        select: { completedAt: true },
      });
      const buckets = new Map<string, number>();
      for (const row of rows) {
        if (!row.completedAt) continue;
        const date = new Date(row.completedAt);
        date.setUTCHours(0, 0, 0, 0);
        if (input.granularity === "week") {
          const weekday = date.getUTCDay();
          date.setUTCDate(date.getUTCDate() - ((weekday + 6) % 7));
        }
        const key = date.toISOString();
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
      return [...buckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([bucket, completed]) => ({ bucket, completed }));
    }),

  cycleTime: workspaceProcedure
    .input(z.object({ lookbackDays: z.number().min(7).max(365).default(90) }).default({ lookbackDays: 90 }))
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - input.lookbackDays * 86_400_000);
      const rows = await ctx.db.issue.findMany({
        where: {
          ...buildIssueAccessWhere({
            workspaceId: ctx.workspaceId,
            membershipId: ctx.membership.id,
            membershipRole: ctx.membership.role,
            action: "READ",
          }),
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
        ...buildIssueAccessWhere({
          workspaceId: ctx.workspaceId,
          membershipId: ctx.membership.id,
          membershipRole: ctx.membership.role,
          action: "READ",
        }),
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

  dispatch: dispatchRouter,
});

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return Math.round(sorted[i] * 100) / 100;
}

/** Arithmetic mean; returns null on empty input so the UI can render "—". */
function mean(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}
