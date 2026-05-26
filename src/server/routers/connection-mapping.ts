import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";

/**
 * Per-workspace **mappings** of a global Connection to concrete targets
 * (repo / channel / webhook). Identities live at the account level; the
 * workspace decides what they map to. Reads are workspace-scoped; writes
 * are admin-gated and require the caller to own the underlying
 * connection. Part of the multi-workspace restructure.
 */

const kindSchema = z.enum(["repo", "channel", "webhook"]);
const directionSchema = z.enum(["inbound", "outbound", "inbound+outbound"]);

export const connectionMappingRouter = router({
  /** Mappings in this workspace, grouped client-side by connection. */
  list: workspaceProcedure.query(async ({ ctx }) =>
    ctx.db.connectionMapping.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { createdAt: "asc" },
      include: {
        connection: { select: { id: true, provider: true, label: true, account: true, status: true } },
      },
    }),
  ),

  create: adminProcedure
    .input(
      z.object({
        connectionId: z.string().cuid(),
        kind: kindSchema,
        target: z.string().min(1).max(400),
        direction: directionSchema.default("inbound+outbound"),
        labelIds: z.array(z.string().cuid()).default([]),
        routeTo: z.string().max(200).optional(),
        config: z.record(z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const conn = await ctx.db.connection.findFirst({
        where: { id: input.connectionId, ownerId: ctx.session.user.id },
        select: { id: true },
      });
      if (!conn) throw new TRPCError({ code: "FORBIDDEN", message: "Map only your own connections." });
      return ctx.db.connectionMapping.create({
        data: {
          workspaceId: ctx.workspaceId,
          connectionId: input.connectionId,
          kind: input.kind,
          target: input.target,
          direction: input.direction,
          labelIds: input.labelIds,
          routeTo: input.routeTo,
          config: (input.config ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        target: z.string().min(1).max(400).optional(),
        direction: directionSchema.optional(),
        labelIds: z.array(z.string().cuid()).optional(),
        routeTo: z.string().max(200).nullish(),
        status: z.enum(["active", "paused"]).optional(),
        config: z.record(z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const owned = await ctx.db.connectionMapping.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!owned) throw new TRPCError({ code: "NOT_FOUND" });
      const { id, ...data } = input;
      return ctx.db.connectionMapping.update({
        where: { id },
        data: { ...data, config: (input.config ?? undefined) as Prisma.InputJsonValue | undefined },
      });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const owned = await ctx.db.connectionMapping.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!owned) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.db.connectionMapping.delete({ where: { id: input.id } });
    }),
});
