import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EventKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import {
  CONTEXT_SET_INCLUDE_MODES,
  addContextSetItem,
  createContextSet,
  hydrateContextSet,
  removeContextSetItem,
  type ContextSetIncludeMode,
} from "@/server/services/context-set-service";
import { forgeEntityTypeSchema } from "@/lib/entity-ref";

const includeModeSchema = z.enum(CONTEXT_SET_INCLUDE_MODES);

const itemInputSchema = z.object({
  targetType: forgeEntityTypeSchema,
  targetId: z.string().min(1),
  includeMode: includeModeSchema.default("INCLUDE"),
  note: z.string().max(1_000).nullable().optional(),
});

export const contextSetRouter = router({
  /** List context sets in this workspace. */
  list: workspaceProcedure
    .input(
      z
        .object({
          includeArchived: z.boolean().default(false),
          ownerUserId: z.string().cuid().optional(),
          limit: z.number().int().positive().max(100).default(50),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.contextSet.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: input.includeArchived ? undefined : null,
          ownerUserId: input.ownerUserId,
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit,
        include: { _count: { select: { items: true } } },
      });
      return { items: rows };
    }),

  /** Fetch + hydrate one context set with its items resolved to display refs. */
  get: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const result = await hydrateContextSet(ctx.db, {
        workspaceId: ctx.workspaceId,
        contextSetId: input.id,
        workspaceSlug: ctx.workspaceSlug ?? undefined,
      });
      if (!result) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Context set not found." });
      }
      return result;
    }),

  /** Create a context set, optionally seeding initial items. */
  create: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(2_000).nullable().optional(),
        items: z.array(itemInputSchema).max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await createContextSet(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        name: input.name,
        description: input.description ?? null,
        items: input.items?.map((it) => ({
          targetType: it.targetType,
          targetId: it.targetId,
          includeMode: it.includeMode as ContextSetIncludeMode,
          note: it.note ?? null,
        })),
      });
      return result;
    }),

  /** Update head metadata (name/description). Items use addItem/removeItem. */
  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2_000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const set = await ctx.db.contextSet.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true, name: true },
      });
      if (!set) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Context set not found." });
      }
      await ctx.db.$transaction(async (tx) => {
        await tx.contextSet.update({
          where: { id: input.id },
          data: {
            name: input.name?.trim() ?? undefined,
            description: input.description === undefined ? undefined : input.description,
          },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "context-set",
          entityId: input.id,
          action: "updated",
          before: { name: set.name },
          after: { name: input.name ?? set.name },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "context-set",
          subjectId: input.id,
        });
      });
      return { ok: true };
    }),

  /** Archive a context set. */
  archive: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const set = await ctx.db.contextSet.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, archivedAt: true },
      });
      if (!set) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Context set not found." });
      }
      if (set.archivedAt) return { ok: true };
      await ctx.db.$transaction(async (tx) => {
        await tx.contextSet.update({
          where: { id: input.id },
          data: { archivedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "context-set",
          entityId: input.id,
          action: "archived",
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "context-set",
          subjectId: input.id,
        });
      });
      return { ok: true };
    }),

  addItem: workspaceProcedure
    .input(
      z.object({
        contextSetId: z.string().cuid(),
        targetType: forgeEntityTypeSchema,
        targetId: z.string().min(1),
        includeMode: includeModeSchema.default("INCLUDE"),
        note: z.string().max(1_000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await addContextSetItem(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        contextSetId: input.contextSetId,
        targetType: input.targetType,
        targetId: input.targetId,
        includeMode: input.includeMode as ContextSetIncludeMode,
        note: input.note ?? null,
      });
      return result;
    }),

  removeItem: workspaceProcedure
    .input(
      z.object({
        contextSetId: z.string().cuid(),
        itemId: z.string().cuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await removeContextSetItem(ctx.db, {
        workspaceId: ctx.workspaceId,
        contextSetId: input.contextSetId,
        itemId: input.itemId,
      });
      return { ok: true };
    }),

  /**
   * Update the includeMode/note on a single item. Position changes live
   * under a separate `reorder` route to keep the mutation surface narrow.
   */
  patchItem: workspaceProcedure
    .input(
      z.object({
        contextSetId: z.string().cuid(),
        itemId: z.string().cuid(),
        includeMode: includeModeSchema.optional(),
        note: z.string().max(1_000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const item = await ctx.db.contextSetItem.findFirst({
        where: {
          id: input.itemId,
          contextSetId: input.contextSetId,
          workspaceId: ctx.workspaceId,
        },
        select: { id: true },
      });
      if (!item) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Context set item not found." });
      }
      await ctx.db.contextSetItem.update({
        where: { id: item.id },
        data: {
          includeMode: input.includeMode === undefined ? undefined : input.includeMode,
          note: input.note === undefined ? undefined : input.note,
        },
      });
      await ctx.db.contextSet.update({
        where: { id: input.contextSetId },
        data: { updatedAt: new Date() },
      });
      return { ok: true };
    }),
});
