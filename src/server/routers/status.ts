import { z } from "zod";
import { StatusCategory } from "@prisma/client";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";

export const statusRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) =>
    ctx.db.status.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { position: "asc" },
    }),
  ),
  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(40),
        category: z.nativeEnum(StatusCategory),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        position: z.number().int().min(0),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.status.create({ data: { ...input, workspaceId: ctx.workspaceId } }),
    ),
  reorder: adminProcedure
    .input(z.array(z.object({ id: z.string().cuid(), position: z.number().int().min(0) })))
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(
        input.map((s) =>
          ctx.db.status.update({
            where: { id: s.id },
            data: { position: s.position },
          }),
        ),
      ),
    ),
});
