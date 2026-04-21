import { z } from "zod";
import { EventKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { extractMentions } from "@/server/services/mentions";

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

        // Resolve @profileKey tokens to Agents in this workspace so the
        // COMMENT_CREATED event can carry a structured `mentions` array.
        // Lane C's fan-out uses this to enqueue per-agent WebhookDelivery
        // rows against the synthetic `agent:dispatch:{agentId}` webhook.
        const tokens = extractMentions(input.body);
        const mentions: Array<{ agentId: string; profileKey: string }> = [];
        if (tokens.length) {
          const matches = await tx.agent.findMany({
            where: {
              workspaceId: ctx.workspaceId,
              profileKey: { in: tokens },
              archivedAt: null,
            },
            select: { id: true, profileKey: true },
          });
          for (const a of matches) {
            mentions.push({ agentId: a.id, profileKey: a.profileKey });
          }
        }

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
          payload: {
            commentId: comment.id,
            issueId: input.issueId,
            preview: input.body.slice(0, 120),
            mentions,
          },
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
