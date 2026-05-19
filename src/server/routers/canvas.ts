import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EventKind, type PrismaClient } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { forgeEntityTypeSchema } from "@/lib/entity-ref";
import { hydrateEntityRefs, type HydratedEntityRef } from "@/server/services/entity-hydration";

/**
 * Workspace canvas router — infinite spatial board for synthesis work.
 * Canvas rows store only layout + entity refs; canonical content is
 * always read from the source row via the entity-hydration service.
 *
 * v0 scope:
 *   - create/list/get/archive a canvas
 *   - addNode / patchNode / removeNode
 *   - addEdge / removeEdge
 *   - hydrateNodes returns the node list with refs resolved via the
 *     shared hydration service so the UI can render cards uniformly
 *
 * Deferred for v1: presence, multi-select, minimap, snap guides,
 * cross-canvas links, history. The plan flags canvas as the most
 * risky surface — keeping mutations narrow to start.
 */

const viewportSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    zoom: z.number().min(0.05).max(8),
  })
  .partial()
  .optional();

const nodeInputSchema = z.object({
  targetType: forgeEntityTypeSchema,
  targetId: z.string().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number().min(40).max(8_000),
  height: z.number().min(40).max(8_000),
  zIndex: z.number().int().optional(),
  collapsed: z.boolean().optional(),
  viewMode: z.string().max(20).nullable().optional(),
});

async function assertCanvasTarget(
  ctx: { db: PrismaClient; workspaceId: string },
  type: z.infer<typeof forgeEntityTypeSchema>,
  id: string,
) {
  const [hydrated] = await hydrateEntityRefs({ db: ctx.db, workspaceId: ctx.workspaceId }, [
    { type, id },
  ]);
  if (!hydrated || hydrated.missing) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${type} target not found in this workspace.`,
    });
  }
}

async function validateCanvasScope(
  ctx: { db: PrismaClient; workspaceId: string },
  scopeType: string | null | undefined,
  scopeId: string | null | undefined,
): Promise<{ scopeType: z.infer<typeof forgeEntityTypeSchema> | null; scopeId: string | null }> {
  if (!scopeType && !scopeId) return { scopeType: null, scopeId: null };
  if (!scopeType || !scopeId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Canvas scopeType and scopeId must be provided together.",
    });
  }
  const parsed = forgeEntityTypeSchema.safeParse(scopeType);
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Canvas scopeType must be a known Forge entity type.",
    });
  }
  await assertCanvasTarget(ctx, parsed.data, scopeId);
  return { scopeType: parsed.data, scopeId };
}

export const canvasRouter = router({
  list: workspaceProcedure
    .input(
      z
        .object({
          scopeType: z.string().max(40).optional(),
          scopeId: z.string().max(40).optional(),
          includeArchived: z.boolean().default(false),
          limit: z.number().int().positive().max(100).default(50),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.workspaceCanvas.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          archivedAt: input.includeArchived ? undefined : null,
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit,
        include: { _count: { select: { nodes: true, edges: true } } },
      });
      return { items: rows };
    }),

  get: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          nodes: { orderBy: { zIndex: "asc" } },
          edges: true,
        },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      return canvas;
    }),

  /**
   * Hydrate the nodes on a canvas to full HydratedEntityRef rows. Returns
   * `{ canvas, nodes }` where each node row carries both the position
   * data and the resolved entity display fields, including a
   * `missing: true` flag for nodes pointing at deleted source entities.
   */
  hydrate: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          nodes: { orderBy: { zIndex: "asc" } },
          edges: true,
        },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      const refs = canvas.nodes.map((n) => ({
        type: n.targetType as never,
        id: n.targetId,
      }));
      const hydrated: HydratedEntityRef[] = await hydrateEntityRefs(
        {
          db: ctx.db,
          workspaceId: ctx.workspaceId,
          workspaceSlug: ctx.workspaceSlug ?? undefined,
        },
        refs,
      );
      const nodes = canvas.nodes.map((node, idx) => ({
        ...node,
        ref: hydrated[idx],
      }));
      return { canvas, nodes, edges: canvas.edges };
    }),

  create: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        scopeType: z.string().max(40).nullable().optional(),
        scopeId: z.string().max(40).nullable().optional(),
        viewport: viewportSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await validateCanvasScope(ctx, input.scopeType, input.scopeId);
      const created = await ctx.db.$transaction(async (tx) => {
        const canvas = await tx.workspaceCanvas.create({
          data: {
            workspaceId: ctx.workspaceId,
            name: input.name.trim(),
            scopeType: scope.scopeType,
            scopeId: scope.scopeId,
            viewport: input.viewport ?? undefined,
            createdById: ctx.session?.user?.id ?? null,
          },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: canvas.id,
          action: "created",
          after: { name: canvas.name },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: canvas.id,
        });
        return canvas;
      });
      return { id: created.id };
    }),

  archive: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      await ctx.db.workspaceCanvas.update({
        where: { id: input.id },
        data: { archivedAt: new Date() },
      });
      return { ok: true };
    }),

  setViewport: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        viewport: viewportSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      await ctx.db.workspaceCanvas.update({
        where: { id: input.id },
        data: { viewport: input.viewport ?? undefined, updatedAt: new Date() },
      });
      return { ok: true };
    }),

  addNode: workspaceProcedure
    .input(z.object({ canvasId: z.string().cuid() }).merge(nodeInputSchema))
    .mutation(async ({ ctx, input }) => {
      await assertCanvasTarget(ctx, input.targetType, input.targetId);
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      const node = await ctx.db.workspaceCanvasNode.create({
        data: {
          workspaceId: ctx.workspaceId,
          canvasId: input.canvasId,
          targetType: input.targetType,
          targetId: input.targetId,
          x: input.x,
          y: input.y,
          width: input.width,
          height: input.height,
          zIndex: input.zIndex ?? 0,
          collapsed: input.collapsed ?? false,
          viewMode: input.viewMode ?? null,
        },
      });
      await ctx.db.workspaceCanvas.update({
        where: { id: input.canvasId },
        data: { updatedAt: new Date() },
      });
      return { id: node.id };
    }),

  patchNode: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().min(40).max(8_000).optional(),
        height: z.number().min(40).max(8_000).optional(),
        zIndex: z.number().int().optional(),
        collapsed: z.boolean().optional(),
        viewMode: z.string().max(20).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const node = await ctx.db.workspaceCanvasNode.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true },
      });
      if (!node) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas node not found." });
      }
      await ctx.db.workspaceCanvasNode.update({
        where: { id: input.id },
        data: {
          x: input.x,
          y: input.y,
          width: input.width,
          height: input.height,
          zIndex: input.zIndex,
          collapsed: input.collapsed,
          viewMode: input.viewMode === undefined ? undefined : input.viewMode,
        },
      });
      await ctx.db.workspaceCanvas.update({
        where: { id: node.canvasId },
        data: { updatedAt: new Date() },
      });
      return { ok: true };
    }),

  removeNode: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const node = await ctx.db.workspaceCanvasNode.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true },
      });
      if (!node) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas node not found." });
      }
      await ctx.db.$transaction([
        ctx.db.workspaceCanvasEdge.deleteMany({
          where: {
            workspaceId: ctx.workspaceId,
            OR: [{ fromNodeId: input.id }, { toNodeId: input.id }],
          },
        }),
        ctx.db.workspaceCanvasNode.delete({ where: { id: input.id } }),
        ctx.db.workspaceCanvas.update({
          where: { id: node.canvasId },
          data: { updatedAt: new Date() },
        }),
      ]);
      return { ok: true };
    }),

  addEdge: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        fromNodeId: z.string().cuid(),
        toNodeId: z.string().cuid(),
        label: z.string().max(200).nullable().optional(),
        kind: z.string().max(40).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [canvas, from, to] = await Promise.all([
        ctx.db.workspaceCanvas.findFirst({
          where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
          select: { id: true },
        }),
        ctx.db.workspaceCanvasNode.findFirst({
          where: { id: input.fromNodeId, canvasId: input.canvasId, workspaceId: ctx.workspaceId },
          select: { id: true },
        }),
        ctx.db.workspaceCanvasNode.findFirst({
          where: { id: input.toNodeId, canvasId: input.canvasId, workspaceId: ctx.workspaceId },
          select: { id: true },
        }),
      ]);
      if (!canvas || !from || !to) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Canvas, fromNode, or toNode missing from this workspace.",
        });
      }
      const edge = await ctx.db.workspaceCanvasEdge.create({
        data: {
          workspaceId: ctx.workspaceId,
          canvasId: input.canvasId,
          fromNodeId: input.fromNodeId,
          toNodeId: input.toNodeId,
          label: input.label ?? null,
          kind: input.kind ?? null,
        },
      });
      return { id: edge.id };
    }),

  removeEdge: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const edge = await ctx.db.workspaceCanvasEdge.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!edge) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas edge not found." });
      }
      await ctx.db.workspaceCanvasEdge.delete({ where: { id: input.id } });
      return { ok: true };
    }),
});
