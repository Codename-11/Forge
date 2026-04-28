import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { AgentProvider, RuntimeKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";

/**
 * Runtime registry. A Runtime is the compute environment that hosts one
 * or more agents — the multi-host primitive Forge gained alongside
 * `Agent` in 0018_runtime_and_token_usage.
 *
 * Surfaces:
 *   - LOCAL_DAEMON — `forge daemon` running on a user's machine. Polls
 *     Forge over SSE; no inbound webhook URL.
 *   - REMOTE_HTTP  — Hermes-style webhook receiver. `endpoint` carries
 *     the URL, `secret` the HMAC signing key.
 *   - CLOUD        — reserved for a future Forge-hosted runtime tier.
 *
 * The corresponding MCP tools (`runtimes.register`, `runtimes.heartbeat`)
 * live in `src/server/services/mcp.ts` and reuse the same shapes.
 */

const runtimeId = z.string().min(1).max(40);

const baseFields = {
  name: z.string().min(1).max(120),
  kind: z.nativeEnum(RuntimeKind),
  endpoint: z.string().url().max(500).optional().or(z.literal("")),
  providersAvailable: z.array(z.nativeEnum(AgentProvider)).max(16).default([]),
};

export const runtimeRouter = router({
  list: workspaceProcedure
    .input(
      z
        .object({ includeArchived: z.boolean().default(false) })
        .default({ includeArchived: false }),
    )
    .query(({ ctx, input }) =>
      ctx.db.runtime.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(input.includeArchived ? {} : { archivedAt: null }),
        },
        orderBy: [{ kind: "asc" }, { name: "asc" }],
        include: {
          owner: { select: { id: true, name: true, image: true } },
          _count: { select: { agents: true } },
        },
      }),
    ),

  byId: workspaceProcedure
    .input(z.object({ id: runtimeId }))
    .query(async ({ ctx, input }) => {
      const runtime = await ctx.db.runtime.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          owner: { select: { id: true, name: true, image: true } },
          agents: {
            select: {
              id: true,
              name: true,
              profileKey: true,
              avatar: true,
              status: true,
              provider: true,
              runtimeMode: true,
              lastHeartbeatAt: true,
            },
          },
        },
      });
      if (!runtime) throw new TRPCError({ code: "NOT_FOUND" });
      return runtime;
    }),

  register: workspaceProcedure
    .input(z.object(baseFields))
    .mutation(async ({ ctx, input }) => {
      // For LOCAL_DAEMON the daemon registers itself and owns the row;
      // for REMOTE_HTTP an admin typically registers it but the same
      // attribution holds. ownerId is set from the calling user.
      return ctx.db.runtime.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: input.name,
          kind: input.kind,
          endpoint: input.endpoint || null,
          providersAvailable: input.providersAvailable,
          ownerId: ctx.session.user.id,
          // LOCAL_DAEMON: "connected" the moment we register; REMOTE_HTTP
          // gets connectedAt only on real heartbeats.
          connectedAt:
            input.kind === RuntimeKind.LOCAL_DAEMON ? new Date() : null,
          heartbeatAt:
            input.kind === RuntimeKind.LOCAL_DAEMON ? new Date() : null,
        },
      });
    }),

  heartbeat: workspaceProcedure
    .input(z.object({ id: runtimeId }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.runtime.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, archivedAt: true },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (row.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Runtime is archived; cannot heartbeat.",
        });
      }
      return ctx.db.runtime.update({
        where: { id: row.id },
        data: { heartbeatAt: new Date() },
        select: { id: true, heartbeatAt: true },
      });
    }),

  archive: workspaceProcedure
    .input(z.object({ id: runtimeId }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.runtime.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.db.runtime.update({
        where: { id: row.id },
        data: { archivedAt: new Date() },
      });
    }),

  update: workspaceProcedure
    .input(
      z.object({
        id: runtimeId,
        name: z.string().min(1).max(120).optional(),
        providersAvailable: z
          .array(z.nativeEnum(AgentProvider))
          .max(16)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const row = await ctx.db.runtime.findFirst({
        where: { id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.db.runtime.update({
        where: { id: row.id },
        data: patch,
      });
    }),
});
