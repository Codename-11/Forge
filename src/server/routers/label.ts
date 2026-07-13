import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EventKind } from "@prisma/client";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const labelRouter = router({
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.db.label.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { name: "asc" },
      include: { _count: { select: { issues: true } } },
    }),
  ),

  create: adminProcedure
    .input(z.object({ name: z.string().min(1).max(40), color: hexColor }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.label.findUnique({
        where: { workspaceId_name: { workspaceId: ctx.workspaceId, name: input.name } },
      });
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "Label name already used." });
      return ctx.db.label.create({
        data: { ...input, workspaceId: ctx.workspaceId },
      });
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().min(1).max(40).optional(),
        color: hexColor.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const row = await ctx.db.label.findFirstOrThrow({
        where: { id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.label.update({ where: { id: row.id }, data: patch });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.label.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.label.delete({ where: { id: row.id } });
    }),

  /** Replace the full set of labels on an issue. */
  setForIssue: workspaceProcedure
    .input(z.object({ issueId: z.string().cuid(), labelIds: z.array(z.string().cuid()) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const issue = await tx.issue.findFirstOrThrow({
          where: { id: input.issueId, workspaceId: ctx.workspaceId, deletedAt: null },
          include: { labels: { select: { labelId: true } } },
        });
        const labelIds = Array.from(new Set(input.labelIds));
        if (labelIds.length > 0) {
          const labelCount = await tx.label.count({
            where: { id: { in: labelIds }, workspaceId: ctx.workspaceId },
          });
          if (labelCount !== labelIds.length) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Every label must belong to this workspace.",
            });
          }
        }
        await tx.issueLabel.deleteMany({ where: { issueId: input.issueId } });
        if (labelIds.length) {
          await tx.issueLabel.createMany({
            data: labelIds.map((labelId) => ({ issueId: input.issueId, labelId })),
          });
        }
        const updated = await tx.issue.findUniqueOrThrow({
          where: { id: input.issueId },
          include: { labels: { include: { label: true } } },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Issue",
          entityId: issue.id,
          action: "set-labels",
          before: { labelIds: issue.labels.map((row) => row.labelId) },
          after: { labelIds },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "issue",
          subjectId: issue.id,
          payload: { labelIds },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return updated;
      });
    }),
});
