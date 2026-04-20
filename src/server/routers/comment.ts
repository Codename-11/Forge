import { z } from "zod";
import { EventKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";

export const commentRouter = router({
  create: workspaceProcedure
    .input(z.object({ issueId: z.string().cuid(), body: z.string().min(1).max(50_000) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const comment = await tx.comment.create({
          data: {
            workspaceId: ctx.workspaceId,
            issueId: input.issueId,
            authorId: ctx.session.user.id,
            body: input.body,
          },
          include: { author: { select: { id: true, name: true, image: true } } },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "Comment",
          entityId: comment.id,
          action: "create",
          after: comment,
          eventKind: EventKind.COMMENT_CREATED,
          subjectType: "issue",
          subjectId: input.issueId,
          payload: { commentId: comment.id, preview: input.body.slice(0, 120) },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return comment;
      });
    }),

  update: workspaceProcedure
    .input(z.object({ id: z.string().cuid(), body: z.string().min(1).max(50_000) }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.comment.update({
        where: { id: input.id },
        data: { body: input.body, updatedAt: new Date() },
      }),
    ),

  softDelete: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.comment.update({ where: { id: input.id }, data: { deletedAt: new Date() } }),
    ),
});
