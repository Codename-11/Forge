import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Priority } from "@prisma/client";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";

const inputShape = {
  name: z.string().min(1).max(80),
  projectId: z.string().cuid().nullable().optional(),
  titleTemplate: z.string().min(1).max(300),
  descriptionTemplate: z.string().max(50_000).nullable().optional(),
  defaultPriority: z.nativeEnum(Priority).default(Priority.NONE),
  labelIds: z.array(z.string().cuid()).default([]),
};

export const issueTemplateRouter = router({
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.db.issueTemplate.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { name: "asc" },
      include: { project: { select: { id: true, name: true, key: true, color: true } } },
    }),
  ),

  byId: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const t = await ctx.db.issueTemplate.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      if (!t) throw new TRPCError({ code: "NOT_FOUND" });
      return t;
    }),

  create: adminProcedure.input(z.object(inputShape)).mutation(async ({ ctx, input }) => {
    const existing = await ctx.db.issueTemplate.findUnique({
      where: { workspaceId_name: { workspaceId: ctx.workspaceId, name: input.name } },
    });
    if (existing) throw new TRPCError({ code: "CONFLICT", message: "Name already used." });
    return ctx.db.issueTemplate.create({
      data: {
        workspaceId: ctx.workspaceId,
        name: input.name,
        projectId: input.projectId ?? null,
        titleTemplate: input.titleTemplate,
        descriptionTemplate: input.descriptionTemplate ?? null,
        defaultPriority: input.defaultPriority,
        labelIds: input.labelIds,
      },
    });
  }),

  update: adminProcedure
    .input(z.object({ id: z.string().cuid(), ...partialize(inputShape) }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const row = await ctx.db.issueTemplate.findFirstOrThrow({
        where: { id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.issueTemplate.update({ where: { id: row.id }, data: patch });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.issueTemplate.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.issueTemplate.delete({ where: { id: row.id } });
    }),
});

function partialize<T extends Record<string, z.ZodTypeAny>>(shape: T) {
  const out = {} as { [K in keyof T]: z.ZodOptional<T[K]> };
  for (const k of Object.keys(shape) as (keyof T)[]) out[k] = shape[k].optional() as never;
  return out;
}
