import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const inputShape = {
  name: z.string().min(1).max(80),
  suggestedKey: z
    .string()
    .min(2)
    .max(8)
    .regex(/^[A-Z0-9]+$/, "Key must be uppercase alphanumeric."),
  description: z.string().max(4000).nullable().optional(),
  color: hexColor.nullable().optional(),
  icon: z.string().max(8).nullable().optional(),
};

const DEFAULTS = [
  { name: "Forge", suggestedKey: "FRG", description: "Dogfood the PM platform itself.", color: "#d97706", icon: "⚒", position: 0 },
  { name: "Hermes-Relay", suggestedKey: "HR", description: "Agent relay — profiles, skills, delivery.", color: "#7c3aed", icon: "☿", position: 1 },
  { name: "Lucid-Memory", suggestedKey: "LM", description: "Agent-facing memory service.", color: "#0ea5e9", icon: "◈", position: 2 },
] as const;

export const projectTemplateRouter = router({
  /**
   * List project templates. On first call (empty), seed the three canonical
   * defaults so the UX isn't empty out of the box.
   */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.projectTemplate.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    if (rows.length === 0) {
      await ctx.db.projectTemplate.createMany({
        data: DEFAULTS.map((d) => ({ ...d, workspaceId: ctx.workspaceId })),
        skipDuplicates: true,
      });
      return ctx.db.projectTemplate.findMany({
        where: { workspaceId: ctx.workspaceId },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      });
    }
    return rows;
  }),

  create: adminProcedure.input(z.object(inputShape)).mutation(async ({ ctx, input }) => {
    const existing = await ctx.db.projectTemplate.findUnique({
      where: { workspaceId_name: { workspaceId: ctx.workspaceId, name: input.name } },
    });
    if (existing) throw new TRPCError({ code: "CONFLICT", message: "Name already used." });
    return ctx.db.projectTemplate.create({
      data: {
        workspaceId: ctx.workspaceId,
        name: input.name,
        suggestedKey: input.suggestedKey,
        description: input.description ?? null,
        color: input.color ?? null,
        icon: input.icon ?? null,
      },
    });
  }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().min(1).max(80).optional(),
        suggestedKey: z
          .string()
          .min(2)
          .max(8)
          .regex(/^[A-Z0-9]+$/)
          .optional(),
        description: z.string().max(4000).nullable().optional(),
        color: hexColor.nullable().optional(),
        icon: z.string().max(8).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const row = await ctx.db.projectTemplate.findFirstOrThrow({
        where: { id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.projectTemplate.update({ where: { id: row.id }, data: patch });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.projectTemplate.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.projectTemplate.delete({ where: { id: row.id } });
    }),
});
