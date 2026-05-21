import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  ArtifactType,
  EventKind,
  ExecutionPlanStatus,
  Prisma,
  type CanvasStyleKind,
  type PrismaClient,
} from "@prisma/client";
import { nanoid } from "nanoid";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { forgeEntityTypeSchema } from "@/lib/entity-ref";
import { hydrateEntityRefs, type HydratedEntityRef } from "@/server/services/entity-hydration";
import { createArtifact } from "@/server/services/artifact-service";
import { publish } from "@/server/realtime";
import { computeAlignment, type AlignItem } from "@/server/services/canvas-alignment";
import { refreshTodayZone } from "@/server/services/today-zone";
import { presignDownloadUrl } from "@/server/services/storage";

// ---------------------------------------------------------------------------
// Schemas shared between proc inputs (styles / components / layers)
// ---------------------------------------------------------------------------

const styleKindSchema = z.enum(["COLOR", "TEXT", "EFFECT"]);

const componentDefinitionSchema = z
  .object({
    nodes: z.array(z.unknown()).default([]),
    shapes: z.array(z.unknown()).default([]),
    frames: z.array(z.unknown()).default([]),
    edges: z.array(z.unknown()).default([]),
    width: z.number().min(1).max(20_000),
    height: z.number().min(1).max(20_000),
  })
  .passthrough();

type ComponentDefinition = z.infer<typeof componentDefinitionSchema>;

const layerKindAllSchema = z.enum(["node", "shape", "frame", "group", "instance"]);
const layerKindNameableSchema = z.enum(["frame", "group", "component"]);
const layerKindReorderItemSchema = z.object({
  kind: layerKindAllSchema,
  id: z.string().cuid(),
});

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
          shapes: { orderBy: { zIndex: "asc" } },
        },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      return canvas;
    }),

  /**
   * Return (auto-provisioning if needed) the caller's PERSONAL canvas
   * for the active workspace. The unique key on
   * (workspaceId, kind, ownerUserId) enforces one PERSONAL per user.
   * Cheap to call on every dashboard / topbar mount; the create branch
   * only fires once per user. Today-zone refresh runs lazily via
   * `canvas.hydrate` so the open-canvas path stays current.
   */
  personalForViewer: workspaceProcedure.query(async ({ ctx }) => {
    const existing = await ctx.db.workspaceCanvas.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        kind: "PERSONAL",
        ownerUserId: ctx.session?.user?.id ?? "",
        archivedAt: null,
      },
      select: { id: true, name: true, kind: true, activePageId: true },
    });
    if (existing) return existing;
    if (!ctx.session?.user?.id) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in required." });
    }
    const me = await ctx.db.user.findUniqueOrThrow({
      where: { id: ctx.session.user.id },
      select: { name: true, email: true },
    });
    const label = me.name?.trim() || me.email.split("@")[0] || "Personal";
    return ctx.db.workspaceCanvas.create({
      data: {
        workspaceId: ctx.workspaceId,
        kind: "PERSONAL",
        ownerUserId: ctx.session.user.id,
        createdById: ctx.session.user.id,
        name: `${label}'s workspace`,
      },
      select: { id: true, name: true, kind: true, activePageId: true },
    });
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
      const head = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, kind: true, ownerUserId: true, archivedAt: true },
      });
      if (!head) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      // PERSONAL canvases run their Today-zone refresh before hydrate so
      // the strip reflects the caller's current work every time they
      // open the surface. Idempotent + cheap (single-digit writes).
      if (
        head.kind === "PERSONAL" &&
        head.ownerUserId === ctx.session?.user?.id &&
        !head.archivedAt
      ) {
        try {
          await refreshTodayZone(
            ctx.db as PrismaClient,
            ctx.workspaceId,
            ctx.session.user.id,
            head.id,
          );
        } catch {
          // Today zone is decorative — failure must not block hydrate.
        }
      }
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          nodes: { orderBy: { zIndex: "asc" } },
          edges: true,
          shapes: { orderBy: { zIndex: "asc" } },
          frames: { orderBy: { z: "asc" } },
          groups: { orderBy: { z: "asc" } },
          componentInstances: { orderBy: { z: "asc" } },
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
          userId: ctx.session?.user?.id ?? null,
        },
        refs,
      );
      const nodes = canvas.nodes.map((node, idx) => ({
        ...node,
        ref: hydrated[idx],
      }));
      // Image shapes store an attachmentId in their style JSON; resolve it to
      // a fresh presigned GET so the client can render <image href>. The URL
      // is short-lived (15 min) and refreshes on the next hydrate.
      const shapes = await Promise.all(
        canvas.shapes.map(async (shape) => {
          if (shape.kind !== "image") return shape;
          const style = (shape.style ?? {}) as Record<string, unknown>;
          const attachmentId = style.attachmentId;
          if (typeof attachmentId !== "string") return shape;
          try {
            const { url } = await presignDownloadUrl(attachmentId);
            return { ...shape, style: { ...style, src: url } };
          } catch {
            return shape;
          }
        }),
      );
      return {
        canvas,
        nodes,
        edges: canvas.edges,
        shapes,
        frames: canvas.frames,
        groups: canvas.groups,
        componentInstances: canvas.componentInstances,
      };
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

  delete: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        confirm: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (
        ctx.membership.role !== "OWNER" &&
        ctx.membership.role !== "ADMIN"
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Admin role required to hard-delete a canvas.",
        });
      }
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, name: true },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      if (input.confirm !== canvas.name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Confirmation text does not match the canvas name.",
        });
      }
      await ctx.db.$transaction(async (tx) => {
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: canvas.id,
          action: "delete",
          before: { name: canvas.name },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: canvas.id,
        });
        // Nodes, edges, shapes cascade-delete from WorkspaceCanvas via the
        // schema's onDelete: Cascade — a single delete covers them all.
        await tx.workspaceCanvas.delete({ where: { id: canvas.id } });
      });
      return { ok: true };
    }),

  rename: workspaceProcedure
    .input(z.object({ id: z.string().cuid(), name: z.string().min(1).max(200) }))
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
        data: { name: input.name.trim(), updatedAt: new Date() },
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
        /**
         * Style references — opaque map of
         * `{ fill?: styleId, text?: styleId, effect?: styleId }`.
         * Pass `null` to clear. Replaces the whole object on write —
         * partial-update callers should read first and send a merged
         * object.
         */
        styleRefs: z.record(z.unknown()).nullable().optional(),
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
      const data: Prisma.WorkspaceCanvasNodeUpdateInput = {
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        zIndex: input.zIndex,
        collapsed: input.collapsed,
        viewMode: input.viewMode === undefined ? undefined : input.viewMode,
      };
      if (input.styleRefs !== undefined) {
        data.styleRefs =
          input.styleRefs === null
            ? Prisma.JsonNull
            : (input.styleRefs as Prisma.InputJsonValue);
      }
      await ctx.db.workspaceCanvasNode.update({
        where: { id: input.id },
        data,
      });
      await ctx.db.workspaceCanvas.update({
        where: { id: node.canvasId },
        data: { updatedAt: new Date() },
      });
      return { ok: true };
    }),

  /**
   * Shallow-merge update for `WorkspaceCanvasNode.meta`. Lets the UI
   * stamp lane / kind / arbitrary card-state on a node without
   * needing a dedicated column per field. Pass `null` for a key to
   * delete it from the stored meta object.
   *
   * Returns the merged meta so the caller can reconcile its
   * optimistic local state against the canonical row.
   */
  patchNodeMeta: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        meta: z.record(z.unknown()).describe(
          "Object of meta keys to merge. Keys with value=null are deleted from the stored meta object.",
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const node = await ctx.db.workspaceCanvasNode.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true, meta: true },
      });
      if (!node) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas node not found." });
      }
      const current =
        node.meta && typeof node.meta === "object" && !Array.isArray(node.meta)
          ? (node.meta as Record<string, unknown>)
          : {};
      const next: Record<string, unknown> = { ...current };
      for (const [k, v] of Object.entries(input.meta)) {
        if (v === null) {
          delete next[k];
        } else {
          next[k] = v;
        }
      }
      await ctx.db.workspaceCanvasNode.update({
        where: { id: input.id },
        data: { meta: next as Prisma.InputJsonValue },
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

  /**
   * Add a drawing primitive (box / ellipse / line / arrow / text /
   * freehand) to a canvas. Shapes don't reference Forge entities —
   * they're pure visual annotations.
   */
  shapeAdd: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        kind: z.enum([
          "box",
          "ellipse",
          "diamond",
          "line",
          "arrow",
          "text",
          "freehand",
          "sticky",
          "comment-pin",
          "stamp",
          "image",
        ]),
        x: z.number(),
        y: z.number(),
        width: z.number().optional(),
        height: z.number().optional(),
        path: z.unknown().optional(),
        style: z.unknown().optional(),
        text: z.string().max(50_000).optional(),
        groupId: z.string().max(80).optional(),
        zIndex: z.number().int().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      const shape = await ctx.db.$transaction(async (tx) => {
        const created = await tx.canvasShape.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            kind: input.kind,
            x: input.x,
            y: input.y,
            width: input.width ?? null,
            height: input.height ?? null,
            path: (input.path ?? undefined) as Prisma.InputJsonValue | undefined,
            style: (input.style ?? undefined) as Prisma.InputJsonValue | undefined,
            text: input.text ?? null,
            groupId: input.groupId ?? null,
            zIndex: input.zIndex ?? 0,
            createdById: ctx.session?.user?.id ?? null,
          },
        });
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "shape_added",
          after: { shapeId: created.id, kind: created.kind },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return created;
      });
      return { id: shape.id };
    }),

  /**
   * Patch fields on a single shape. Pass `null` to clear an optional
   * field (width/height/path/style/text/groupId). Style is REPLACED,
   * not merged — callers that want a partial style update should
   * read first then send the full object.
   */
  shapePatch: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().nullable().optional(),
        height: z.number().nullable().optional(),
        path: z.unknown().optional(),
        style: z.unknown().optional(),
        text: z.string().max(50_000).nullable().optional(),
        groupId: z.string().max(80).nullable().optional(),
        zIndex: z.number().int().optional(),
        /**
         * Style references — `{ fill?: styleId, text?: styleId,
         * effect?: styleId }`. Pass `null` to clear.
         */
        styleRefs: z.record(z.unknown()).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const shape = await ctx.db.canvasShape.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true },
      });
      if (!shape) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas shape not found." });
      }
      const data: Prisma.CanvasShapeUpdateInput = {};
      if (input.x !== undefined) data.x = input.x;
      if (input.y !== undefined) data.y = input.y;
      if (input.width !== undefined) data.width = input.width;
      if (input.height !== undefined) data.height = input.height;
      if (input.path !== undefined) {
        data.path =
          input.path === null
            ? Prisma.JsonNull
            : (input.path as Prisma.InputJsonValue);
      }
      if (input.style !== undefined) {
        data.style =
          input.style === null
            ? Prisma.JsonNull
            : (input.style as Prisma.InputJsonValue);
      }
      if (input.text !== undefined) data.text = input.text;
      if (input.groupId !== undefined) data.groupId = input.groupId;
      if (input.zIndex !== undefined) data.zIndex = input.zIndex;
      if (input.styleRefs !== undefined) {
        data.styleRefs =
          input.styleRefs === null
            ? Prisma.JsonNull
            : (input.styleRefs as Prisma.InputJsonValue);
      }

      await ctx.db.$transaction(async (tx) => {
        await tx.canvasShape.update({ where: { id: input.id }, data });
        await tx.workspaceCanvas.update({
          where: { id: shape.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: shape.canvasId,
          action: "shape_updated",
          after: { shapeId: input.id },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: shape.canvasId,
        });
      });
      return { ok: true as const };
    }),

  shapeRemove: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const shape = await ctx.db.canvasShape.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true },
      });
      if (!shape) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas shape not found." });
      }
      await ctx.db.$transaction(async (tx) => {
        await tx.canvasShape.delete({ where: { id: input.id } });
        await tx.workspaceCanvas.update({
          where: { id: shape.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: shape.canvasId,
          action: "shape_removed",
          before: { shapeId: input.id },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: shape.canvasId,
        });
      });
      return { ok: true as const };
    }),

  /**
   * Apply the same change to many shapes at once. Use `dxdy` to
   * translate (additive), `style` to REPLACE the style object on every
   * matched row, and `groupId` to set/clear group membership (string
   * sets, null clears, undefined leaves untouched). All matched shapes
   * must belong to the caller's workspace.
   */
  shapeBulkPatch: workspaceProcedure
    .input(
      z.object({
        ids: z.array(z.string().cuid()).min(1).max(200),
        style: z.unknown().optional(),
        groupId: z.string().max(80).nullable().optional(),
        dxdy: z
          .object({ dx: z.number(), dy: z.number() })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const shapes = await ctx.db.canvasShape.findMany({
        where: { id: { in: input.ids }, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true, x: true, y: true },
      });
      if (shapes.length === 0) {
        return { ok: true as const, count: 0 };
      }
      const canvasIds = new Set(shapes.map((s) => s.canvasId));
      const styleSet = input.style !== undefined;
      const groupSet = input.groupId !== undefined;
      const translate = input.dxdy;
      await ctx.db.$transaction(async (tx) => {
        for (const s of shapes) {
          const data: Prisma.CanvasShapeUpdateInput = {};
          if (translate) {
            data.x = s.x + translate.dx;
            data.y = s.y + translate.dy;
          }
          if (styleSet) {
            data.style =
              input.style === null
                ? Prisma.JsonNull
                : (input.style as Prisma.InputJsonValue);
          }
          if (groupSet) {
            data.groupId = input.groupId ?? null;
          }
          await tx.canvasShape.update({ where: { id: s.id }, data });
        }
        for (const canvasId of canvasIds) {
          await tx.workspaceCanvas.update({
            where: { id: canvasId },
            data: { updatedAt: new Date() },
          });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session?.user?.id ?? null,
            entity: "workspace-canvas",
            entityId: canvasId,
            action: "shapes_bulk_updated",
            after: { count: shapes.filter((s) => s.canvasId === canvasId).length },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "workspace-canvas",
            subjectId: canvasId,
          });
        }
      });
      return { ok: true as const, count: shapes.length };
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

  /**
   * Patch a single canvas edge's label / kind / meta. Symmetric with
   * `shapePatch`: passing `null` clears the column; omitting a field
   * leaves it alone. `meta` is REPLACED on write — callers that want
   * to merge should read first and send the full object.
   */
  edgePatch: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        label: z.string().max(200).nullable().optional(),
        kind: z.string().max(40).nullable().optional(),
        meta: z.unknown().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const edge = await ctx.db.workspaceCanvasEdge.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true },
      });
      if (!edge) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas edge not found." });
      }
      const data: Prisma.WorkspaceCanvasEdgeUpdateInput = {};
      if (input.label !== undefined) data.label = input.label;
      if (input.kind !== undefined) data.kind = input.kind;
      if (input.meta !== undefined) {
        data.meta =
          input.meta === null
            ? Prisma.JsonNull
            : (input.meta as Prisma.InputJsonValue);
      }
      await ctx.db.$transaction(async (tx) => {
        await tx.workspaceCanvasEdge.update({ where: { id: input.id }, data });
        await tx.workspaceCanvas.update({
          where: { id: edge.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: edge.canvasId,
          action: "edge_updated",
          after: { edgeId: input.id },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: edge.canvasId,
        });
      });
      return { ok: true as const };
    }),

  /**
   * Spawn a markdown sticky-note Artifact (kind=NOTE) AND a canvas
   * node pointing at it in one call. Notes live in the standard
   * Artifact table so they're searchable, attachable, and linkable
   * like any other artifact — the canvas surface is just one way of
   * arranging them in space.
   */
  addNote: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        body: z.string().max(200_000).default(""),
        x: z.number(),
        y: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }

      const trimmedBody = input.body.trim();
      const firstLine = trimmedBody.split(/\r?\n/)[0]?.trim() ?? "";
      const title = firstLine.length
        ? firstLine.slice(0, 180)
        : `Note ${new Date().toISOString().slice(0, 10)}`;

      const { id: artifactId } = await createArtifact(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        title,
        body: input.body,
        type: ArtifactType.NOTE,
      });

      const node = await ctx.db.workspaceCanvasNode.create({
        data: {
          workspaceId: ctx.workspaceId,
          canvasId: input.canvasId,
          targetType: "artifact",
          targetId: artifactId,
          x: input.x,
          y: input.y,
          width: 240,
          height: 160,
          zIndex: 0,
          viewMode: "card",
          meta: { kind: "NOTE" },
        },
      });
      await ctx.db.workspaceCanvas.update({
        where: { id: input.canvasId },
        data: { updatedAt: new Date() },
      });
      return { nodeId: node.id, artifactId };
    }),

  /**
   * Drop an existing ChatThread onto the canvas. Verifies the calling
   * user owns the thread (same visibility rule as `chat.getThread`)
   * before creating the canvas node.
   */
  addChatThread: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        threadId: z.string().cuid(),
        x: z.number(),
        y: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [canvas, thread] = await Promise.all([
        ctx.db.workspaceCanvas.findFirst({
          where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
          select: { id: true },
        }),
        ctx.db.chatThread.findFirst({
          where: {
            id: input.threadId,
            workspaceId: ctx.workspaceId,
            userId: ctx.session?.user?.id ?? "__none__",
          },
          select: { id: true },
        }),
      ]);
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      if (!thread) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Chat thread not found or not visible to caller.",
        });
      }
      const node = await ctx.db.workspaceCanvasNode.create({
        data: {
          workspaceId: ctx.workspaceId,
          canvasId: input.canvasId,
          targetType: "chat-thread",
          targetId: input.threadId,
          x: input.x,
          y: input.y,
          width: 280,
          height: 200,
          zIndex: 0,
          viewMode: "card",
        },
      });
      await ctx.db.workspaceCanvas.update({
        where: { id: input.canvasId },
        data: { updatedAt: new Date() },
      });
      return { nodeId: node.id };
    }),

  /**
   * Reverse of `createFromPlan`. Walks the canvas and synthesizes a
   * new DRAFT ExecutionPlan whose steps come from (a) existing
   * `execution-step` nodes (linked, not duplicated as new rows — see
   * note below) and (b) Note artifacts whose first line becomes the
   * step title. depends_on edges on the canvas map to ExecutionStep
   * `dependsOnStepIds`. Other targetTypes are surfaced in
   * `skippedNodes`.
   *
   * Existing `execution-step` nodes: we COPY them into the new plan as
   * fresh ExecutionStep rows (one row per plan; can't re-parent a step
   * across plans without breaking the @@unique([planId, position])
   * invariant). The original steps stay where they were — this is a
   * "extract a new plan from these ideas" tool, not a step migration.
   */
  convertToPlan: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        title: z.string().min(1).max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        include: {
          nodes: true,
          edges: true,
        },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }

      const skippedNodes: Array<{ nodeId: string; reason: string }> = [];

      // Sort nodes top-left → bottom-right for positional ordering.
      const sortedNodes = [...canvas.nodes].sort((a, b) => {
        if (a.y !== b.y) return a.y - b.y;
        return a.x - b.x;
      });

      // Identify the artifact NOTE rows (need to read their bodies).
      const artifactNodes = sortedNodes.filter((n) => n.targetType === "artifact");
      const artifactIds = artifactNodes.map((n) => n.targetId);
      const artifactRows = artifactIds.length
        ? await ctx.db.artifact.findMany({
            where: {
              id: { in: artifactIds },
              workspaceId: ctx.workspaceId,
              archivedAt: null,
            },
            select: { id: true, title: true, body: true, type: true },
          })
        : [];
      const artifactById = new Map(artifactRows.map((a) => [a.id, a] as const));

      const existingStepIds = sortedNodes
        .filter((n) => n.targetType === "execution-step")
        .map((n) => n.targetId);
      const existingStepRows = existingStepIds.length
        ? await ctx.db.executionStep.findMany({
            where: {
              id: { in: existingStepIds },
              workspaceId: ctx.workspaceId,
            },
            select: {
              id: true,
              title: true,
              body: true,
              expectedOutput: true,
            },
          })
        : [];
      const existingStepById = new Map(existingStepRows.map((s) => [s.id, s] as const));

      // Walk the sorted nodes in order, deciding includes/skips. Each
      // included node gets a placeholder step descriptor keyed by the
      // canvasNodeId so we can resolve depends_on later.
      interface PendingStep {
        canvasNodeId: string;
        title: string;
        body: string | null;
        expectedOutput: string | null;
      }
      const pending: PendingStep[] = [];

      for (const node of sortedNodes) {
        if (node.targetType === "execution-step") {
          const row = existingStepById.get(node.targetId);
          if (!row) {
            skippedNodes.push({
              nodeId: node.id,
              reason: "execution-step target not found in this workspace",
            });
            continue;
          }
          pending.push({
            canvasNodeId: node.id,
            title: row.title,
            body: row.body ?? null,
            expectedOutput: row.expectedOutput ?? null,
          });
          continue;
        }
        if (node.targetType === "artifact") {
          const artifact = artifactById.get(node.targetId);
          if (!artifact) {
            skippedNodes.push({
              nodeId: node.id,
              reason: "artifact target not found in this workspace",
            });
            continue;
          }
          const isNote =
            artifact.type === ArtifactType.NOTE ||
            (node.meta && typeof node.meta === "object" && (node.meta as { kind?: unknown }).kind === "NOTE");
          if (!isNote) {
            skippedNodes.push({
              nodeId: node.id,
              reason: `artifact target kind ${artifact.type} is not NOTE`,
            });
            continue;
          }
          const trimmed = (artifact.body ?? "").trim();
          const lines = trimmed.length ? trimmed.split(/\r?\n/) : [];
          const firstLine = lines[0]?.trim() ?? "";
          const rest = lines.slice(1).join("\n").trim();
          const title = firstLine.length ? firstLine.slice(0, 280) : artifact.title;
          const body = rest.length ? rest : null;
          pending.push({
            canvasNodeId: node.id,
            title: title || "Untitled step",
            body,
            expectedOutput: null,
          });
          continue;
        }
        skippedNodes.push({
          nodeId: node.id,
          reason: `targetType ${node.targetType} is not convertible (only execution-step and artifact NOTE)`,
        });
      }

      const includedCanvasNodeIds = new Set(pending.map((p) => p.canvasNodeId));
      const dependsByTo = new Map<string, string[]>();
      for (const edge of canvas.edges) {
        if (edge.kind !== "depends_on") continue;
        if (!includedCanvasNodeIds.has(edge.fromNodeId)) continue;
        if (!includedCanvasNodeIds.has(edge.toNodeId)) continue;
        const list = dependsByTo.get(edge.toNodeId) ?? [];
        list.push(edge.fromNodeId);
        dependsByTo.set(edge.toNodeId, list);
      }

      const planTitle = (input.title ?? canvas.name).trim() || canvas.name;
      const today = new Date().toISOString().slice(0, 10);
      const planDescription = `Imported from canvas '${canvas.name}' on ${today}.`;

      const result = await ctx.db.$transaction(async (tx) => {
        const plan = await tx.executionPlan.create({
          data: {
            workspaceId: ctx.workspaceId,
            title: planTitle,
            description: planDescription,
            status: ExecutionPlanStatus.DRAFT,
            createdById: ctx.session?.user?.id ?? null,
            createdByAgentId: ctx.apiKey?.linkedAgentId ?? null,
          },
        });

        const canvasNodeIdToStepId = new Map<string, string>();
        for (let i = 0; i < pending.length; i++) {
          const p = pending[i]!;
          const step = await tx.executionStep.create({
            data: {
              workspaceId: ctx.workspaceId,
              planId: plan.id,
              title: p.title.trim() || "Untitled step",
              body: p.body,
              expectedOutput: p.expectedOutput,
              position: i,
              dependsOnStepIds: [],
            },
            select: { id: true },
          });
          canvasNodeIdToStepId.set(p.canvasNodeId, step.id);
        }

        // Second pass: resolve depends_on edges to real step ids.
        for (const p of pending) {
          const deps = dependsByTo.get(p.canvasNodeId);
          if (!deps || deps.length === 0) continue;
          const realIds = deps
            .map((nodeId) => canvasNodeIdToStepId.get(nodeId))
            .filter((id): id is string => Boolean(id));
          if (realIds.length === 0) continue;
          const stepId = canvasNodeIdToStepId.get(p.canvasNodeId)!;
          await tx.executionStep.update({
            where: { id: stepId },
            data: { dependsOnStepIds: realIds },
          });
        }

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "execution-plan",
          entityId: plan.id,
          action: "created",
          after: {
            title: plan.title,
            status: plan.status,
            stepCount: pending.length,
            sourceCanvasId: canvas.id,
          },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "execution-plan",
          subjectId: plan.id,
        });

        return { planId: plan.id, stepCount: pending.length };
      });

      return {
        planId: result.planId,
        stepCount: result.stepCount,
        skippedNodes,
      };
    }),

  /**
   * Bulk-add drawing primitives to a canvas. One transaction, one audit
   * row — the agent-driven "drop a 4-quadrant retro" pattern doesn't
   * need N webhook fan-outs. Caller passes pre-validated shape inputs
   * shaped like `shapeAdd` payloads; we mirror the same defaults.
   */
  bulkAddShapes: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        shapes: z
          .array(
            z.object({
              kind: z.enum([
                "box",
                "ellipse",
                "line",
                "arrow",
                "text",
                "freehand",
                "sticky",
                "comment-pin",
                "stamp",
              ]),
              x: z.number(),
              y: z.number(),
              width: z.number().optional(),
              height: z.number().optional(),
              path: z.unknown().optional(),
              style: z.unknown().optional(),
              text: z.string().max(50_000).optional(),
              groupId: z.string().max(80).optional(),
              zIndex: z.number().int().optional(),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      const ids = await ctx.db.$transaction(async (tx) => {
        const created: string[] = [];
        for (const s of input.shapes) {
          const row = await tx.canvasShape.create({
            data: {
              workspaceId: ctx.workspaceId,
              canvasId: input.canvasId,
              kind: s.kind,
              x: s.x,
              y: s.y,
              width: s.width ?? null,
              height: s.height ?? null,
              path: (s.path ?? undefined) as Prisma.InputJsonValue | undefined,
              style: (s.style ?? undefined) as Prisma.InputJsonValue | undefined,
              text: s.text ?? null,
              groupId: s.groupId ?? null,
              zIndex: s.zIndex ?? 0,
              createdById: ctx.session?.user?.id ?? null,
            },
            select: { id: true },
          });
          created.push(row.id);
        }
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "shapes_bulk_added",
          after: { count: created.length, ids: created },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return created;
      });
      return { ok: true as const, ids };
    }),

  /**
   * Drop a named template onto a canvas. Mirrors the client-side
   * `CANVAS_TEMPLATES` layouts so the agent can build a retro /
   * decision-matrix / OKR tree in one call. Notes become artifact-backed
   * nodes (same as `addNote`); inter-node edges piggyback on the existing
   * `addEdge` shape.
   */
  applyTemplate: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        templateId: z.enum([
          "decision_matrix",
          "retro",
          "architecture",
          "standup",
          "okr_tree",
          "empty",
        ]),
        position: z
          .object({ x: z.number(), y: z.number() })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      const template = SERVER_CANVAS_TEMPLATES[input.templateId];
      if (!template) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown template id." });
      }
      const offsetX = input.position?.x ?? 0;
      const offsetY = input.position?.y ?? 0;
      const userId = ctx.session?.user?.id ?? null;
      const actorAgentId = ctx.apiKey?.linkedAgentId ?? null;

      // createArtifact takes a PrismaClient, not a TransactionClient, so
      // we materialise notes first (matches the addNote pattern). Each
      // call is independent and idempotent on slug collision.
      const noteArtifactByKey = new Map<string, string>();
      for (const n of template.nodes) {
        const trimmedBody = (n.noteBody ?? "").trim();
        const firstLine = trimmedBody.split(/\r?\n/)[0]?.trim() ?? "";
        const title = firstLine.length
          ? firstLine.slice(0, 180)
          : `Note ${new Date().toISOString().slice(0, 10)}`;
        const artifact = await createArtifact(ctx.db, {
          workspaceId: ctx.workspaceId,
          actorId: userId,
          actorAgentId,
          title,
          body: n.noteBody ?? "",
          type: ArtifactType.NOTE,
        });
        noteArtifactByKey.set(n.key, artifact.id);
      }

      const ids = await ctx.db.$transaction(async (tx) => {
        const created: string[] = [];
        const keyToNodeId = new Map<string, string>();

        for (const n of template.nodes) {
          const artifactId = noteArtifactByKey.get(n.key)!;
          const node = await tx.workspaceCanvasNode.create({
            data: {
              workspaceId: ctx.workspaceId,
              canvasId: input.canvasId,
              targetType: "artifact",
              targetId: artifactId,
              x: n.x + offsetX,
              y: n.y + offsetY,
              width: n.width ?? 240,
              height: n.height ?? 160,
              zIndex: 0,
              viewMode: "card",
              meta: { kind: "NOTE", ...(n.lane ? { lane: n.lane } : {}) },
            },
            select: { id: true },
          });
          created.push(node.id);
          keyToNodeId.set(n.key, node.id);
        }
        for (const e of template.edges ?? []) {
          const fromId = keyToNodeId.get(e.from);
          const toId = keyToNodeId.get(e.to);
          if (!fromId || !toId) continue;
          await tx.workspaceCanvasEdge.create({
            data: {
              workspaceId: ctx.workspaceId,
              canvasId: input.canvasId,
              fromNodeId: fromId,
              toNodeId: toId,
              label: e.label ?? null,
              kind: e.kind ?? null,
            },
          });
        }
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: userId,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "template_applied",
          after: {
            templateId: input.templateId,
            nodeCount: created.length,
            edgeCount: template.edges?.length ?? 0,
          },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return created;
      });
      return { ok: true as const, ids };
    }),

  /**
   * Re-flow a canvas using one of three layout algorithms.
   *
   * - `topological`: BFS from roots (no inbound edges), columns by
   *   depth. 280px per layer, 160px per row inside a layer.
   * - `force`: Fruchterman-Reingold, ~50 iterations. Seeds from current
   *   x/y for stability; clamps to a 4000×4000 box.
   * - `grid`: deterministic snap to 240×180 grid, sorted by
   *   `(targetType, title-of-id)` for stability across runs.
   *
   * Single audit row per layout op.
   */
  layout: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        algorithm: z.enum(["topological", "force", "grid"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        include: {
          nodes: { select: { id: true, x: true, y: true, targetType: true, targetId: true } },
          edges: { select: { fromNodeId: true, toNodeId: true } },
        },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      if (canvas.nodes.length === 0) {
        return { ok: true as const, count: 0 };
      }

      const positions =
        input.algorithm === "topological"
          ? computeTopologicalLayout(canvas.nodes, canvas.edges)
          : input.algorithm === "force"
            ? computeForceLayout(canvas.nodes, canvas.edges)
            : computeGridLayout(canvas.nodes);

      let updated = 0;
      await ctx.db.$transaction(async (tx) => {
        for (const node of canvas.nodes) {
          const pos = positions.get(node.id);
          if (!pos) continue;
          await tx.workspaceCanvasNode.update({
            where: { id: node.id },
            data: { x: pos.x, y: pos.y },
          });
          updated += 1;
        }
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "layout_applied",
          after: { algorithm: input.algorithm, count: updated },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
      });
      return { ok: true as const, count: updated };
    }),

  /**
   * Broadcast the calling user's cursor position on a canvas. Fire-and-
   * forget Redis publish — no persistence, no audit. Workspace-scoped:
   * only members of the workspace can publish (and the SSE channel
   * is keyed by workspaceId so only workspace members receive it).
   */
  broadcastPresence: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        x: z.number(),
        y: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      const userId = ctx.session?.user?.id ?? null;
      const name = ctx.session?.user?.name ?? ctx.session?.user?.email ?? "Anonymous";
      void publish({
        id: nanoid(),
        workspaceId: ctx.workspaceId,
        kind: EventKind.ISSUE_UPDATED,
        subjectType: "canvas-presence",
        subjectId: input.canvasId,
        payload: {
          userId,
          name,
          x: input.x,
          y: input.y,
          ts: Date.now(),
        },
        actorId: userId,
        createdAt: new Date().toISOString(),
      });
      return { ok: true as const };
    }),

  /**
   * Build a canvas from an existing ExecutionPlan: places the plan node
   * at the origin and topologically lays out step nodes by longest-path
   * depth, with edges from plan → step (contains) and prerequisite →
   * dependent (depends_on).
   */
  createFromPlan: workspaceProcedure
    .input(
      z.object({
        planId: z.string().cuid(),
        name: z.string().min(1).max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const plan = await ctx.db.executionPlan.findFirst({
        where: { id: input.planId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: {
          id: true,
          title: true,
          steps: {
            select: { id: true, position: true, dependsOnStepIds: true },
            orderBy: { position: "asc" },
          },
        },
      });
      if (!plan) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Execution plan not found." });
      }

      const layout = computePlanLayout(plan.steps);

      const result = await ctx.db.$transaction(async (tx) => {
        const canvas = await tx.workspaceCanvas.create({
          data: {
            workspaceId: ctx.workspaceId,
            name: (input.name ?? plan.title).trim() || plan.title,
            scopeType: "execution-plan",
            scopeId: plan.id,
            createdById: ctx.session?.user?.id ?? null,
          },
        });

        const planNode = await tx.workspaceCanvasNode.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: canvas.id,
            targetType: "execution-plan",
            targetId: plan.id,
            x: 0,
            y: 0,
            width: 320,
            height: 160,
            zIndex: 0,
            viewMode: "card",
          },
        });

        const stepNodeIds = new Map<string, string>();
        for (const step of plan.steps) {
          const pos = layout.positions.get(step.id);
          if (!pos) continue;
          const created = await tx.workspaceCanvasNode.create({
            data: {
              workspaceId: ctx.workspaceId,
              canvasId: canvas.id,
              targetType: "execution-step",
              targetId: step.id,
              x: pos.x,
              y: pos.y,
              width: 280,
              height: 140,
              zIndex: 0,
              viewMode: "card",
            },
          });
          stepNodeIds.set(step.id, created.id);
        }

        let edgeCount = 0;
        for (const step of plan.steps) {
          const stepNodeId = stepNodeIds.get(step.id);
          if (!stepNodeId) continue;
          await tx.workspaceCanvasEdge.create({
            data: {
              workspaceId: ctx.workspaceId,
              canvasId: canvas.id,
              fromNodeId: planNode.id,
              toNodeId: stepNodeId,
              kind: "contains",
            },
          });
          edgeCount += 1;
          for (const depId of step.dependsOnStepIds) {
            const fromId = stepNodeIds.get(depId);
            if (!fromId) continue;
            await tx.workspaceCanvasEdge.create({
              data: {
                workspaceId: ctx.workspaceId,
                canvasId: canvas.id,
                fromNodeId: fromId,
                toNodeId: stepNodeId,
                kind: "depends_on",
              },
            });
            edgeCount += 1;
          }
        }

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: canvas.id,
          action: "created",
          after: { name: canvas.name, scope: "execution-plan", planId: plan.id },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: canvas.id,
        });

        return {
          canvasId: canvas.id,
          nodeCount: stepNodeIds.size + 1,
          edgeCount,
        };
      });

      return result;
    }),

  // -------------------------------------------------------------------------
  // Styles (design tokens) — workspace-scoped, soft-deleted via archivedAt
  // -------------------------------------------------------------------------

  /**
   * Create a workspace-scoped reusable style. `value` is opaque JSON; the
   * client renders against it. Names are unique per `(workspaceId, kind)` —
   * Prisma surfaces P2002 as a Zod-friendly error here.
   */
  styleCreate: workspaceProcedure
    .input(
      z.object({
        kind: styleKindSchema,
        name: z.string().min(1).max(120),
        value: z.unknown(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const trimmed = input.name.trim();
      if (!trimmed) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Style name cannot be blank." });
      }
      try {
        const created = await ctx.db.$transaction(async (tx) => {
          const row = await tx.canvasStyle.create({
            data: {
              workspaceId: ctx.workspaceId,
              kind: input.kind as CanvasStyleKind,
              name: trimmed,
              value: (input.value ?? {}) as Prisma.InputJsonValue,
              createdById: ctx.session?.user?.id ?? null,
            },
          });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session?.user?.id ?? null,
            entity: "canvas-style",
            entityId: row.id,
            action: "created",
            after: { kind: row.kind, name: row.name },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "canvas-style",
            subjectId: row.id,
          });
          return row;
        });
        return { id: created.id, kind: created.kind, name: created.name };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new TRPCError({
            code: "CONFLICT",
            message: `A ${input.kind} style named "${trimmed}" already exists in this workspace.`,
          });
        }
        throw err;
      }
    }),

  styleList: workspaceProcedure
    .input(
      z
        .object({
          kind: styleKindSchema.optional(),
          includeArchived: z.boolean().default(false),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.canvasStyle.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          kind: input.kind ? (input.kind as CanvasStyleKind) : undefined,
          archivedAt: input.includeArchived ? undefined : null,
        },
        orderBy: [{ kind: "asc" }, { name: "asc" }],
      });
      return { items: rows };
    }),

  styleUpdate: workspaceProcedure
    .input(
      z.object({
        styleId: z.string().cuid(),
        name: z.string().min(1).max(120).optional(),
        value: z.unknown().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.canvasStyle.findFirst({
        where: { id: input.styleId, workspaceId: ctx.workspaceId },
        select: { id: true, kind: true, name: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas style not found." });
      }
      const data: Prisma.CanvasStyleUpdateInput = {};
      if (input.name !== undefined) {
        const trimmed = input.name.trim();
        if (!trimmed) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Style name cannot be blank." });
        }
        data.name = trimmed;
      }
      if (input.value !== undefined) {
        data.value = (input.value ?? {}) as Prisma.InputJsonValue;
      }
      try {
        await ctx.db.$transaction(async (tx) => {
          await tx.canvasStyle.update({ where: { id: input.styleId }, data });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session?.user?.id ?? null,
            entity: "canvas-style",
            entityId: input.styleId,
            action: "updated",
            after: { name: data.name ?? existing.name },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "canvas-style",
            subjectId: input.styleId,
          });
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new TRPCError({
            code: "CONFLICT",
            message: `A ${existing.kind} style with that name already exists.`,
          });
        }
        throw err;
      }
      return { ok: true as const };
    }),

  /**
   * Soft-delete via `archivedAt`. Style stays in the row store so existing
   * `styleRefs` references resolve to the archived value — clients should
   * surface them as "deprecated" rather than dead refs.
   */
  styleDelete: workspaceProcedure
    .input(z.object({ styleId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.canvasStyle.findFirst({
        where: { id: input.styleId, workspaceId: ctx.workspaceId },
        select: { id: true, archivedAt: true, name: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas style not found." });
      }
      if (existing.archivedAt) {
        return { ok: true as const };
      }
      await ctx.db.$transaction(async (tx) => {
        await tx.canvasStyle.update({
          where: { id: input.styleId },
          data: { archivedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "canvas-style",
          entityId: input.styleId,
          action: "archived",
          before: { name: existing.name },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "canvas-style",
          subjectId: input.styleId,
        });
      });
      return { ok: true as const };
    }),

  // -------------------------------------------------------------------------
  // Components — workspace-scoped reusable definitions
  // -------------------------------------------------------------------------

  /**
   * Create a workspace component from a snapshot definition. `name` is
   * unique per workspace (P2002 surfaces as a clean conflict). The
   * definition is the opaque tree the client renders; we type-validate the
   * top-level shape but pass the contents through unchanged.
   */
  componentCreate: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(2_000).nullable().optional(),
        thumbnail: z.string().max(200_000).nullable().optional(),
        definition: componentDefinitionSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const trimmed = input.name.trim();
      if (!trimmed) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Component name cannot be blank." });
      }
      try {
        const created = await ctx.db.$transaction(async (tx) => {
          const row = await tx.canvasComponent.create({
            data: {
              workspaceId: ctx.workspaceId,
              name: trimmed,
              description: input.description ?? null,
              thumbnail: input.thumbnail ?? null,
              definition: input.definition as unknown as Prisma.InputJsonValue,
              createdById: ctx.session?.user?.id ?? null,
            },
          });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session?.user?.id ?? null,
            entity: "canvas-component",
            entityId: row.id,
            action: "created",
            after: { name: row.name },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "canvas-component",
            subjectId: row.id,
          });
          return row;
        });
        return { id: created.id, name: created.name };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new TRPCError({
            code: "CONFLICT",
            message: `A component named "${trimmed}" already exists in this workspace.`,
          });
        }
        throw err;
      }
    }),

  componentList: workspaceProcedure
    .input(
      z
        .object({
          includeArchived: z.boolean().default(false),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.canvasComponent.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: input.includeArchived ? undefined : null,
        },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          name: true,
          description: true,
          thumbnail: true,
          createdAt: true,
          updatedAt: true,
          archivedAt: true,
          _count: { select: { instances: true } },
        },
      });
      return { items: rows };
    }),

  componentGet: workspaceProcedure
    .input(z.object({ componentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.canvasComponent.findFirst({
        where: { id: input.componentId, workspaceId: ctx.workspaceId },
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Component not found." });
      }
      return row;
    }),

  /**
   * Patch a component. Updating `definition` bumps `updatedAt` (Prisma's
   * `@updatedAt` handles this implicitly on any write) so clients can
   * refresh instance renders by comparing component `updatedAt` against
   * their cached snapshot timestamp.
   */
  componentUpdate: workspaceProcedure
    .input(
      z.object({
        componentId: z.string().cuid(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2_000).nullable().optional(),
        thumbnail: z.string().max(200_000).nullable().optional(),
        definition: componentDefinitionSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.canvasComponent.findFirst({
        where: { id: input.componentId, workspaceId: ctx.workspaceId },
        select: { id: true, name: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Component not found." });
      }
      const data: Prisma.CanvasComponentUpdateInput = {};
      if (input.name !== undefined) {
        const trimmed = input.name.trim();
        if (!trimmed) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Component name cannot be blank." });
        }
        data.name = trimmed;
      }
      if (input.description !== undefined) data.description = input.description;
      if (input.thumbnail !== undefined) data.thumbnail = input.thumbnail;
      if (input.definition !== undefined) {
        data.definition = input.definition as unknown as Prisma.InputJsonValue;
      }
      try {
        await ctx.db.$transaction(async (tx) => {
          await tx.canvasComponent.update({ where: { id: input.componentId }, data });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session?.user?.id ?? null,
            entity: "canvas-component",
            entityId: input.componentId,
            action: "updated",
            after: { name: data.name ?? existing.name, definitionUpdated: input.definition !== undefined },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "canvas-component",
            subjectId: input.componentId,
          });
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A component with that name already exists.",
          });
        }
        throw err;
      }
      return { ok: true as const };
    }),

  /**
   * Soft-delete via `archivedAt`. Instances stay alive — they continue to
   * render against the snapshot the component was at when archived (until
   * detached or removed manually).
   */
  componentArchive: workspaceProcedure
    .input(z.object({ componentId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.canvasComponent.findFirst({
        where: { id: input.componentId, workspaceId: ctx.workspaceId },
        select: { id: true, archivedAt: true, name: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Component not found." });
      }
      if (existing.archivedAt) {
        return { ok: true as const };
      }
      await ctx.db.$transaction(async (tx) => {
        await tx.canvasComponent.update({
          where: { id: input.componentId },
          data: { archivedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "canvas-component",
          entityId: input.componentId,
          action: "archived",
          before: { name: existing.name },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "canvas-component",
          subjectId: input.componentId,
        });
      });
      return { ok: true as const };
    }),

  // -------------------------------------------------------------------------
  // Component instances
  // -------------------------------------------------------------------------

  /**
   * Place a component on a canvas. `width` / `height` default to the
   * component definition's intrinsic size if omitted. Rejects archived
   * components — instances can only originate from active definitions.
   */
  instanceCreate: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        componentId: z.string().cuid(),
        x: z.number(),
        y: z.number(),
        width: z.number().min(1).max(20_000).optional(),
        height: z.number().min(1).max(20_000).optional(),
        parentFrameId: z.string().cuid().nullable().optional(),
        groupId: z.string().cuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [canvas, component] = await Promise.all([
        ctx.db.workspaceCanvas.findFirst({
          where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
          select: { id: true },
        }),
        ctx.db.canvasComponent.findFirst({
          where: { id: input.componentId, workspaceId: ctx.workspaceId, archivedAt: null },
          select: { id: true, definition: true },
        }),
      ]);
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      if (!component) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Component not found or archived." });
      }
      const def = component.definition as unknown as ComponentDefinition;
      const fallbackW = typeof def?.width === "number" ? def.width : 320;
      const fallbackH = typeof def?.height === "number" ? def.height : 200;
      if (input.parentFrameId) {
        const frame = await ctx.db.canvasFrame.findFirst({
          where: {
            id: input.parentFrameId,
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
          },
          select: { id: true },
        });
        if (!frame) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "parentFrameId not found on this canvas.",
          });
        }
      }
      if (input.groupId) {
        const group = await ctx.db.canvasGroup.findFirst({
          where: { id: input.groupId, workspaceId: ctx.workspaceId, canvasId: input.canvasId },
          select: { id: true },
        });
        if (!group) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "groupId not found on this canvas.",
          });
        }
      }
      const created = await ctx.db.$transaction(async (tx) => {
        const row = await tx.canvasComponentInstance.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            componentId: input.componentId,
            x: input.x,
            y: input.y,
            width: input.width ?? fallbackW,
            height: input.height ?? fallbackH,
            parentFrameId: input.parentFrameId ?? null,
            groupId: input.groupId ?? null,
            overrides: {} as Prisma.InputJsonValue,
          },
        });
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "instance_added",
          after: { instanceId: row.id, componentId: input.componentId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return row;
      });
      return { id: created.id };
    }),

  /**
   * Patch an instance. `overrides` is REPLACED (not merged) when passed —
   * callers that want a sparse update should read first and send the
   * full merged map. Pass `null` to clear.
   */
  instancePatch: workspaceProcedure
    .input(
      z.object({
        instanceId: z.string().cuid(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().min(1).max(20_000).optional(),
        height: z.number().min(1).max(20_000).optional(),
        overrides: z.record(z.unknown()).nullable().optional(),
        lockedAt: z.union([z.date(), z.string().datetime(), z.null()]).optional(),
        hiddenAt: z.union([z.date(), z.string().datetime(), z.null()]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.canvasComponentInstance.findFirst({
        where: { id: input.instanceId, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Component instance not found." });
      }
      const data: Prisma.CanvasComponentInstanceUpdateInput = {};
      if (input.x !== undefined) data.x = input.x;
      if (input.y !== undefined) data.y = input.y;
      if (input.width !== undefined) data.width = input.width;
      if (input.height !== undefined) data.height = input.height;
      if (input.overrides !== undefined) {
        data.overrides =
          input.overrides === null
            ? Prisma.JsonNull
            : (input.overrides as Prisma.InputJsonValue);
      }
      if (input.lockedAt !== undefined) {
        data.lockedAt = input.lockedAt === null ? null : new Date(input.lockedAt);
      }
      if (input.hiddenAt !== undefined) {
        data.hiddenAt = input.hiddenAt === null ? null : new Date(input.hiddenAt);
      }
      await ctx.db.$transaction(async (tx) => {
        await tx.canvasComponentInstance.update({
          where: { id: input.instanceId },
          data,
        });
        await tx.workspaceCanvas.update({
          where: { id: existing.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: existing.canvasId,
          action: "instance_updated",
          after: { instanceId: input.instanceId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: existing.canvasId,
        });
      });
      return { ok: true as const };
    }),

  /**
   * Materialise an instance into raw nodes / shapes / frames under the
   * instance's host frame, applying overrides as final per-row writes,
   * then delete the instance row. Returns the ids of created entities so
   * the client can re-select them.
   *
   * Override paths follow the convention `"<kind>.<index>.<field>"` —
   * e.g. `"nodes.0.x"` or `"shapes.2.style.fill"`. Unknown paths are
   * silently ignored (component schemas drift; tolerating drift is
   * cheaper than refusing to detach).
   */
  instanceDetach: workspaceProcedure
    .input(z.object({ instanceId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const instance = await ctx.db.canvasComponentInstance.findFirst({
        where: { id: input.instanceId, workspaceId: ctx.workspaceId },
        include: {
          component: { select: { id: true, definition: true } },
        },
      });
      if (!instance) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Component instance not found." });
      }
      const def = (instance.component.definition ?? {}) as ComponentDefinition;
      const overrides = (instance.overrides ?? {}) as Record<string, unknown>;

      // Apply overrides over a deep clone of the definition before we
      // materialise rows. Path format: "<bucket>.<index>.<...rest>".
      const cloned: ComponentDefinition = JSON.parse(JSON.stringify(def));
      for (const [path, value] of Object.entries(overrides)) {
        const parts = path.split(".");
        if (parts.length < 2) continue;
        const [bucket, idxStr, ...rest] = parts;
        const idx = Number(idxStr);
        if (!bucket || Number.isNaN(idx)) continue;
        const list = (cloned as unknown as Record<string, unknown[]>)[bucket];
        if (!Array.isArray(list) || idx < 0 || idx >= list.length) continue;
        if (rest.length === 0) {
          list[idx] = value;
          continue;
        }
        let target = list[idx] as Record<string, unknown> | undefined;
        for (let i = 0; i < rest.length - 1; i++) {
          if (!target || typeof target !== "object") {
            target = undefined;
            break;
          }
          const next = target[rest[i]!] as Record<string, unknown> | undefined;
          if (!next || typeof next !== "object") {
            target[rest[i]!] = {};
            target = target[rest[i]!] as Record<string, unknown>;
          } else {
            target = next;
          }
        }
        if (target) {
          target[rest[rest.length - 1]!] = value;
        }
      }

      const created = await ctx.db.$transaction(async (tx) => {
        const nodeIds: string[] = [];
        const shapeIds: string[] = [];
        const frameIds: string[] = [];

        const dx = instance.x;
        const dy = instance.y;
        const parentFrameId = instance.parentFrameId;
        const groupId = instance.groupId;

        for (const raw of cloned.nodes ?? []) {
          const n = raw as Record<string, unknown>;
          if (typeof n?.targetType !== "string" || typeof n?.targetId !== "string") continue;
          const row = await tx.workspaceCanvasNode.create({
            data: {
              workspaceId: ctx.workspaceId,
              canvasId: instance.canvasId,
              targetType: n.targetType,
              targetId: n.targetId,
              x: dx + Number((n.x as number) ?? 0),
              y: dy + Number((n.y as number) ?? 0),
              width: Number((n.width as number) ?? 240),
              height: Number((n.height as number) ?? 160),
              zIndex: Number((n.zIndex as number) ?? 0),
              viewMode: typeof n.viewMode === "string" ? n.viewMode : null,
              meta: (n.meta as Prisma.InputJsonValue | undefined) ?? undefined,
              styleRefs: (n.styleRefs as Prisma.InputJsonValue | undefined) ?? undefined,
              parentFrameId: parentFrameId ?? null,
              groupId: groupId ?? null,
            },
            select: { id: true },
          });
          nodeIds.push(row.id);
        }

        for (const raw of cloned.shapes ?? []) {
          const s = raw as Record<string, unknown>;
          if (typeof s?.kind !== "string") continue;
          const row = await tx.canvasShape.create({
            data: {
              workspaceId: ctx.workspaceId,
              canvasId: instance.canvasId,
              kind: s.kind,
              x: dx + Number((s.x as number) ?? 0),
              y: dy + Number((s.y as number) ?? 0),
              width: s.width === undefined || s.width === null ? null : Number(s.width),
              height: s.height === undefined || s.height === null ? null : Number(s.height),
              path: (s.path as Prisma.InputJsonValue | undefined) ?? undefined,
              style: (s.style as Prisma.InputJsonValue | undefined) ?? undefined,
              text: typeof s.text === "string" ? s.text : null,
              zIndex: Number((s.zIndex as number) ?? 0),
              styleRefs: (s.styleRefs as Prisma.InputJsonValue | undefined) ?? undefined,
              parentFrameId: parentFrameId ?? null,
              canvasGroupId: groupId ?? null,
              createdById: ctx.session?.user?.id ?? null,
            },
            select: { id: true },
          });
          shapeIds.push(row.id);
        }

        for (const raw of cloned.frames ?? []) {
          const f = raw as Record<string, unknown>;
          const row = await tx.canvasFrame.create({
            data: {
              workspaceId: ctx.workspaceId,
              canvasId: instance.canvasId,
              name: typeof f.name === "string" ? f.name : "Frame",
              x: dx + Number((f.x as number) ?? 0),
              y: dy + Number((f.y as number) ?? 0),
              width: Number((f.width as number) ?? 200),
              height: Number((f.height as number) ?? 200),
              isPage: Boolean(f.isPage),
              autoLayout: (f.autoLayout as Prisma.InputJsonValue | undefined) ?? undefined,
              constraints: (f.constraints as Prisma.InputJsonValue | undefined) ?? undefined,
              backgroundFill: (f.backgroundFill as Prisma.InputJsonValue | undefined) ?? undefined,
              z: Number((f.z as number) ?? 0),
              parentFrameId: parentFrameId ?? null,
              createdById: ctx.session?.user?.id ?? null,
            },
            select: { id: true },
          });
          frameIds.push(row.id);
        }

        await tx.canvasComponentInstance.delete({ where: { id: instance.id } });
        await tx.workspaceCanvas.update({
          where: { id: instance.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: instance.canvasId,
          action: "instance_detached",
          before: { instanceId: instance.id },
          after: {
            nodeCount: nodeIds.length,
            shapeCount: shapeIds.length,
            frameCount: frameIds.length,
          },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: instance.canvasId,
        });
        return { nodeIds, shapeIds, frameIds };
      });
      return created;
    }),

  // -------------------------------------------------------------------------
  // Layer operations (hide / lock / rename / reorder)
  // -------------------------------------------------------------------------

  /**
   * Set the locked timestamp on a node / shape / frame / group / instance.
   * Idempotent — toggling the same value is a no-op. `lockedAt` is honored
   * by the canvas surface to disable drag/resize/edit.
   */
  layerSetLocked: workspaceProcedure
    .input(
      z.object({
        kind: layerKindAllSchema,
        id: z.string().cuid(),
        locked: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await setLayerFlag(ctx, "lockedAt", input);
      return { ok: true as const };
    }),

  layerSetHidden: workspaceProcedure
    .input(
      z.object({
        kind: layerKindAllSchema,
        id: z.string().cuid(),
        hidden: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await setLayerFlag(ctx, "hiddenAt", {
        kind: input.kind,
        id: input.id,
        locked: input.hidden, // shared helper interprets bool as "flag set"
      });
      return { ok: true as const };
    }),

  /**
   * Rename a frame, group, or component. Other kinds have no name field.
   */
  layerRename: workspaceProcedure
    .input(
      z.object({
        kind: layerKindNameableSchema,
        id: z.string().cuid(),
        name: z.string().min(1).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const trimmed = input.name.trim();
      if (!trimmed) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Name cannot be blank." });
      }
      if (input.kind === "frame") {
        const row = await ctx.db.canvasFrame.findFirst({
          where: { id: input.id, workspaceId: ctx.workspaceId },
          select: { id: true, canvasId: true },
        });
        if (!row) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Frame not found." });
        }
        await ctx.db.canvasFrame.update({ where: { id: input.id }, data: { name: trimmed } });
        await ctx.db.workspaceCanvas.update({
          where: { id: row.canvasId },
          data: { updatedAt: new Date() },
        });
      } else if (input.kind === "group") {
        const row = await ctx.db.canvasGroup.findFirst({
          where: { id: input.id, workspaceId: ctx.workspaceId },
          select: { id: true, canvasId: true },
        });
        if (!row) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Group not found." });
        }
        await ctx.db.canvasGroup.update({ where: { id: input.id }, data: { name: trimmed } });
        await ctx.db.workspaceCanvas.update({
          where: { id: row.canvasId },
          data: { updatedAt: new Date() },
        });
      } else if (input.kind === "component") {
        const row = await ctx.db.canvasComponent.findFirst({
          where: { id: input.id, workspaceId: ctx.workspaceId },
          select: { id: true },
        });
        if (!row) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Component not found." });
        }
        try {
          await ctx.db.canvasComponent.update({
            where: { id: input.id },
            data: { name: trimmed },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            throw new TRPCError({
              code: "CONFLICT",
              message: "A component with that name already exists.",
            });
          }
          throw err;
        }
      }
      return { ok: true as const };
    }),

  /**
   * Reorder layers within a canvas (optionally scoped to a parent frame).
   * Assigns sequential `z` (or `zIndex` for `WorkspaceCanvasNode`) values
   * in input order, starting at 0. Rows outside the input set are
   * untouched. Mixed-kind input is fine; the proc dispatches per row.
   */
  layerReorder: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        parentFrameId: z.string().cuid().nullable().optional(),
        ordered: z.array(layerKindReorderItemSchema).min(1).max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      await ctx.db.$transaction(async (tx) => {
        for (let i = 0; i < input.ordered.length; i++) {
          const item = input.ordered[i]!;
          if (item.kind === "node") {
            await tx.workspaceCanvasNode.updateMany({
              where: {
                id: item.id,
                workspaceId: ctx.workspaceId,
                canvasId: input.canvasId,
              },
              data: { zIndex: i },
            });
          } else if (item.kind === "shape") {
            await tx.canvasShape.updateMany({
              where: {
                id: item.id,
                workspaceId: ctx.workspaceId,
                canvasId: input.canvasId,
              },
              data: { zIndex: i },
            });
          } else if (item.kind === "frame") {
            await tx.canvasFrame.updateMany({
              where: {
                id: item.id,
                workspaceId: ctx.workspaceId,
                canvasId: input.canvasId,
              },
              data: { z: i },
            });
          } else if (item.kind === "group") {
            await tx.canvasGroup.updateMany({
              where: {
                id: item.id,
                workspaceId: ctx.workspaceId,
                canvasId: input.canvasId,
              },
              data: { z: i },
            });
          } else if (item.kind === "instance") {
            await tx.canvasComponentInstance.updateMany({
              where: {
                id: item.id,
                workspaceId: ctx.workspaceId,
                canvasId: input.canvasId,
              },
              data: { z: i },
            });
          }
        }
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "layers_reordered",
          after: { count: input.ordered.length },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
      });
      return { ok: true as const, count: input.ordered.length };
    }),

  // -----------------------------------------------------------------------
  // Frames — bounded regions that own their children
  // -----------------------------------------------------------------------

  frameAdd: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        parentFrameId: z.string().cuid().nullable().optional(),
        name: z.string().max(200).optional(),
        x: z.number(),
        y: z.number(),
        width: z.number().min(10).max(20_000),
        height: z.number().min(10).max(20_000),
        isPage: z.boolean().optional(),
        autoLayout: z.unknown().optional(),
        constraints: z.unknown().optional(),
        backgroundFill: z.unknown().optional(),
        z: z.number().int().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      if (input.parentFrameId) {
        const parent = await ctx.db.canvasFrame.findFirst({
          where: {
            id: input.parentFrameId,
            canvasId: input.canvasId,
            workspaceId: ctx.workspaceId,
          },
          select: { id: true },
        });
        if (!parent) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "parentFrameId is not a frame on this canvas.",
          });
        }
      }
      const frame = await ctx.db.$transaction(async (tx) => {
        const created = await tx.canvasFrame.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            parentFrameId: input.parentFrameId ?? null,
            name: input.name?.trim() || "Frame",
            x: input.x,
            y: input.y,
            width: input.width,
            height: input.height,
            isPage: input.isPage ?? false,
            autoLayout:
              input.autoLayout === undefined
                ? undefined
                : (input.autoLayout as Prisma.InputJsonValue),
            constraints:
              input.constraints === undefined
                ? undefined
                : (input.constraints as Prisma.InputJsonValue),
            backgroundFill:
              input.backgroundFill === undefined
                ? undefined
                : (input.backgroundFill as Prisma.InputJsonValue),
            z: input.z ?? 0,
            createdById: ctx.session?.user?.id ?? null,
          },
        });
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "frame_added",
          after: { frameId: created.id, name: created.name, isPage: created.isPage },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return created;
      });
      return { id: frame.id };
    }),

  framePatch: workspaceProcedure
    .input(
      z.object({
        frameId: z.string().cuid(),
        name: z.string().max(200).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().min(10).max(20_000).optional(),
        height: z.number().min(10).max(20_000).optional(),
        parentFrameId: z.string().cuid().nullable().optional(),
        isPage: z.boolean().optional(),
        autoLayout: z.unknown().optional(),
        constraints: z.unknown().optional(),
        backgroundFill: z.unknown().optional(),
        z: z.number().int().optional(),
        lockedAt: z.date().nullable().optional(),
        hiddenAt: z.date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const frame = await ctx.db.canvasFrame.findFirst({
        where: { id: input.frameId, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true, x: true, y: true },
      });
      if (!frame) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Frame not found." });
      }
      if (input.parentFrameId) {
        if (input.parentFrameId === input.frameId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "A frame cannot be its own parent.",
          });
        }
        const parent = await ctx.db.canvasFrame.findFirst({
          where: {
            id: input.parentFrameId,
            canvasId: frame.canvasId,
            workspaceId: ctx.workspaceId,
          },
          select: { id: true },
        });
        if (!parent) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "parentFrameId is not a frame on this canvas.",
          });
        }
      }
      const data: Prisma.CanvasFrameUpdateInput = {};
      if (input.name !== undefined) data.name = input.name.trim() || "Frame";
      if (input.x !== undefined) data.x = input.x;
      if (input.y !== undefined) data.y = input.y;
      if (input.width !== undefined) data.width = input.width;
      if (input.height !== undefined) data.height = input.height;
      if (input.parentFrameId !== undefined) {
        data.parentFrame =
          input.parentFrameId === null
            ? { disconnect: true }
            : { connect: { id: input.parentFrameId } };
      }
      if (input.isPage !== undefined) data.isPage = input.isPage;
      if (input.autoLayout !== undefined) {
        data.autoLayout =
          input.autoLayout === null ? Prisma.JsonNull : (input.autoLayout as Prisma.InputJsonValue);
      }
      if (input.constraints !== undefined) {
        data.constraints =
          input.constraints === null
            ? Prisma.JsonNull
            : (input.constraints as Prisma.InputJsonValue);
      }
      if (input.backgroundFill !== undefined) {
        data.backgroundFill =
          input.backgroundFill === null
            ? Prisma.JsonNull
            : (input.backgroundFill as Prisma.InputJsonValue);
      }
      if (input.z !== undefined) data.z = input.z;
      if (input.lockedAt !== undefined) data.lockedAt = input.lockedAt;
      if (input.hiddenAt !== undefined) data.hiddenAt = input.hiddenAt;

      const dx = input.x !== undefined ? input.x - frame.x : 0;
      const dy = input.y !== undefined ? input.y - frame.y : 0;

      await ctx.db.$transaction(async (tx) => {
        await tx.canvasFrame.update({ where: { id: input.frameId }, data });
        if (dx !== 0 || dy !== 0) {
          await tx.workspaceCanvasNode.updateMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
            data: { x: { increment: dx }, y: { increment: dy } },
          });
          await tx.canvasShape.updateMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
            data: { x: { increment: dx }, y: { increment: dy } },
          });
          await tx.canvasComponentInstance.updateMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
            data: { x: { increment: dx }, y: { increment: dy } },
          });
          await tx.canvasFrame.updateMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
            data: { x: { increment: dx }, y: { increment: dy } },
          });
        }
        await tx.workspaceCanvas.update({
          where: { id: frame.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: frame.canvasId,
          action: "frame_updated",
          after: { frameId: input.frameId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: frame.canvasId,
        });
      });
      return { ok: true as const };
    }),

  frameRemove: workspaceProcedure
    .input(
      z.object({
        frameId: z.string().cuid(),
        cascade: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const frame = await ctx.db.canvasFrame.findFirst({
        where: { id: input.frameId, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true, isPage: true },
      });
      if (!frame) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Frame not found." });
      }
      await ctx.db.$transaction(async (tx) => {
        if (input.cascade) {
          await tx.workspaceCanvasNode.deleteMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
          });
          await tx.canvasShape.deleteMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
          });
          await tx.canvasComponentInstance.deleteMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
          });
          await tx.canvasGroup.deleteMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
          });
          await tx.canvasFrame.deleteMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
          });
        }
        await tx.canvasFrame.delete({ where: { id: input.frameId } });

        if (frame.isPage) {
          const canvas = await tx.workspaceCanvas.findUnique({
            where: { id: frame.canvasId },
            select: { activePageId: true },
          });
          if (canvas?.activePageId === input.frameId) {
            const fallback = await tx.canvasFrame.findFirst({
              where: {
                canvasId: frame.canvasId,
                workspaceId: ctx.workspaceId,
                isPage: true,
              },
              orderBy: { z: "asc" },
              select: { id: true },
            });
            await tx.workspaceCanvas.update({
              where: { id: frame.canvasId },
              data: { activePageId: fallback?.id ?? null, updatedAt: new Date() },
            });
          } else {
            await tx.workspaceCanvas.update({
              where: { id: frame.canvasId },
              data: { updatedAt: new Date() },
            });
          }
        } else {
          await tx.workspaceCanvas.update({
            where: { id: frame.canvasId },
            data: { updatedAt: new Date() },
          });
        }

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: frame.canvasId,
          action: "frame_removed",
          before: { frameId: input.frameId, cascade: input.cascade },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: frame.canvasId,
        });
      });
      return { ok: true as const };
    }),

  // -----------------------------------------------------------------------
  // Groups — non-visual transform containers
  // -----------------------------------------------------------------------

  groupCreate: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        parentFrameId: z.string().cuid().nullable().optional(),
        name: z.string().max(200).optional(),
        memberNodeIds: z.array(z.string().cuid()).optional(),
        memberShapeIds: z.array(z.string().cuid()).optional(),
        memberInstanceIds: z.array(z.string().cuid()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      const nodeIds = input.memberNodeIds ?? [];
      const shapeIds = input.memberShapeIds ?? [];
      const instanceIds = input.memberInstanceIds ?? [];
      if (nodeIds.length + shapeIds.length + instanceIds.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "groupCreate requires at least one member.",
        });
      }
      const result = await ctx.db.$transaction(async (tx) => {
        const group = await tx.canvasGroup.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            parentFrameId: input.parentFrameId ?? null,
            name: input.name?.trim() || "Group",
            createdById: ctx.session?.user?.id ?? null,
          },
        });
        if (nodeIds.length) {
          await tx.workspaceCanvasNode.updateMany({
            where: {
              id: { in: nodeIds },
              canvasId: input.canvasId,
              workspaceId: ctx.workspaceId,
            },
            data: { groupId: group.id },
          });
        }
        if (shapeIds.length) {
          await tx.canvasShape.updateMany({
            where: {
              id: { in: shapeIds },
              canvasId: input.canvasId,
              workspaceId: ctx.workspaceId,
            },
            data: { canvasGroupId: group.id },
          });
        }
        if (instanceIds.length) {
          await tx.canvasComponentInstance.updateMany({
            where: {
              id: { in: instanceIds },
              canvasId: input.canvasId,
              workspaceId: ctx.workspaceId,
            },
            data: { groupId: group.id },
          });
        }
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "group_created",
          after: {
            groupId: group.id,
            memberCounts: {
              nodes: nodeIds.length,
              shapes: shapeIds.length,
              instances: instanceIds.length,
            },
          },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return group;
      });
      return { id: result.id };
    }),

  groupDissolve: workspaceProcedure
    .input(z.object({ groupId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.db.canvasGroup.findFirst({
        where: { id: input.groupId, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true },
      });
      if (!group) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Group not found." });
      }
      await ctx.db.$transaction(async (tx) => {
        await tx.workspaceCanvasNode.updateMany({
          where: { groupId: input.groupId, workspaceId: ctx.workspaceId },
          data: { groupId: null },
        });
        await tx.canvasShape.updateMany({
          where: { canvasGroupId: input.groupId, workspaceId: ctx.workspaceId },
          data: { canvasGroupId: null },
        });
        await tx.canvasComponentInstance.updateMany({
          where: { groupId: input.groupId, workspaceId: ctx.workspaceId },
          data: { groupId: null },
        });
        await tx.canvasGroup.delete({ where: { id: input.groupId } });
        await tx.workspaceCanvas.update({
          where: { id: group.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: group.canvasId,
          action: "group_dissolved",
          before: { groupId: input.groupId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: group.canvasId,
        });
      });
      return { ok: true as const };
    }),

  // -----------------------------------------------------------------------
  // Pages (multi-page DESIGN canvases) — page = top-level frame with isPage
  // -----------------------------------------------------------------------

  pageAdd: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        name: z.string().min(1).max(200),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().min(10).max(20_000).optional(),
        height: z.number().min(10).max(20_000).optional(),
        position: z.number().int().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true, activePageId: true },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      const existingCount = await ctx.db.canvasFrame.count({
        where: {
          canvasId: input.canvasId,
          workspaceId: ctx.workspaceId,
          isPage: true,
        },
      });
      const result = await ctx.db.$transaction(async (tx) => {
        const created = await tx.canvasFrame.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            parentFrameId: null,
            name: input.name.trim() || "Page",
            x: input.x ?? 0,
            y: input.y ?? 0,
            width: input.width ?? 1920,
            height: input.height ?? 1080,
            isPage: true,
            z: input.position ?? existingCount,
            createdById: ctx.session?.user?.id ?? null,
          },
        });
        const becomesActive = existingCount === 0 || !canvas.activePageId;
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: {
            updatedAt: new Date(),
            ...(becomesActive ? { activePageId: created.id } : {}),
          },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "page_added",
          after: { pageId: created.id, name: created.name, activated: becomesActive },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return { frameId: created.id, activated: becomesActive };
      });
      return result;
    }),

  pageRemove: workspaceProcedure
    .input(
      z.object({
        frameId: z.string().cuid(),
        reassignActivePage: z.string().cuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const frame = await ctx.db.canvasFrame.findFirst({
        where: { id: input.frameId, workspaceId: ctx.workspaceId, isPage: true },
        select: { id: true, canvasId: true },
      });
      if (!frame) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Page not found." });
      }
      await ctx.db.$transaction(async (tx) => {
        await tx.canvasFrame.delete({ where: { id: input.frameId } });
        const canvas = await tx.workspaceCanvas.findUnique({
          where: { id: frame.canvasId },
          select: { activePageId: true },
        });
        let nextActive: string | null | undefined = undefined;
        if (canvas?.activePageId === input.frameId) {
          if (input.reassignActivePage) {
            const target = await tx.canvasFrame.findFirst({
              where: {
                id: input.reassignActivePage,
                canvasId: frame.canvasId,
                workspaceId: ctx.workspaceId,
                isPage: true,
              },
              select: { id: true },
            });
            nextActive = target?.id ?? null;
          }
          if (nextActive === undefined) {
            const fallback = await tx.canvasFrame.findFirst({
              where: {
                canvasId: frame.canvasId,
                workspaceId: ctx.workspaceId,
                isPage: true,
              },
              orderBy: { z: "asc" },
              select: { id: true },
            });
            nextActive = fallback?.id ?? null;
          }
        }
        await tx.workspaceCanvas.update({
          where: { id: frame.canvasId },
          data: {
            updatedAt: new Date(),
            ...(nextActive !== undefined ? { activePageId: nextActive } : {}),
          },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: frame.canvasId,
          action: "page_removed",
          before: { pageId: input.frameId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: frame.canvasId,
        });
      });
      return { ok: true as const };
    }),

  pageReorder: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        pageIds: z.array(z.string().cuid()).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      const pages = await ctx.db.canvasFrame.findMany({
        where: {
          canvasId: input.canvasId,
          workspaceId: ctx.workspaceId,
          isPage: true,
        },
        select: { id: true },
      });
      const validIds = new Set(pages.map((p) => p.id));
      const reordered = input.pageIds.filter((id) => validIds.has(id));
      if (reordered.length !== input.pageIds.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "pageIds contains ids that are not pages on this canvas.",
        });
      }
      await ctx.db.$transaction(async (tx) => {
        for (let i = 0; i < reordered.length; i++) {
          await tx.canvasFrame.update({
            where: { id: reordered[i]! },
            data: { z: i },
          });
        }
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "pages_reordered",
          after: { order: reordered },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
      });
      return { ok: true as const, count: reordered.length };
    }),

  pageActivate: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        frameId: z.string().cuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const page = await ctx.db.canvasFrame.findFirst({
        where: {
          id: input.frameId,
          canvasId: input.canvasId,
          workspaceId: ctx.workspaceId,
          isPage: true,
        },
        select: { id: true },
      });
      if (!page) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Page not found on canvas." });
      }
      await ctx.db.workspaceCanvas.update({
        where: { id: input.canvasId },
        data: { activePageId: input.frameId, updatedAt: new Date() },
      });
      return { ok: true as const };
    }),

  // -----------------------------------------------------------------------
  // Align / distribute / tidy-up
  // -----------------------------------------------------------------------

  alignSelection: workspaceProcedure
    .input(
      z.object({
        canvasId: z.string().cuid(),
        ids: z.object({
          nodeIds: z.array(z.string().cuid()).optional(),
          shapeIds: z.array(z.string().cuid()).optional(),
          frameIds: z.array(z.string().cuid()).optional(),
          groupIds: z.array(z.string().cuid()).optional(),
          instanceIds: z.array(z.string().cuid()).optional(),
        }),
        op: z.enum([
          "alignLeft",
          "alignCenter",
          "alignRight",
          "alignTop",
          "alignMiddle",
          "alignBottom",
          "distributeH",
          "distributeV",
          "tidyUp",
        ]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const canvas = await ctx.db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found." });
      }
      const { nodeIds = [], shapeIds = [], frameIds = [], groupIds = [], instanceIds = [] } =
        input.ids;

      const [nodes, shapes, frames, instances, groupRows] = await Promise.all([
        nodeIds.length
          ? ctx.db.workspaceCanvasNode.findMany({
              where: {
                id: { in: nodeIds },
                canvasId: input.canvasId,
                workspaceId: ctx.workspaceId,
              },
              select: { id: true, x: true, y: true, width: true, height: true },
            })
          : Promise.resolve(
              [] as Array<{ id: string; x: number; y: number; width: number; height: number }>,
            ),
        shapeIds.length
          ? ctx.db.canvasShape.findMany({
              where: {
                id: { in: shapeIds },
                canvasId: input.canvasId,
                workspaceId: ctx.workspaceId,
              },
              select: { id: true, x: true, y: true, width: true, height: true },
            })
          : Promise.resolve(
              [] as Array<{
                id: string;
                x: number;
                y: number;
                width: number | null;
                height: number | null;
              }>,
            ),
        frameIds.length
          ? ctx.db.canvasFrame.findMany({
              where: {
                id: { in: frameIds },
                canvasId: input.canvasId,
                workspaceId: ctx.workspaceId,
              },
              select: { id: true, x: true, y: true, width: true, height: true },
            })
          : Promise.resolve(
              [] as Array<{ id: string; x: number; y: number; width: number; height: number }>,
            ),
        instanceIds.length
          ? ctx.db.canvasComponentInstance.findMany({
              where: {
                id: { in: instanceIds },
                canvasId: input.canvasId,
                workspaceId: ctx.workspaceId,
              },
              select: { id: true, x: true, y: true, width: true, height: true },
            })
          : Promise.resolve(
              [] as Array<{ id: string; x: number; y: number; width: number; height: number }>,
            ),
        groupIds.length
          ? ctx.db.canvasGroup.findMany({
              where: {
                id: { in: groupIds },
                canvasId: input.canvasId,
                workspaceId: ctx.workspaceId,
              },
              select: {
                id: true,
                nodes: { select: { id: true, x: true, y: true, width: true, height: true } },
                shapes: { select: { id: true, x: true, y: true, width: true, height: true } },
                instances: {
                  select: { id: true, x: true, y: true, width: true, height: true },
                },
              },
            })
          : Promise.resolve(
              [] as Array<{
                id: string;
                nodes: Array<{ id: string; x: number; y: number; width: number; height: number }>;
                shapes: Array<{
                  id: string;
                  x: number;
                  y: number;
                  width: number | null;
                  height: number | null;
                }>;
                instances: Array<{
                  id: string;
                  x: number;
                  y: number;
                  width: number;
                  height: number;
                }>;
              }>,
            ),
      ]);

      const items: AlignItem[] = [];
      for (const n of nodes) {
        items.push({
          id: `node:${n.id}`,
          kind: "node",
          x: n.x,
          y: n.y,
          width: n.width,
          height: n.height,
        });
      }
      for (const s of shapes) {
        if (s.width == null || s.height == null) continue;
        items.push({
          id: `shape:${s.id}`,
          kind: "shape",
          x: s.x,
          y: s.y,
          width: s.width,
          height: s.height,
        });
      }
      for (const f of frames) {
        items.push({
          id: `frame:${f.id}`,
          kind: "frame",
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
        });
      }
      for (const i of instances) {
        items.push({
          id: `instance:${i.id}`,
          kind: "instance",
          x: i.x,
          y: i.y,
          width: i.width,
          height: i.height,
        });
      }

      // Group bounding box: union of member bounds. Members translate by the
      // same delta so the group moves as a unit.
      const groupBounds = new Map<
        string,
        { x: number; y: number; width: number; height: number }
      >();
      for (const g of groupRows) {
        const members: Array<{ x: number; y: number; w: number; h: number }> = [];
        for (const n of g.nodes) members.push({ x: n.x, y: n.y, w: n.width, h: n.height });
        for (const s of g.shapes) {
          if (s.width == null || s.height == null) continue;
          members.push({ x: s.x, y: s.y, w: s.width, h: s.height });
        }
        for (const i of g.instances) members.push({ x: i.x, y: i.y, w: i.width, h: i.height });
        if (members.length === 0) continue;
        const minX = Math.min(...members.map((m) => m.x));
        const minY = Math.min(...members.map((m) => m.y));
        const maxX = Math.max(...members.map((m) => m.x + m.w));
        const maxY = Math.max(...members.map((m) => m.y + m.h));
        const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        groupBounds.set(g.id, bounds);
        items.push({ id: `group:${g.id}`, kind: "group", ...bounds });
      }

      const positions = computeAlignment(items, input.op);
      if (positions.size === 0) {
        return { ok: true as const, count: 0 };
      }

      let updated = 0;
      await ctx.db.$transaction(async (tx) => {
        for (const [key, pos] of positions.entries()) {
          const [kind, rawId] = key.split(":", 2) as [string, string];
          if (kind === "node") {
            await tx.workspaceCanvasNode.update({
              where: { id: rawId },
              data: { x: pos.x, y: pos.y },
            });
            updated += 1;
          } else if (kind === "shape") {
            await tx.canvasShape.update({
              where: { id: rawId },
              data: { x: pos.x, y: pos.y },
            });
            updated += 1;
          } else if (kind === "frame") {
            const frame = frames.find((f) => f.id === rawId);
            if (!frame) continue;
            const dx = pos.x - frame.x;
            const dy = pos.y - frame.y;
            await tx.canvasFrame.update({
              where: { id: rawId },
              data: { x: pos.x, y: pos.y },
            });
            if (dx !== 0 || dy !== 0) {
              await tx.workspaceCanvasNode.updateMany({
                where: { parentFrameId: rawId, workspaceId: ctx.workspaceId },
                data: { x: { increment: dx }, y: { increment: dy } },
              });
              await tx.canvasShape.updateMany({
                where: { parentFrameId: rawId, workspaceId: ctx.workspaceId },
                data: { x: { increment: dx }, y: { increment: dy } },
              });
              await tx.canvasComponentInstance.updateMany({
                where: { parentFrameId: rawId, workspaceId: ctx.workspaceId },
                data: { x: { increment: dx }, y: { increment: dy } },
              });
              await tx.canvasFrame.updateMany({
                where: { parentFrameId: rawId, workspaceId: ctx.workspaceId },
                data: { x: { increment: dx }, y: { increment: dy } },
              });
            }
            updated += 1;
          } else if (kind === "instance") {
            await tx.canvasComponentInstance.update({
              where: { id: rawId },
              data: { x: pos.x, y: pos.y },
            });
            updated += 1;
          } else if (kind === "group") {
            const b = groupBounds.get(rawId);
            if (!b) continue;
            const dx = pos.x - b.x;
            const dy = pos.y - b.y;
            if (dx === 0 && dy === 0) continue;
            await tx.workspaceCanvasNode.updateMany({
              where: { groupId: rawId, workspaceId: ctx.workspaceId },
              data: { x: { increment: dx }, y: { increment: dy } },
            });
            await tx.canvasShape.updateMany({
              where: { canvasGroupId: rawId, workspaceId: ctx.workspaceId },
              data: { x: { increment: dx }, y: { increment: dy } },
            });
            await tx.canvasComponentInstance.updateMany({
              where: { groupId: rawId, workspaceId: ctx.workspaceId },
              data: { x: { increment: dx }, y: { increment: dy } },
            });
            updated += 1;
          }
        }
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session?.user?.id ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "align_applied",
          after: { op: input.op, count: updated },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
      });
      return { ok: true as const, count: updated };
    }),
});

// ---------------------------------------------------------------------------
// Layer hide / lock shared mutator
//
// Both timestamps live on the same five tables. Keeping the dispatch in one
// helper avoids ten near-identical case-arms across `layerSetHidden` and
// `layerSetLocked`. The `setBool` arg tells us whether to stamp the column
// (true → `new Date()`) or clear it (false → null). Idempotency comes from
// reading the row first and short-circuiting when the requested state is
// already the current state.
// ---------------------------------------------------------------------------

type LayerFlagCol = "lockedAt" | "hiddenAt";
type LayerKindAll = z.infer<typeof layerKindAllSchema>;

async function setLayerFlag(
  ctx: { db: PrismaClient; workspaceId: string; session?: { user?: { id?: string | null } | null } | null },
  col: LayerFlagCol,
  args: { kind: LayerKindAll; id: string; locked: boolean },
): Promise<void> {
  const setBool = args.locked;
  const value = setBool ? new Date() : null;
  const data: Record<string, Date | null> = { [col]: value };
  let canvasId: string | null = null;

  if (args.kind === "node") {
    const row = await ctx.db.workspaceCanvasNode.findFirst({
      where: { id: args.id, workspaceId: ctx.workspaceId },
      select: { id: true, canvasId: true, lockedAt: true, hiddenAt: true },
    });
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Canvas node not found." });
    canvasId = row.canvasId;
    if ((row[col] !== null) === setBool) return;
    await ctx.db.workspaceCanvasNode.update({ where: { id: args.id }, data });
  } else if (args.kind === "shape") {
    const row = await ctx.db.canvasShape.findFirst({
      where: { id: args.id, workspaceId: ctx.workspaceId },
      select: { id: true, canvasId: true, lockedAt: true, hiddenAt: true },
    });
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Canvas shape not found." });
    canvasId = row.canvasId;
    if ((row[col] !== null) === setBool) return;
    await ctx.db.canvasShape.update({ where: { id: args.id }, data });
  } else if (args.kind === "frame") {
    const row = await ctx.db.canvasFrame.findFirst({
      where: { id: args.id, workspaceId: ctx.workspaceId },
      select: { id: true, canvasId: true, lockedAt: true, hiddenAt: true },
    });
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Canvas frame not found." });
    canvasId = row.canvasId;
    if ((row[col] !== null) === setBool) return;
    await ctx.db.canvasFrame.update({ where: { id: args.id }, data });
  } else if (args.kind === "group") {
    const row = await ctx.db.canvasGroup.findFirst({
      where: { id: args.id, workspaceId: ctx.workspaceId },
      select: { id: true, canvasId: true, lockedAt: true, hiddenAt: true },
    });
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Canvas group not found." });
    canvasId = row.canvasId;
    if ((row[col] !== null) === setBool) return;
    await ctx.db.canvasGroup.update({ where: { id: args.id }, data });
  } else if (args.kind === "instance") {
    const row = await ctx.db.canvasComponentInstance.findFirst({
      where: { id: args.id, workspaceId: ctx.workspaceId },
      select: { id: true, canvasId: true, lockedAt: true, hiddenAt: true },
    });
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Component instance not found." });
    canvasId = row.canvasId;
    if ((row[col] !== null) === setBool) return;
    await ctx.db.canvasComponentInstance.update({ where: { id: args.id }, data });
  }

  if (canvasId) {
    await ctx.db.workspaceCanvas.update({
      where: { id: canvasId },
      data: { updatedAt: new Date() },
    });
  }
}

// ---------------------------------------------------------------------------
// Server-side canvas templates
//
// Mirrors `src/components/canvas/canvas-templates.tsx` so the agent can drop
// a layout via MCP without round-tripping through the client. Kept inline
// rather than imported because the client module pulls Lucide icons +
// "use client" — neither belongs in a server router.
// ---------------------------------------------------------------------------

type ServerTemplateNode = {
  key: string;
  noteBody?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  lane?: string;
};
type ServerTemplateEdge = {
  from: string;
  to: string;
  label?: string;
  kind?: string;
};
type ServerCanvasTemplate = {
  nodes: ServerTemplateNode[];
  edges?: ServerTemplateEdge[];
};

const SERVER_NOTE_W = 220;
const SERVER_COL = 280;
const SERVER_ROW = 200;

const SERVER_CANVAS_TEMPLATES: Record<string, ServerCanvasTemplate> = {
  empty: { nodes: [] },
  decision_matrix: {
    nodes: [
      { key: "axis-x", noteBody: "**Effort →**", x: 200, y: -80, width: 200, height: 60 },
      { key: "axis-y", noteBody: "**Impact ↑**", x: -200, y: 200, width: 200, height: 60 },
      { key: "q1", noteBody: "**High impact · Low effort**\nQuick wins", x: 60, y: 60, lane: "Top-right" },
      { key: "q2", noteBody: "**High impact · High effort**\nBig bets", x: 320, y: 60, lane: "Top-right" },
      { key: "q3", noteBody: "**Low impact · Low effort**\nFill-in", x: 60, y: 320, lane: "Bottom" },
      { key: "q4", noteBody: "**Low impact · High effort**\nAvoid", x: 320, y: 320, lane: "Bottom" },
    ],
  },
  architecture: {
    nodes: [
      { key: "system", noteBody: "**System**\nName + one-line purpose.", x: 120, y: -40, width: 320, lane: "System" },
      { key: "c1", noteBody: "Component A\n_purpose_", x: -80, y: 200, lane: "Components" },
      { key: "c2", noteBody: "Component B\n_purpose_", x: 200, y: 200, lane: "Components" },
      { key: "c3", noteBody: "Component C\n_purpose_", x: 480, y: 200, lane: "Components" },
      { key: "d1", noteBody: "Dependency · external", x: -80, y: 440, lane: "Dependencies" },
      { key: "d2", noteBody: "Dependency · internal", x: 200, y: 440, lane: "Dependencies" },
      { key: "d3", noteBody: "Dependency · data", x: 480, y: 440, lane: "Dependencies" },
    ],
    edges: [
      { from: "system", to: "c1", kind: "contains" },
      { from: "system", to: "c2", kind: "contains" },
      { from: "system", to: "c3", kind: "contains" },
      { from: "c1", to: "d1", kind: "depends_on" },
      { from: "c2", to: "d2", kind: "depends_on" },
      { from: "c3", to: "d3", kind: "depends_on" },
    ],
  },
  standup: {
    nodes: [
      { key: "y-h", noteBody: "**Yesterday**", x: 0, y: -60, width: SERVER_NOTE_W, height: 50, lane: "Yesterday" },
      { key: "y1", noteBody: "Wrapped: …", x: 0, y: 40, lane: "Yesterday" },
      { key: "y2", noteBody: "Shipped: …", x: 0, y: 40 + SERVER_ROW, lane: "Yesterday" },
      { key: "t-h", noteBody: "**Today**", x: SERVER_COL, y: -60, width: SERVER_NOTE_W, height: 50, lane: "Today" },
      { key: "t1", noteBody: "Focus: …", x: SERVER_COL, y: 40, lane: "Today" },
      { key: "t2", noteBody: "Stretch: …", x: SERVER_COL, y: 40 + SERVER_ROW, lane: "Today" },
      { key: "b-h", noteBody: "**Blockers**", x: SERVER_COL * 2, y: -60, width: SERVER_NOTE_W, height: 50, lane: "Blockers" },
      { key: "b1", noteBody: "Waiting on: …", x: SERVER_COL * 2, y: 40, lane: "Blockers" },
    ],
  },
  retro: {
    nodes: [
      { key: "ww-h", noteBody: "**Went well**", x: 0, y: -60, width: SERVER_NOTE_W, height: 50, lane: "Went well" },
      { key: "ww1", noteBody: "Win: …", x: 0, y: 40, lane: "Went well" },
      { key: "dd-h", noteBody: "**Didn't go well**", x: SERVER_COL, y: -60, width: SERVER_NOTE_W, height: 50, lane: "Didn't" },
      { key: "dd1", noteBody: "Friction: …", x: SERVER_COL, y: 40, lane: "Didn't" },
      { key: "cb-h", noteBody: "**Confused by**", x: 0, y: 40 + SERVER_ROW, width: SERVER_NOTE_W, height: 50, lane: "Confused by" },
      { key: "cb1", noteBody: "Unclear: …", x: 0, y: 40 + SERVER_ROW + 100, lane: "Confused by" },
      { key: "ai-h", noteBody: "**Action items**", x: SERVER_COL, y: 40 + SERVER_ROW, width: SERVER_NOTE_W, height: 50, lane: "Action items" },
      { key: "ai1", noteBody: "[ ] Owner — task", x: SERVER_COL, y: 40 + SERVER_ROW + 100, lane: "Action items" },
    ],
  },
  okr_tree: {
    nodes: [
      { key: "obj", noteBody: "**Objective**\nThe outcome we want.", x: 200, y: -40, width: 320, lane: "Objective" },
      { key: "kr1", noteBody: "**KR 1**\nMeasure → target.", x: -80, y: 220, lane: "Key Results" },
      { key: "kr2", noteBody: "**KR 2**\nMeasure → target.", x: 200, y: 220, lane: "Key Results" },
      { key: "kr3", noteBody: "**KR 3**\nMeasure → target.", x: 480, y: 220, lane: "Key Results" },
      { key: "a1", noteBody: "Action: …", x: -80, y: 440, lane: "Actions" },
      { key: "a2", noteBody: "Action: …", x: 200, y: 440, lane: "Actions" },
      { key: "a3", noteBody: "Action: …", x: 480, y: 440, lane: "Actions" },
    ],
    edges: [
      { from: "obj", to: "kr1", kind: "contains" },
      { from: "obj", to: "kr2", kind: "contains" },
      { from: "obj", to: "kr3", kind: "contains" },
      { from: "kr1", to: "a1", kind: "contains" },
      { from: "kr2", to: "a2", kind: "contains" },
      { from: "kr3", to: "a3", kind: "contains" },
    ],
  },
};

// ---------------------------------------------------------------------------
// Layout algorithms (mutate-position helpers for the `layout` proc)
// ---------------------------------------------------------------------------

interface LayoutNode {
  id: string;
  x: number;
  y: number;
  targetType: string;
  targetId: string;
}
interface LayoutEdge {
  fromNodeId: string;
  toNodeId: string;
}
type LayoutPositions = Map<string, { x: number; y: number }>;

const LAYOUT_LAYER_X = 280;
const LAYOUT_ROW_Y = 160;
const LAYOUT_GRID_X = 240;
const LAYOUT_GRID_Y = 180;
const LAYOUT_FORCE_BOX = 4000;

function computeTopologicalLayout(nodes: LayoutNode[], edges: LayoutEdge[]): LayoutPositions {
  const adj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const n of nodes) {
    adj.set(n.id, []);
    inDeg.set(n.id, 0);
  }
  for (const e of edges) {
    if (!adj.has(e.fromNodeId) || !adj.has(e.toNodeId)) continue;
    adj.get(e.fromNodeId)!.push(e.toNodeId);
    inDeg.set(e.toNodeId, (inDeg.get(e.toNodeId) ?? 0) + 1);
  }
  // BFS layered by depth, seeded by all roots (inDeg 0). Cycle survivors
  // (still inDeg>0 after the BFS) get appended to depth=0 so they don't
  // disappear.
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const n of nodes) {
    if ((inDeg.get(n.id) ?? 0) === 0) {
      depth.set(n.id, 0);
      queue.push(n.id);
    }
  }
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur) ?? 0;
    for (const next of adj.get(cur) ?? []) {
      const nextD = depth.get(next);
      if (nextD === undefined || d + 1 > nextD) {
        depth.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0);

  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const list = byLayer.get(d) ?? [];
    list.push(n.id);
    byLayer.set(d, list);
  }
  // Stable sort within a layer by current y then id so the layout isn't
  // jittery across runs that share input.
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const list of byLayer.values()) {
    list.sort((a, b) => {
      const A = nodeById.get(a)!;
      const B = nodeById.get(b)!;
      if (A.y !== B.y) return A.y - B.y;
      return a.localeCompare(b);
    });
  }

  const positions: LayoutPositions = new Map();
  for (const [d, list] of byLayer.entries()) {
    list.forEach((id, idx) => {
      positions.set(id, { x: d * LAYOUT_LAYER_X, y: idx * LAYOUT_ROW_Y });
    });
  }
  return positions;
}

function computeGridLayout(nodes: LayoutNode[]): LayoutPositions {
  const sorted = [...nodes].sort((a, b) => {
    if (a.targetType !== b.targetType) return a.targetType.localeCompare(b.targetType);
    return a.targetId.localeCompare(b.targetId);
  });
  const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
  const positions: LayoutPositions = new Map();
  sorted.forEach((n, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    positions.set(n.id, { x: col * LAYOUT_GRID_X, y: row * LAYOUT_GRID_Y });
  });
  return positions;
}

/**
 * Fruchterman-Reingold over the existing geometry. Seeded from current
 * positions so a re-layout in "force" mode doesn't relocate already-
 * arranged content. Final positions are clamped to a 4000×4000 box so
 * even pathological graphs stay scrollable.
 */
function computeForceLayout(nodes: LayoutNode[], edges: LayoutEdge[]): LayoutPositions {
  const ITER = 50;
  const EDGE_LEN = 240;
  const W = LAYOUT_FORCE_BOX;
  const H = LAYOUT_FORCE_BOX;
  const area = W * H;
  const k = Math.sqrt(area / Math.max(1, nodes.length));
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) pos.set(n.id, { x: n.x, y: n.y });

  const cooled = (t: number) => Math.max(0.1, 1 - t / ITER) * (W / 10);

  for (let iter = 0; iter < ITER; iter++) {
    const disp = new Map<string, { x: number; y: number }>();
    for (const n of nodes) disp.set(n.id, { x: 0, y: 0 });
    // Repulsive: O(n²). Fine for canvas sizes we expect (<200 nodes).
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const pa = pos.get(a.id)!;
        const pb = pos.get(b.id)!;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const dist = Math.max(0.01, Math.hypot(dx, dy));
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        const da = disp.get(a.id)!;
        const db = disp.get(b.id)!;
        da.x += fx;
        da.y += fy;
        db.x -= fx;
        db.y -= fy;
      }
    }
    // Attractive (edges).
    for (const e of edges) {
      const pa = pos.get(e.fromNodeId);
      const pb = pos.get(e.toNodeId);
      if (!pa || !pb) continue;
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const dist = Math.max(0.01, Math.hypot(dx, dy));
      const force = (dist * dist) / EDGE_LEN;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      const da = disp.get(e.fromNodeId)!;
      const db = disp.get(e.toNodeId)!;
      da.x -= fx;
      da.y -= fy;
      db.x += fx;
      db.y += fy;
    }
    const temp = cooled(iter);
    for (const n of nodes) {
      const p = pos.get(n.id)!;
      const d = disp.get(n.id)!;
      const mag = Math.max(0.01, Math.hypot(d.x, d.y));
      p.x += (d.x / mag) * Math.min(mag, temp);
      p.y += (d.y / mag) * Math.min(mag, temp);
      // Clamp to box (centered around origin).
      p.x = Math.min(W / 2, Math.max(-W / 2, p.x));
      p.y = Math.min(H / 2, Math.max(-H / 2, p.y));
    }
  }
  return pos;
}

interface PlanStepForLayout {
  id: string;
  position: number;
  dependsOnStepIds: string[];
}

interface PlanLayout {
  positions: Map<string, { x: number; y: number }>;
}

/**
 * Longest-path depth per step → rows. Steps with no in-workspace
 * prerequisites land in depth 1 (depth 0 holds the plan node).
 * Cycles or stale refs collapse silently to the next safe depth so the
 * mutation never deadlocks.
 */
function computePlanLayout(steps: PlanStepForLayout[]): PlanLayout {
  const X_SPACING = 320;
  const Y_SPACING = 200;
  const PLAN_ROW_HEIGHT = Y_SPACING;

  const validIds = new Set(steps.map((s) => s.id));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const stepById = new Map(steps.map((s) => [s.id, s] as const));

  function depthFor(id: string): number {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      depth.set(id, 1);
      return 1;
    }
    visiting.add(id);
    const step = stepById.get(id);
    if (!step) {
      visiting.delete(id);
      depth.set(id, 1);
      return 1;
    }
    let best = 1;
    for (const dep of step.dependsOnStepIds) {
      if (!validIds.has(dep)) continue;
      best = Math.max(best, depthFor(dep) + 1);
    }
    visiting.delete(id);
    depth.set(id, best);
    return best;
  }

  for (const s of steps) depthFor(s.id);

  const byDepth = new Map<number, string[]>();
  for (const s of steps) {
    const d = depth.get(s.id) ?? 1;
    const list = byDepth.get(d) ?? [];
    list.push(s.id);
    byDepth.set(d, list);
  }
  for (const list of byDepth.values()) {
    list.sort((a, b) => {
      const pa = stepById.get(a)?.position ?? 0;
      const pb = stepById.get(b)?.position ?? 0;
      return pa - pb;
    });
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [d, list] of byDepth.entries()) {
    const rowWidth = list.length * X_SPACING;
    const startX = -((rowWidth - X_SPACING) / 2);
    list.forEach((id, idx) => {
      positions.set(id, {
        x: startX + idx * X_SPACING,
        y: PLAN_ROW_HEIGHT * d,
      });
    });
  }
  return { positions };
}
