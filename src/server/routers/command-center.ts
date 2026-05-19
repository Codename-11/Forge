import { z } from "zod";
import { ActionRequestStatus, AgentRunStatus, ReviewGateStatus } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";

/**
 * Command Center router — daily-operator aggregator. Single query that
 * stitches together the surfaces an operator wants before starting
 * their day:
 *
 *   - open ActionRequests assigned to me
 *   - pending ReviewGates targeting me (or unassigned)
 *   - active agent runs in this workspace (capped for sanity)
 *   - stalled agent runs (status = STALLED)
 *   - recently updated artifacts (top 10 most recent non-archived)
 *   - issues due soon (within 7 days, not DONE/CANCELED)
 *
 * Writes still land on the canonical detail pages — Command Center
 * is read-only. Mobile-first layout responsibility is on the page.
 */
export const commandCenterRouter = router({
  summary: workspaceProcedure
    .input(
      z
        .object({
          dueWindowDays: z.number().int().min(0).max(60).default(7),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .default({ dueWindowDays: 7, limit: 20 }),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session?.user?.id ?? null;
      const dueCutoff = new Date(Date.now() + input.dueWindowDays * 24 * 60 * 60 * 1000);

      const [
        actionRequests,
        reviewGates,
        activeRuns,
        stalledRuns,
        recentArtifacts,
        dueIssues,
        runningTimer,
      ] = await Promise.all([
        userId
          ? ctx.db.actionRequest.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                assignedUserId: userId,
                status: ActionRequestStatus.OPEN,
              },
              orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
              take: input.limit,
              include: {
                requestedByAgent: { select: { id: true, name: true, profileKey: true, avatar: true } },
                requestedByUser: { select: { id: true, name: true, image: true } },
                issue: {
                  select: {
                    id: true,
                    number: true,
                    title: true,
                    workspace: { select: { slug: true, key: true } },
                  },
                },
              },
            })
          : Promise.resolve([]),
        ctx.db.reviewGate.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            status: ReviewGateStatus.PENDING,
          },
          orderBy: { createdAt: "desc" },
          take: input.limit,
        }),
        ctx.db.agentRun.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            status: AgentRunStatus.ACTIVE,
          },
          orderBy: { lastEventAt: "desc" },
          take: input.limit,
          include: {
            agent: { select: { id: true, name: true, profileKey: true, avatar: true } },
            issue: {
              select: {
                id: true,
                number: true,
                title: true,
                workspace: { select: { slug: true, key: true } },
              },
            },
          },
        }),
        ctx.db.agentRun.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            status: AgentRunStatus.STALLED,
          },
          orderBy: { lastEventAt: "desc" },
          take: input.limit,
          include: {
            agent: { select: { id: true, name: true, profileKey: true, avatar: true } },
            issue: {
              select: {
                id: true,
                number: true,
                title: true,
                workspace: { select: { slug: true, key: true } },
              },
            },
          },
        }),
        ctx.db.artifact.findMany({
          where: { workspaceId: ctx.workspaceId, archivedAt: null },
          orderBy: { updatedAt: "desc" },
          take: 10,
          select: {
            id: true,
            slug: true,
            title: true,
            type: true,
            status: true,
            updatedAt: true,
          },
        }),
        ctx.db.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            deletedAt: null,
            dueDate: { not: null, lte: dueCutoff },
            status: { category: { notIn: ["DONE", "CANCELED"] } },
          },
          orderBy: { dueDate: "asc" },
          take: input.limit,
          select: {
            id: true,
            number: true,
            title: true,
            dueDate: true,
            priority: true,
            status: { select: { name: true, category: true, color: true } },
            workspace: { select: { slug: true, key: true } },
          },
        }),
        userId
          ? ctx.db.timeEntry.findFirst({
              where: {
                workspaceId: ctx.workspaceId,
                userId,
                endedAt: null,
              },
              orderBy: { startedAt: "desc" },
              include: {
                issue: {
                  select: {
                    id: true,
                    number: true,
                    title: true,
                    workspace: { select: { slug: true, key: true } },
                  },
                },
              },
            })
          : Promise.resolve(null),
      ]);

      return {
        actionRequests,
        reviewGates,
        activeRuns,
        stalledRuns,
        recentArtifacts,
        dueIssues,
        runningTimer,
        counts: {
          actionRequests: actionRequests.length,
          reviewGates: reviewGates.length,
          activeRuns: activeRuns.length,
          stalledRuns: stalledRuns.length,
          recentArtifacts: recentArtifacts.length,
          dueIssues: dueIssues.length,
        },
      };
    }),
});
