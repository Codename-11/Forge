import { z } from "zod";
import { AgentRunStatus, EventKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { maybeAutoDispatch } from "@/server/services/dispatcher";

// Forge has mixed id formats across rows (some cuid v1, some hex). Use
// a loose validator instead of `.cuid()` so both shapes pass.
const idString = z.string().min(1).max(40);

/**
 * Read-only router for AgentRun monitoring. Live mutations land via the
 * MCP `comments.upsertStatus` path or implicit hooks in the dispatcher
 * + worker — there is no human "create a run" surface.
 */
export const agentRunRouter = router({
  /**
   * Latest ACTIVE run for an issue, with its rolling STATUS comment +
   * agent display info. Used by the live pulse strip on the issue page.
   * Returns null when no active run — the strip just doesn't render.
   *
   * If multiple runs are active for the same issue (e.g. two agents
   * both dispatched), we return the one whose `lastEventAt` is newest
   * so the strip surfaces the most-recently-active worker.
   */
  activeForIssue: workspaceProcedure
    .input(z.object({ issueId: idString }))
    .query(async ({ ctx, input }) => {
      const run = await ctx.db.agentRun.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          issueId: input.issueId,
          status: AgentRunStatus.ACTIVE,
        },
        orderBy: { lastEventAt: "desc" },
        include: {
          agent: {
            select: { id: true, name: true, profileKey: true, avatar: true, status: true },
          },
          statusComment: {
            select: { id: true, body: true, currentStep: true, updatedAt: true, revisions: true },
          },
        },
      });
      return run;
    }),

  /**
   * Recent timeline events for a run. Bounded — the live strip only
   * needs the latest few; a deeper history view can paginate later.
   */
  events: workspaceProcedure
    .input(
      z.object({
        runId: idString,
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Workspace scoping defensively — confirm the run belongs to the
      // calling tenant before returning its events.
      const run = await ctx.db.agentRun.findFirst({
        where: { id: input.runId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!run) return [];
      return ctx.db.agentRunEvent.findMany({
        where: { runId: input.runId },
        orderBy: { createdAt: "desc" },
        take: input.limit,
      });
    }),

  /**
   * All ACTIVE runs in the workspace, ordered by freshness (most recent
   * `lastEventAt` first). Powers the Live tab of Mission Control.
   * Bounded at 50 — past that, the panel scrolls.
   */
  activeAll: workspaceProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(50).default(20) })
        .default({ limit: 20 }),
    )
    .query(async ({ ctx, input }) => {
      return ctx.db.agentRun.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          status: AgentRunStatus.ACTIVE,
        },
        orderBy: { lastEventAt: "desc" },
        take: input.limit,
        include: {
          agent: {
            select: {
              id: true,
              name: true,
              profileKey: true,
              avatar: true,
              status: true,
            },
          },
          issue: {
            select: {
              id: true,
              number: true,
              title: true,
              status: { select: { id: true, name: true, category: true, color: true } },
              workspace: { select: { key: true, slug: true } },
            },
          },
          statusComment: {
            select: { id: true, body: true, currentStep: true, updatedAt: true },
          },
        },
      });
    }),

  /**
   * Recent terminal runs (COMPLETED / ABANDONED / STALLED) within a
   * sliding window. Drives the History tab — by default the last hour,
   * which keeps the panel responsive but still surfaces "Mizu finished
   * AXI-31 (12m ago)" style context.
   */
  recentTerminal: workspaceProcedure
    .input(
      z
        .object({
          windowMinutes: z.number().int().min(1).max(24 * 60).default(60),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .default({ windowMinutes: 60, limit: 30 }),
    )
    .query(async ({ ctx, input }) => {
      const cutoff = new Date(Date.now() - input.windowMinutes * 60_000);
      return ctx.db.agentRun.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          status: { not: AgentRunStatus.ACTIVE },
          finishedAt: { gte: cutoff },
        },
        orderBy: { finishedAt: "desc" },
        take: input.limit,
        include: {
          agent: {
            select: { id: true, name: true, profileKey: true, avatar: true },
          },
          issue: {
            select: {
              id: true,
              number: true,
              title: true,
              workspace: { select: { key: true, slug: true } },
            },
          },
        },
      });
    }),

  /**
   * Daily activity heatmap — count of `AgentRunEvent` rows per UTC day
   * over the past N days. Drives the GH-style heatmap in the History
   * tab. Computed in a single grouped query so it stays cheap even
   * with thousands of events.
   *
   * Days with zero events aren't included in the result; the renderer
   * fills them in client-side. Bounded at 365 days.
   */
  heatmap: workspaceProcedure
    .input(
      z
        .object({ days: z.number().int().min(7).max(365).default(90) })
        .default({ days: 90 }),
    )
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - input.days * 86_400_000);
      // Postgres `date_trunc('day', ...)` aggregates server-side.
      // Cast to ::date so the response is a clean ISO date string.
      const rows = await ctx.db.$queryRawUnsafe<
        Array<{ day: string; count: bigint }>
      >(
        `SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
                COUNT(*)::bigint AS count
           FROM "AgentRunEvent"
          WHERE "workspaceId" = $1
            AND "createdAt"   >= $2
       GROUP BY day
       ORDER BY day ASC`,
        ctx.workspaceId,
        since,
      );
      return rows.map((r) => ({ date: r.day, count: Number(r.count) }));
    }),

  /**
   * Events in a time range across the whole workspace, joined with
   * agent + issue summary. Drives the timeline scrubber. Bounded by
   * `limit` so a wide window doesn't drag the panel down — order by
   * `createdAt DESC` so we always have the freshest events.
   */
  eventsInRange: workspaceProcedure
    .input(
      z.object({
        from: z.coerce.date(),
        to: z.coerce.date(),
        limit: z.number().int().min(1).max(500).default(200),
      }),
    )
    .query(async ({ ctx, input }) => {
      const events = await ctx.db.agentRunEvent.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          createdAt: { gte: input.from, lte: input.to },
        },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        include: {
          run: {
            select: {
              id: true,
              issueId: true,
              agent: { select: { id: true, name: true, profileKey: true } },
              issue: {
                select: {
                  number: true,
                  workspace: { select: { key: true, slug: true } },
                },
              },
            },
          },
        },
      });
      return events;
    }),

  /**
   * Sparkline data: event counts bucketed by minute over a rolling window.
   * Powers the activity sparkline in Mission Control.
   */
  recentEventCounts: workspaceProcedure
    .input(z.object({
      windowMinutes: z.number().int().min(5).max(120).default(30),
      bucketSeconds: z.number().int().min(30).max(600).default(60),
    }).default({ windowMinutes: 30, bucketSeconds: 60 }))
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - input.windowMinutes * 60_000);
      const rows = await ctx.db.$queryRawUnsafe<Array<{ bucket: Date; count: bigint }>>(
        `SELECT date_trunc('minute', "createdAt") AS bucket, COUNT(*)::bigint AS count
           FROM "AgentRunEvent"
          WHERE "workspaceId" = $1 AND "createdAt" >= $2
       GROUP BY bucket
       ORDER BY bucket ASC`,
        ctx.workspaceId, since,
      );
      return rows.map(r => ({ ts: r.bucket.toISOString(), count: Number(r.count) }));
    }),

  /**
   * Latest AI-coach diagnosis comment for a run. Returns null when
   * aiCoachEnabled is off or no coach comment exists.
   */
  coachDiagnosis: workspaceProcedure
    .input(z.object({ runId: idString }))
    .query(async ({ ctx, input }) => {
      const run = await ctx.db.agentRun.findFirst({
        where: { id: input.runId, workspaceId: ctx.workspaceId },
        select: { issueId: true, workspace: { select: { aiCoachEnabled: true } } },
      });
      if (!run || !run.workspace.aiCoachEnabled) return null;
      const comment = await ctx.db.comment.findFirst({
        where: {
          issueId: run.issueId,
          authoringAgent: { role: "COACH" },
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true, body: true, createdAt: true,
          authoringAgent: { select: { name: true, profileKey: true, avatar: true } },
        },
      });
      return comment;
    }),

  /**
   * All runs (active + terminal) that overlap a time window. Powers the
   * swimlane / Gantt view in Mission Control.
   */
  runsInRange: workspaceProcedure
    .input(z.object({
      fromMinutesAgo: z.number().int().min(15).max(360).default(60),
      limit: z.number().int().min(1).max(500).default(200),
    }).default({ fromMinutesAgo: 60, limit: 200 }))
    .query(async ({ ctx, input }) => {
      const from = new Date(Date.now() - input.fromMinutesAgo * 60_000);
      return ctx.db.agentRun.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          OR: [{ startedAt: { gte: from } }, { finishedAt: { gte: from } }],
        },
        orderBy: { startedAt: "desc" },
        take: input.limit,
        select: {
          id: true, status: true, startedAt: true, finishedAt: true, lastEventAt: true,
          agent: { select: { id: true, name: true, profileKey: true, avatar: true } },
          issue: { select: { number: true, workspace: { select: { key: true, slug: true } } } },
        },
      });
    }),

  /**
   * Predictive ETA for an active run, based on median duration for this
   * agent + label combination over the past 30 days.
   */
  eta: workspaceProcedure
    .input(z.object({ runId: idString }))
    .query(async ({ ctx, input }) => {
      const run = await ctx.db.agentRun.findFirst({
        where: { id: input.runId, workspaceId: ctx.workspaceId },
        select: {
          id: true, agentId: true, startedAt: true,
          issue: { select: { labels: { select: { labelId: true }, take: 1 } } },
        },
      });
      if (!run) return null;
      const labelId = run.issue.labels[0]?.labelId ?? null;
      const { medianRunDurationMs } = await import("@/server/services/agent-run-eta");
      const result = await medianRunDurationMs(ctx.db, {
        workspaceId: ctx.workspaceId,
        agentId: run.agentId,
        labelId,
      });
      if (!result) return null;
      const elapsed = Date.now() - run.startedAt.getTime();
      const remaining = Math.max(0, result.medianMs - elapsed);
      return { medianMs: result.medianMs, sampleSize: result.sampleSize, etaMs: remaining };
    }),

  /**
   * Abandon an active run, optionally unassigning the issue.
   */
  abandon: workspaceProcedure
    .input(z.object({
      runId: idString,
      summary: z.string().max(500).optional(),
      alsoUnassign: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const { finishRun } = await import("@/server/services/agent-run");
      return ctx.db.$transaction(async (tx) => {
        const run = await tx.agentRun.findFirst({
          where: { id: input.runId, workspaceId: ctx.workspaceId },
          select: { id: true, issueId: true, agentId: true, status: true },
        });
        if (!run) throw new Error("Run not found");
        await finishRun(tx, {
          runId: run.id,
          workspaceId: ctx.workspaceId,
          issueId: run.issueId,
          agentId: run.agentId,
          status: "ABANDONED",
          summary: input.summary ?? null,
          actorId: ctx.session.user.id,
        });
        if (input.alsoUnassign) {
          await tx.issue.update({
            where: { id: run.issueId },
            data: { assignedAgentId: null, claimedById: null, claimedAt: null },
          });
        }
        return { ok: true };
      });
    }),

  /**
   * Re-dispatch a run: abandon the current run, clear the assignment,
   * mark the issue queued, and trigger auto-dispatch.
   */
  redispatch: workspaceProcedure
    .input(z.object({ runId: idString }))
    .mutation(async ({ ctx, input }) => {
      const { finishRun } = await import("@/server/services/agent-run");
      return ctx.db.$transaction(async (tx) => {
        const run = await tx.agentRun.findFirst({
          where: { id: input.runId, workspaceId: ctx.workspaceId },
          select: { id: true, issueId: true, agentId: true },
        });
        if (!run) throw new Error("Run not found");
        await finishRun(tx, {
          runId: run.id,
          workspaceId: ctx.workspaceId,
          issueId: run.issueId,
          agentId: run.agentId,
          status: "ABANDONED",
          summary: "Re-dispatched",
          actorId: ctx.session.user.id,
        });
        await tx.issue.update({
          where: { id: run.issueId },
          data: { assignedAgentId: null, claimedById: null, claimedAt: null, queued: true },
        });
        // maybeAutoDispatch is imported at top of file.
        await maybeAutoDispatch(tx, run.issueId);
        return { ok: true, redispatched: true };
      });
    }),

  /**
   * Nudge an agent on an active run by posting an @mention comment on
   * the issue. The audit fan-out routes the comment to the agent's webhook.
   */
  nudge: workspaceProcedure
    .input(z.object({
      runId: idString,
      message: z.string().max(500).default("checking in"),
    }))
    .mutation(async ({ ctx, input }) => {
      const run = await ctx.db.agentRun.findFirst({
        where: { id: input.runId, workspaceId: ctx.workspaceId },
        select: {
          id: true, issueId: true,
          agent: { select: { id: true, profileKey: true } },
        },
      });
      if (!run) throw new Error("Run not found");
      const body = `@${run.agent.profileKey} ${input.message}`;
      return ctx.db.$transaction(async (tx) => {
        const comment = await tx.comment.create({
          data: {
            workspaceId: ctx.workspaceId,
            issueId: run.issueId,
            authorId: ctx.session.user.id,
            body,
            kind: "BODY",
          },
        });
        const { recordChange } = await import("@/server/audit");
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "Comment",
          entityId: comment.id,
          action: "create",
          eventKind: EventKind.COMMENT_CREATED,
          subjectType: "issue",
          subjectId: run.issueId,
          payload: {
            commentId: comment.id,
            mentions: [{ agentId: run.agent.id, profileKey: run.agent.profileKey }],
          },
        });
        return { ok: true, commentId: comment.id };
      });
    }),
});
