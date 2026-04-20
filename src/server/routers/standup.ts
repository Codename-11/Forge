import { z } from "zod";
import { router, workspaceProcedure } from "@/server/trpc";

/**
 * Generate a "yesterday / today / blocked" draft from the user's recent
 * activity. Stateless — each call recomputes from issues + audit events.
 */
export const standupRouter = router({
  draft: workspaceProcedure
    .input(z.object({ sinceHours: z.number().int().min(1).max(168).default(24) }).default({}))
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - input.sinceHours * 3600_000);
      const userId = ctx.session.user.id;

      const [closed, moved, newlyOpened, inProgress, blocked] = await Promise.all([
        // Issues I completed
        ctx.db.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            deletedAt: null,
            completedAt: { gte: since },
            OR: [
              { authorId: userId },
              { assignees: { some: { userId } } },
            ],
          },
          select: { id: true, number: true, title: true },
          take: 20,
        }),
        // Issues I advanced (status moved in the window) but didn't complete
        ctx.db.auditLog.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            actorId: userId,
            entity: "Issue",
            action: "update",
            createdAt: { gte: since },
          },
          select: { entityId: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
        // Issues I authored in the window
        ctx.db.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            deletedAt: null,
            authorId: userId,
            createdAt: { gte: since },
          },
          select: { id: true, number: true, title: true },
          take: 20,
        }),
        // Issues assigned to me that are in progress
        ctx.db.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            deletedAt: null,
            status: { category: "IN_PROGRESS" },
            assignees: { some: { userId } },
          },
          select: { id: true, number: true, title: true, updatedAt: true },
          take: 20,
        }),
        // Issues assigned to me and not progressed in 3+ days (probably blocked)
        ctx.db.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            deletedAt: null,
            assignees: { some: { userId } },
            status: { category: { notIn: ["DONE", "CANCELED"] } },
            updatedAt: { lt: new Date(Date.now() - 3 * 86_400_000) },
          },
          select: { id: true, number: true, title: true },
          take: 10,
        }),
      ]);

      const ws = await ctx.db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { key: true },
      });
      const id = (n: number) => `${ws.key}-${n}`;

      const yesterday = [
        ...closed.map((i) => `- Closed ${id(i.number)}: ${i.title}`),
        ...newlyOpened.map((i) => `- Opened ${id(i.number)}: ${i.title}`),
      ];
      const today = inProgress.map((i) => `- Continue ${id(i.number)}: ${i.title}`);
      const blockers = blocked.map((i) => `- ${id(i.number)}: ${i.title} (no movement in 3d)`);

      const md = [
        "*Yesterday*",
        yesterday.length ? yesterday.join("\n") : "_(nothing recorded)_",
        "",
        "*Today*",
        today.length ? today.join("\n") : "_(nothing in progress)_",
        "",
        "*Blocked / stalled*",
        blockers.length ? blockers.join("\n") : "_none_",
      ].join("\n");

      return {
        markdown: md,
        sinceHours: input.sinceHours,
        counts: {
          closed: closed.length,
          opened: newlyOpened.length,
          moved: moved.length,
          inProgress: inProgress.length,
          blocked: blocked.length,
        },
      };
    }),
});
