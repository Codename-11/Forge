import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { AgentRunControlState, AgentRunStatus, EventKind, Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { maybeAutoDispatch } from "@/server/services/dispatcher";
import { deliverWebhook } from "@/server/services/plugin-runtime";
import { STALE_RUN_MS } from "@/server/services/agent-presence";
import { appendRunEvent, finishRun } from "@/server/services/agent-run";
import { getRunsConnectorForAgent } from "@/server/services/dispatch/registry";

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
      // Treat WAITING runs as "still in flight" for the live strip so a
      // patient agent doesn't disappear from the issue page just because
      // it self-blocked. The strip itself renders WAITING with a soft
      // "Waiting on you" pill instead of the warming ember pulse.
      const run = await ctx.db.agentRun.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          issueId: input.issueId,
          status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
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
          // Joined so the pipeline UI can attribute pending control
          // requests ("pause requested by X 2m ago"). SetNull on user
          // delete means this can be null even with a non-NONE
          // controlState.
          controlRequestedBy: {
            select: { id: true, name: true, image: true },
          },
        },
      });
    }),

  /**
   * Per-agent cost + token aggregates over a sliding window. Powers the
   * cost chips on the Agents tab, the Queue dispatch picker, and the
   * History totals. Decimal `costUsd` is coerced to a plain number for the
   * wire. Window defaults to 30 days.
   */
  costByAgent: workspaceProcedure
    .input(
      z
        .object({ sinceDays: z.number().int().min(1).max(365).default(30) })
        .default({ sinceDays: 30 }),
    )
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - input.sinceDays * 86_400_000);
      const grouped = await ctx.db.agentRun.groupBy({
        by: ["agentId"],
        where: { workspaceId: ctx.workspaceId, startedAt: { gte: since } },
        _sum: { costUsd: true, tokensIn: true, tokensOut: true, tokensCached: true },
        _count: true,
      });
      const byAgent = grouped.map((g) => ({
        agentId: g.agentId,
        runs: g._count,
        costUsd: g._sum?.costUsd ? Number(g._sum.costUsd) : 0,
        tokensIn: g._sum?.tokensIn ?? 0,
        tokensOut: g._sum?.tokensOut ?? 0,
        tokensCached: g._sum?.tokensCached ?? 0,
      }));
      const totals = byAgent.reduce(
        (acc, a) => ({
          runs: acc.runs + a.runs,
          costUsd: acc.costUsd + a.costUsd,
          tokensIn: acc.tokensIn + a.tokensIn,
          tokensOut: acc.tokensOut + a.tokensOut,
          tokensCached: acc.tokensCached + a.tokensCached,
        }),
        { runs: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0 },
      );
      return { sinceDays: input.sinceDays, byAgent, totals };
    }),

  /**
   * Cost + approval metadata for a set of run ids. Powers the per-step
   * cost label + approval overlay on the Plans DAG, where steps carry a
   * loose `sourceRunId` (no relation) so we resolve it in one batch.
   */
  metaByIds: workspaceProcedure
    .input(z.object({ ids: z.array(z.string().min(1)).max(100) }))
    .query(async ({ ctx, input }) => {
      if (input.ids.length === 0) return [];
      const rows = await ctx.db.agentRun.findMany({
        where: { workspaceId: ctx.workspaceId, id: { in: input.ids } },
        select: {
          id: true,
          costUsd: true,
          tokensIn: true,
          tokensOut: true,
          awaitingApprovalAt: true,
        },
      });
      return rows.map((r) => ({
        id: r.id,
        costUsd: r.costUsd ? Number(r.costUsd) : 0,
        tokensIn: r.tokensIn ?? 0,
        tokensOut: r.tokensOut ?? 0,
        awaitingApproval: r.awaitingApprovalAt != null,
      }));
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
      // Terminal = COMPLETED / ABANDONED / STALLED. ACTIVE and WAITING
      // are explicitly excluded — WAITING is non-terminal (the agent is
      // paused on the operator) and should keep appearing on the live
      // surfaces, not in the post-mortem History tab.
      return ctx.db.agentRun.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          status: {
            notIn: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING],
          },
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
   * List runs in the workspace, filtered by status / agent. Powers the
   * Failed-Run lane in Phase 1's Agents UI. Bounded at 100 — wider
   * paging is a future addition.
   */
  list: workspaceProcedure
    .input(
      z
        .object({
          status: z.array(z.nativeEnum(AgentRunStatus)).max(5).optional(),
          agentId: idString.optional(),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .default({ limit: 30 }),
    )
    .query(async ({ ctx, input }) => {
      return ctx.db.agentRun.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(input.status?.length ? { status: { in: input.status } } : {}),
          ...(input.agentId ? { agentId: input.agentId } : {}),
        },
        orderBy: [{ lastEventAt: "desc" }, { startedAt: "desc" }],
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
              status: {
                select: { id: true, name: true, category: true, color: true },
              },
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
   * Operator-requested pause on an active run. Stamps the AgentRun
   * with `controlState = PAUSE_REQUESTED` and pings the agent's
   * webhook (best-effort, non-blocking) so the runtime can act on
   * its next loop tick. The runtime is responsible for resetting
   * `controlState` to NONE once it acts.
   */
  requestPause: workspaceProcedure
    .input(z.object({ runId: idString }))
    .mutation(async ({ ctx, input }) => {
      return requestRunControl(ctx, {
        runId: input.runId,
        control: "pause",
        nextState: AgentRunControlState.PAUSE_REQUESTED,
      });
    }),

  /**
   * Operator-requested cancel on an active run. Same plumbing as
   * `requestPause`; the runtime decides whether the run terminates
   * cleanly (ABANDONED) or requires further intervention.
   */
  requestCancel: workspaceProcedure
    .input(z.object({ runId: idString }))
    .mutation(async ({ ctx, input }) => {
      return requestRunControl(ctx, {
        runId: input.runId,
        control: "cancel",
        nextState: AgentRunControlState.CANCEL_REQUESTED,
      });
    }),

  /**
   * Composite "redirect to another agent": cancels the current run
   * (control signal sent to the original agent) AND reassigns the
   * issue to `toAgentId`. The reassignment fires its own
   * `AGENT_ASSIGNED` audit event via the existing chain — we don't
   * duplicate it here. Single audit row written:
   * AGENT_RUN_CONTROL_REQUESTED with `control = "redirect"` so the
   * activity stream reads cleanly.
   */
  requestRedirect: workspaceProcedure
    .input(
      z.object({
        runId: idString,
        toAgentId: idString,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const run = await tx.agentRun.findFirst({
          where: { id: input.runId, workspaceId: ctx.workspaceId },
          select: {
            id: true,
            issueId: true,
            agentId: true,
            agent: {
              select: { id: true, profileKey: true, webhookUrl: true, webhookSecret: true },
            },
          },
        });
        if (!run) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Run not found." });
        }
        // Validate the target agent lives in this workspace.
        const target = await tx.agent.findFirst({
          where: { id: input.toAgentId, workspaceId: ctx.workspaceId },
          select: { id: true, profileKey: true },
        });
        if (!target) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Target agent not found in this workspace.",
          });
        }

        // Stamp cancel-requested on the run so the original agent's
        // runtime sees the signal on its next loop tick.
        await tx.agentRun.update({
          where: { id: run.id },
          data: {
            controlState: AgentRunControlState.CANCEL_REQUESTED,
            controlRequestedAt: new Date(),
            controlRequestedById: ctx.session.user.id,
          },
        });

        // Reassign the issue. This goes through the same path as a
        // direct issue.update assignedAgentId change — it would normally
        // also stamp dispatchReason + emit AGENT_ASSIGNED via
        // recordChange. We replicate that here in-transaction so the
        // audit stream stays consistent.
        const before = await tx.issue.findUniqueOrThrow({
          where: { id: run.issueId },
          select: { id: true, assignedAgentId: true },
        });
        const reasonBlob = {
          mode: "MANUAL_REDIRECT",
          candidatesConsidered: [target.profileKey],
          picked: target.profileKey,
          reasonText: `redirect from run ${run.id}`,
          decidedAt: new Date().toISOString(),
        };
        await tx.issue.update({
          where: { id: run.issueId },
          data: {
            assignedAgentId: target.id,
            dispatchReason: reasonBlob,
          },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Issue",
          entityId: run.issueId,
          action: "assign-agent",
          before: { assignedAgentId: before.assignedAgentId },
          after: { assignedAgentId: target.id },
          eventKind: EventKind.AGENT_ASSIGNED,
          subjectType: "issue",
          subjectId: run.issueId,
          payload: {
            agentId: target.id,
            previousAgentId: before.assignedAgentId,
            redirectedFromRunId: run.id,
            dispatchReason: reasonBlob,
          },
        });

        // Single audit/event for the control action itself.
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "AgentRun",
          entityId: run.id,
          action: "control-request",
          eventKind: EventKind.AGENT_RUN_CONTROL_REQUESTED,
          subjectType: "agent-run",
          subjectId: run.id,
          payload: {
            control: "redirect",
            runId: run.id,
            toAgentId: target.id,
            issueId: run.issueId,
          },
        });

        // Best-effort webhook ping to the original agent so it knows
        // its run was redirected. Same shape as pause/cancel.
        const url = run.agent.webhookUrl;
        const secret = run.agent.webhookSecret;
        if (url && secret) {
          void deliverWebhook({
            url,
            secret,
            timeoutMs: 5000,
            body: {
              id: `run-control-${run.id}-redirect-${Date.now()}`,
              kind: "AGENT_RUN_CONTROL",
              subjectType: "agent-run",
              subjectId: run.id,
              payload: {
                control: "redirect",
                runId: run.id,
                issueId: run.issueId,
                toAgentId: target.id,
                workspaceId: ctx.workspaceId,
              },
              createdAt: new Date().toISOString(),
            },
          }).catch(() => {
            // Webhook delivery is best-effort; failures are absorbed.
          });
        }

        return { ok: true, redirectedTo: target.id };
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
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
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

  /**
   * Operator-driven "kick" of a stalled run. Re-fires the dispatch
   * webhook for the underlying issue without changing assignment or
   * controlState — just nudges the agent to wake up. The audit
   * fan-out re-uses the per-agent dispatch shim that originally
   * delivered AGENT_ASSIGNED, so the runtime sees an event shape it
   * already knows how to handle.
   *
   * Eligibility: run must be ACTIVE and stalled (lastEventAt older
   * than `STALE_RUN_MS`). If the run is younger than that we no-op
   * silently — the operator might have raced a fresh tick — and
   * return `{ ok: true, kicked: false }`. If the run is no longer
   * active we throw so the UI can clear its optimistic state.
   *
   * Records `EventKind.AGENT_RUN_KICKED` so the timeline distinguishes
   * a kick from auto-dispatch / control-request flows.
   */
  /**
   * Resolve a connector-driven run that paused awaiting operator
   * permission (Hermes flagged a dangerous command). Approve → allow the
   * command once and resume; reject → stop the run (a bare gateway "deny"
   * leaves the agent blocked, so we interrupt it) and mark it ABANDONED.
   */
  respondApproval: workspaceProcedure
    .input(z.object({ runId: idString, decision: z.enum(["approve", "reject"]) }))
    .mutation(async ({ ctx, input }) => {
      const run = await ctx.db.agentRun.findFirst({
        where: { id: input.runId, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          issueId: true,
          agentId: true,
          status: true,
          externalRunId: true,
          awaitingApprovalAt: true,
          agent: {
            select: {
              provider: true,
              runtime: { select: { adapterKey: true, endpoint: true, secret: true } },
            },
          },
        },
      });
      if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "Run not found." });
      if (!run.externalRunId || !run.awaitingApprovalAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Run is not awaiting approval.",
        });
      }
      const connector = getRunsConnectorForAgent({
        provider: run.agent.provider,
        runtime: run.agent.runtime,
      });
      if (!connector) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No run connector for this agent's provider.",
        });
      }

      if (input.decision === "approve") {
        await connector.approve?.(run.externalRunId, "once");
        await ctx.db.$transaction(async (tx) => {
          await tx.agentRun.update({
            where: { id: run.id },
            data: {
              awaitingApprovalAt: null,
              pendingApproval: Prisma.DbNull,
              lastEventAt: new Date(),
            },
          });
          await appendRunEvent(tx, {
            runId: run.id,
            workspaceId: ctx.workspaceId,
            issueId: run.issueId,
            agentId: run.agentId,
            kind: "STEP",
            currentStep: "approved · resuming",
            payload: { approval: "once" },
          });
        });
        return { ok: true as const, decision: "approve" as const };
      }

      // Reject → stop the live run, then close the AgentRun.
      await connector.stop?.(run.externalRunId);
      await ctx.db.$transaction(async (tx) => {
        await tx.agentRun.update({
          where: { id: run.id },
          data: { awaitingApprovalAt: null, pendingApproval: Prisma.DbNull },
        });
        await finishRun(tx, {
          runId: run.id,
          workspaceId: ctx.workspaceId,
          issueId: run.issueId,
          agentId: run.agentId,
          status: "ABANDONED",
          summary: "Operator rejected a permission request; run stopped.",
          actorId: ctx.session.user.id,
        });
      });
      return { ok: true as const, decision: "reject" as const };
    }),

  kick: workspaceProcedure
    .input(z.object({ runId: idString }))
    .mutation(async ({ ctx, input }) => {
      const run = await ctx.db.agentRun.findFirst({
        where: { id: input.runId, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          issueId: true,
          status: true,
          lastEventAt: true,
          currentStep: true,
          agent: {
            select: {
              id: true,
              profileKey: true,
              webhookUrl: true,
              webhookSecret: true,
            },
          },
        },
      });
      if (!run) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found." });
      }
      if (run.status !== AgentRunStatus.ACTIVE) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Run is ${run.status}; only ACTIVE runs can be kicked.`,
        });
      }
      const idleMs = Date.now() - run.lastEventAt.getTime();
      if (idleMs < STALE_RUN_MS) {
        // Not stalled yet — silent no-op. The UI's optimistic "kicked"
        // hint will time out on its own; the operator can retry.
        return { ok: true, kicked: false, idleMs } as const;
      }

      await ctx.db.$transaction(async (tx) => {
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "AgentRun",
          entityId: run.id,
          action: "kick",
          eventKind: EventKind.AGENT_RUN_KICKED,
          subjectType: "agent-run",
          subjectId: run.id,
          payload: {
            runId: run.id,
            issueId: run.issueId,
            agentId: run.agent.id,
            idleMs,
            currentStep: run.currentStep,
          },
        });
      });

      // Best-effort webhook ping. Distinct kind so the runtime can
      // treat it differently from a fresh assignment if it wants —
      // most adapters can re-use their AGENT_ASSIGNED handler since
      // payload shape is similar.
      const url = run.agent.webhookUrl;
      const secret = run.agent.webhookSecret;
      if (url && secret) {
        void deliverWebhook({
          url,
          secret,
          timeoutMs: 5000,
          body: {
            id: `run-kick-${run.id}-${Date.now()}`,
            kind: "AGENT_RUN_KICKED",
            subjectType: "agent-run",
            subjectId: run.id,
            payload: {
              runId: run.id,
              issueId: run.issueId,
              agentId: run.agent.id,
              workspaceId: ctx.workspaceId,
              idleMs,
              reason: "operator-kick",
            },
            createdAt: new Date().toISOString(),
          },
        }).catch(() => {
          // Webhook delivery is best-effort; the audit row is durable.
        });
      }

      return { ok: true, kicked: true, idleMs } as const;
    }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Shared plumbing for `requestPause` / `requestCancel`. Stamps the run
 * with the new control state, writes a single
 * `AGENT_RUN_CONTROL_REQUESTED` audit/event row, and best-effort POSTs
 * the agent's webhook so the runtime can react out-of-band.
 *
 * No-op when the run is in a terminal state (COMPLETED / ABANDONED /
 * STALLED) — there's no live runtime to react.
 */
async function requestRunControl(
  ctx: {
    db: PrismaClient;
    workspaceId: string;
    session: { user: { id: string } };
    apiKey: { linkedAgentId: string | null } | null;
  },
  args: {
    runId: string;
    control: "pause" | "cancel";
    nextState: AgentRunControlState;
  },
): Promise<{ ok: true; runId: string; control: "pause" | "cancel" }> {
  const run = await ctx.db.agentRun.findFirst({
    where: { id: args.runId, workspaceId: ctx.workspaceId },
    select: {
      id: true,
      issueId: true,
      status: true,
      controlState: true,
      agent: {
        select: {
          id: true,
          profileKey: true,
          webhookUrl: true,
          webhookSecret: true,
        },
      },
    },
  });
  if (!run) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Run not found." });
  }
  if (run.status !== AgentRunStatus.ACTIVE) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Run is ${run.status}; control signals only apply to ACTIVE runs.`,
    });
  }
  // Idempotent: stamping the same state twice is a no-op besides
  // bumping `controlRequestedAt`. Keeps the chip's optimistic UI sane.
  await ctx.db.$transaction(async (tx) => {
    await tx.agentRun.update({
      where: { id: run.id },
      data: {
        controlState: args.nextState,
        controlRequestedAt: new Date(),
        controlRequestedById: ctx.session.user.id,
      },
    });
    await recordChange(tx, {
      workspaceId: ctx.workspaceId,
      actorId: ctx.session.user.id,
      actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
      entity: "AgentRun",
      entityId: run.id,
      action: "control-request",
      before: { controlState: run.controlState },
      after: { controlState: args.nextState },
      eventKind: EventKind.AGENT_RUN_CONTROL_REQUESTED,
      subjectType: "agent-run",
      subjectId: run.id,
      payload: {
        control: args.control,
        runId: run.id,
        issueId: run.issueId,
        agentId: run.agent.id,
      },
    });
  });

  // Best-effort outbound webhook to the agent's runtime — same plumbing
  // as the test-connection action. Failures are absorbed; the audit/
  // event row is the durable record. The agent's runtime can also pick
  // up the new `controlState` via MCP read on its next poll.
  const url = run.agent.webhookUrl;
  const secret = run.agent.webhookSecret;
  if (url && secret) {
    void deliverWebhook({
      url,
      secret,
      timeoutMs: 5000,
      body: {
        id: `run-control-${run.id}-${args.control}-${Date.now()}`,
        kind: "AGENT_RUN_CONTROL",
        subjectType: "agent-run",
        subjectId: run.id,
        payload: {
          control: args.control,
          runId: run.id,
          issueId: run.issueId,
          agentId: run.agent.id,
          workspaceId: ctx.workspaceId,
        },
        createdAt: new Date().toISOString(),
      },
    }).catch(() => {
      // Webhook delivery is best-effort.
    });
  }

  return { ok: true, runId: run.id, control: args.control };
}
