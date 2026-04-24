import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Priority, type Prisma, type PrismaClient } from "@prisma/client";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";

/**
 * Dispatch rules — declarative routing layer consulted before the mode-
 * based auto-dispatch logic. Each rule pins a (priority?, labelId?,
 * projectId?) combination to a single `targetAgentId`. Null condition
 * columns are wildcards (match anything). Rules evaluate in
 * `order ASC, createdAt ASC`; first match wins. If the first matching
 * rule's target is ineligible, the dispatcher falls through to mode-
 * based selection rather than stalling.
 *
 * These are operational config, not sensitive — `list` is workspace-
 * wide so non-admin members can see how routing is configured, but all
 * mutations are admin-gated.
 */

const upsertShape = {
  name: z.string().min(1).max(120),
  priority: z.nativeEnum(Priority).nullable().optional(),
  labelId: z.string().cuid().nullable().optional(),
  projectId: z.string().cuid().nullable().optional(),
  targetAgentId: z.string().cuid(),
  order: z.number().int().min(0).max(100_000).optional(),
  enabled: z.boolean().optional(),
};

/**
 * Verify that a referenced (label / project / agent) row actually lives
 * in the caller's workspace, so callers can't plant cross-tenant FKs.
 */
async function assertInWorkspace(
  tx: PrismaClient | Prisma.TransactionClient,
  workspaceId: string,
  refs: { labelId?: string | null; projectId?: string | null; targetAgentId?: string },
): Promise<void> {
  if (refs.labelId) {
    const row = await tx.label.findFirst({
      where: { id: refs.labelId, workspaceId },
      select: { id: true },
    });
    if (!row) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Label not found in this workspace.",
      });
    }
  }
  if (refs.projectId) {
    const row = await tx.project.findFirst({
      where: { id: refs.projectId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!row) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Project not found in this workspace.",
      });
    }
  }
  if (refs.targetAgentId) {
    const row = await tx.agent.findFirst({
      where: { id: refs.targetAgentId, workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!row) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Agent not found (or archived) in this workspace.",
      });
    }
  }
}

export const dispatchRuleRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    return ctx.db.dispatchRule.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      include: {
        label: { select: { id: true, name: true, color: true } },
        project: { select: { id: true, name: true, key: true } },
        targetAgent: {
          select: { id: true, name: true, profileKey: true, avatar: true, status: true },
        },
      },
    });
  }),

  create: adminProcedure
    .input(z.object(upsertShape))
    .mutation(async ({ ctx, input }) => {
      await assertInWorkspace(ctx.db, ctx.workspaceId, {
        labelId: input.labelId ?? null,
        projectId: input.projectId ?? null,
        targetAgentId: input.targetAgentId,
      });
      // Auto-assign `order` to max+1 if omitted so new rules land at the
      // bottom of the list without manual bookkeeping.
      let order = input.order;
      if (order === undefined) {
        const last = await ctx.db.dispatchRule.findFirst({
          where: { workspaceId: ctx.workspaceId },
          orderBy: { order: "desc" },
          select: { order: true },
        });
        order = (last?.order ?? -1) + 1;
      }
      return ctx.db.dispatchRule.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: input.name.trim(),
          priority: input.priority ?? null,
          labelId: input.labelId ?? null,
          projectId: input.projectId ?? null,
          targetAgentId: input.targetAgentId,
          order,
          enabled: input.enabled ?? true,
        },
      });
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().min(1).max(120).optional(),
        priority: z.nativeEnum(Priority).nullable().optional(),
        labelId: z.string().cuid().nullable().optional(),
        projectId: z.string().cuid().nullable().optional(),
        targetAgentId: z.string().cuid().optional(),
        order: z.number().int().min(0).max(100_000).optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const row = await ctx.db.dispatchRule.findFirst({
        where: { id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      await assertInWorkspace(ctx.db, ctx.workspaceId, {
        labelId: patch.labelId,
        projectId: patch.projectId,
        targetAgentId: patch.targetAgentId,
      });
      // Normalize trimmed name; explicit null on condition fields clears
      // the wildcard constraint.
      const data: Record<string, unknown> = {};
      if (patch.name !== undefined) data.name = patch.name.trim();
      if (patch.priority !== undefined) data.priority = patch.priority;
      if (patch.labelId !== undefined) data.labelId = patch.labelId;
      if (patch.projectId !== undefined) data.projectId = patch.projectId;
      if (patch.targetAgentId !== undefined)
        data.targetAgentId = patch.targetAgentId;
      if (patch.order !== undefined) data.order = patch.order;
      if (patch.enabled !== undefined) data.enabled = patch.enabled;
      return ctx.db.dispatchRule.update({ where: { id }, data });
    }),

  reorder: adminProcedure
    .input(
      z.object({
        ids: z.array(z.string().cuid()).min(1).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const found = await tx.dispatchRule.findMany({
          where: { id: { in: input.ids }, workspaceId: ctx.workspaceId },
          select: { id: true },
        });
        if (found.length !== input.ids.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "One or more rules were not found in this workspace.",
          });
        }
        for (let i = 0; i < input.ids.length; i++) {
          await tx.dispatchRule.update({
            where: { id: input.ids[i]! },
            data: { order: i },
          });
        }
        return { ok: true, count: input.ids.length };
      });
    }),

  toggle: adminProcedure
    .input(z.object({ id: z.string().cuid(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.dispatchRule.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.db.dispatchRule.update({
        where: { id: input.id },
        data: { enabled: input.enabled },
      });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.dispatchRule.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.db.dispatchRule.delete({ where: { id: input.id } });
    }),
});
