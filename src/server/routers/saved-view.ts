import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { SavedViewFiltersSchema } from "@/lib/saved-view-filters";

/**
 * Per-user saved views for the issue list — distinct from the legacy
 * `view` router (which mixes workspace-shared and per-user `SavedView`
 * rows). The `filters` payload is validated against
 * `SavedViewFiltersSchema` (Phase 1D) so malformed blobs from a stale
 * client are rejected at the boundary; we still store as `Prisma.Json`
 * so future shape additions don't require a migration.
 *
 * No audit / activity logging — these are personal config (think IDE
 * tabs), not workspace-visible state changes.
 *
 * Tenant + user scoped: a user can only see/mutate their own rows in
 * the current workspace. Cross-workspace bleed is impossible because
 * every query also filters on `workspaceId = ctx.workspaceId`.
 */

const filtersSchema = SavedViewFiltersSchema;
const sortKeySchema = z.string().max(80).nullable().optional();

export const savedViewRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    return ctx.db.issueSavedView.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
      },
      orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
    });
  }),

  create: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        filters: filtersSchema,
        sortKey: sortKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      // Append to the end of the user's list. Stable across reorders.
      const last = await ctx.db.issueSavedView.findFirst({
        where: { workspaceId: ctx.workspaceId, userId },
        orderBy: { orderIndex: "desc" },
        select: { orderIndex: true },
      });
      try {
        const row = await ctx.db.issueSavedView.create({
          data: {
            workspaceId: ctx.workspaceId,
            userId,
            name: input.name,
            filters: (input.filters ?? {}) as Prisma.InputJsonValue,
            sortKey: input.sortKey ?? null,
            orderIndex: (last?.orderIndex ?? -1) + 1,
          },
          select: { id: true },
        });
        return row;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `A saved view named "${input.name}" already exists.`,
          });
        }
        throw err;
      }
    }),

  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().min(1).max(80).optional(),
        filters: filtersSchema.optional(),
        sortKey: sortKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const owned = await ctx.db.issueSavedView.findFirst({
        where: {
          id,
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
        },
        select: { id: true },
      });
      if (!owned) throw new TRPCError({ code: "NOT_FOUND" });
      const data: Prisma.IssueSavedViewUpdateInput = {};
      if (patch.name !== undefined) data.name = patch.name;
      if (patch.filters !== undefined) {
        data.filters = (patch.filters ?? {}) as Prisma.InputJsonValue;
      }
      if (patch.sortKey !== undefined) data.sortKey = patch.sortKey ?? null;
      try {
        return await ctx.db.issueSavedView.update({
          where: { id: owned.id },
          data,
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `A saved view named "${patch.name ?? ""}" already exists.`,
          });
        }
        throw err;
      }
    }),

  delete: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const owned = await ctx.db.issueSavedView.findFirst({
        where: {
          id: input.id,
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
        },
        select: { id: true },
      });
      if (!owned) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.db.issueSavedView.delete({ where: { id: owned.id } });
      return { ok: true };
    }),

  reorder: workspaceProcedure
    .input(
      z.object({
        ids: z.array(z.string().cuid()).min(1).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      // Validate every id belongs to this user + workspace before mutating.
      const found = await ctx.db.issueSavedView.findMany({
        where: {
          id: { in: input.ids },
          workspaceId: ctx.workspaceId,
          userId,
        },
        select: { id: true },
      });
      if (found.length !== input.ids.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "One or more saved views were not found for this user.",
        });
      }
      await ctx.db.$transaction(
        input.ids.map((id, i) =>
          ctx.db.issueSavedView.update({
            where: { id },
            data: { orderIndex: i },
          }),
        ),
      );
      return { ok: true, count: input.ids.length };
    }),
});
