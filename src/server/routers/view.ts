import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";

const filtersSchema = z.object({
  projectId: z.string().cuid().nullable().optional(),
  statusId: z.string().cuid().nullable().optional(),
  assigneeId: z.string().cuid().nullable().optional(),
  priority: z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"]).nullable().optional(),
  query: z.string().max(200).nullable().optional(),
  view: z.enum(["list", "board"]).default("list"),
  includeDone: z.boolean().default(false),
});

export const viewRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) =>
    ctx.db.savedView.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        OR: [{ userId: null }, { userId: ctx.session.user.id }],
      },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    }),
  ),

  create: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        filters: filtersSchema,
        shared: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.savedView.create({
        data: {
          workspaceId: ctx.workspaceId,
          userId: input.shared ? null : ctx.session.user.id,
          name: input.name,
          filters: input.filters as unknown as Prisma.InputJsonValue,
        },
      }),
    ),

  delete: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.savedView.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (row.userId && row.userId !== ctx.session.user.id)
        throw new TRPCError({ code: "FORBIDDEN", message: "Not your view." });
      return ctx.db.savedView.delete({ where: { id: row.id } });
    }),
});
