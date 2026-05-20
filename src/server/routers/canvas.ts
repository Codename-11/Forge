import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { ArtifactType, EventKind, ExecutionPlanStatus, type Prisma, type PrismaClient } from "@prisma/client";
import { nanoid } from "nanoid";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { forgeEntityTypeSchema } from "@/lib/entity-ref";
import { hydrateEntityRefs, type HydratedEntityRef } from "@/server/services/entity-hydration";
import { createArtifact } from "@/server/services/artifact-service";
import { publish } from "@/server/realtime";

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
          userId: ctx.session?.user?.id ?? null,
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
});

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
