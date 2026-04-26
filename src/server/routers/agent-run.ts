import { z } from "zod";
import { AgentRunStatus } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";

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
    .input(z.object({ issueId: z.string().cuid() }))
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
        runId: z.string().cuid(),
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
});
