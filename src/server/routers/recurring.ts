import { z } from "zod";
import { Priority } from "@prisma/client";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";

const inputShape = {
  name: z.string().min(1).max(80),
  projectId: z.string().cuid().nullable().optional(),
  titleTemplate: z.string().min(1).max(300),
  descriptionTemplate: z.string().max(50_000).nullable().optional(),
  defaultPriority: z.nativeEnum(Priority).default(Priority.NONE),
  intervalDays: z.number().int().min(1).max(365),
  nextRunAt: z.coerce.date(),
  active: z.boolean().default(true),
};

export const recurringRouter = router({
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.db.recurringIssue.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { nextRunAt: "asc" },
      include: { project: { select: { id: true, name: true, key: true, color: true } } },
    }),
  ),

  create: adminProcedure.input(z.object(inputShape)).mutation(async ({ ctx, input }) =>
    ctx.db.recurringIssue.create({
      data: {
        workspaceId: ctx.workspaceId,
        name: input.name,
        projectId: input.projectId ?? null,
        titleTemplate: input.titleTemplate,
        descriptionTemplate: input.descriptionTemplate ?? null,
        defaultPriority: input.defaultPriority,
        intervalDays: input.intervalDays,
        nextRunAt: input.nextRunAt,
        active: input.active,
        createdById: ctx.session.user.id,
      },
    }),
  ),

  update: adminProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().min(1).max(80).optional(),
        projectId: z.string().cuid().nullable().optional(),
        titleTemplate: z.string().min(1).max(300).optional(),
        descriptionTemplate: z.string().max(50_000).nullable().optional(),
        defaultPriority: z.nativeEnum(Priority).optional(),
        intervalDays: z.number().int().min(1).max(365).optional(),
        nextRunAt: z.coerce.date().optional(),
        active: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const row = await ctx.db.recurringIssue.findFirstOrThrow({
        where: { id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.recurringIssue.update({ where: { id: row.id }, data: patch });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.recurringIssue.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.recurringIssue.delete({ where: { id: row.id } });
    }),

  /** Manually fire this schedule now (useful for testing). */
  runNow: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.recurringIssue.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      const { runRecurringOnce } = await import("@/server/services/recurring");
      return runRecurringOnce(row.id);
    }),
});
