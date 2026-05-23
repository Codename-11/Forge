import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { AgentProvider, RuntimeKind, type Runtime } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { getRuntimeAdapter, managedAdapters } from "@/server/runtimes/adapters";

/** Compute location a managed adapter's transport implies. */
function kindForAdapterTransport(transport: string): RuntimeKind {
  if (transport === "local-daemon") return RuntimeKind.LOCAL_DAEMON;
  // runs-api + webhook are both reached over HTTP from Forge.
  return RuntimeKind.REMOTE_HTTP;
}

/** Never leak the HMAC secret to clients — surface only whether one is set. */
function redactRuntime<T extends Partial<Runtime>>(rt: T): Omit<T, "secret"> & { hasSecret: boolean } {
  const { secret, ...rest } = rt as T & { secret?: string | null };
  return { ...(rest as Omit<T, "secret">), hasSecret: !!secret };
}

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
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.runtime.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(input.includeArchived ? {} : { archivedAt: null }),
        },
        orderBy: [{ kind: "asc" }, { name: "asc" }],
        include: {
          owner: { select: { id: true, name: true, image: true } },
          _count: { select: { agents: true } },
        },
      });
      return rows.map(redactRuntime);
    }),

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
      return redactRuntime(runtime);
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

  /**
   * Inverse of `archive`. Clears `archivedAt` so the row reappears in
   * the active list and can heartbeat again. Idempotent — calling on a
   * row that's already active is a no-op (keeps existing `null`).
   */
  unarchive: workspaceProcedure
    .input(z.object({ id: runtimeId }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.runtime.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, archivedAt: true },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (!row.archivedAt) {
        // Already active — nothing to do, but return the row so the
        // caller can refresh its cached copy uniformly.
        return ctx.db.runtime.findUniqueOrThrow({ where: { id: row.id } });
      }
      return ctx.db.runtime.update({
        where: { id: row.id },
        data: { archivedAt: null },
      });
    }),

  /**
   * Create a *managed* runtime from an adapter (Hermes gateway, custom HTTP,
   * …). The compute `kind` is derived from the adapter's transport, so the
   * operator picks "what manages this" rather than a low-level kind. The
   * `forge` daemon still self-registers LOCAL_DAEMON rows via `register`.
   */
  create: workspaceProcedure
    .input(
      z.object({
        adapterKey: z.string().min(1).max(60),
        name: z.string().min(1).max(120),
        endpoint: z.string().url().max(500).optional().or(z.literal("")),
        secret: z.string().max(500).optional(),
        providersAvailable: z.array(z.nativeEnum(AgentProvider)).max(16).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const adapter = getRuntimeAdapter(input.adapterKey);
      if (!adapter || !adapter.managed) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Unknown or non-managed adapter. Only managed runtimes can be created here.",
        });
      }
      const row = await ctx.db.runtime.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: input.name,
          adapterKey: adapter.key,
          kind: kindForAdapterTransport(adapter.transport),
          endpoint: input.endpoint || null,
          secret: input.secret || null,
          providersAvailable: input.providersAvailable ?? adapter.providers,
          ownerId: ctx.session.user.id,
        },
      });
      return redactRuntime(row);
    }),

  update: workspaceProcedure
    .input(
      z.object({
        id: runtimeId,
        name: z.string().min(1).max(120).optional(),
        adapterKey: z.string().min(1).max(60).optional(),
        endpoint: z.string().url().max(500).nullable().optional().or(z.literal("")),
        // Empty string = leave the stored secret unchanged; explicit null clears it.
        secret: z.string().max(500).nullable().optional(),
        providersAvailable: z
          .array(z.nativeEnum(AgentProvider))
          .max(16)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, secret, endpoint, adapterKey, ...rest } = input;
      const row = await ctx.db.runtime.findFirst({
        where: { id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (adapterKey !== undefined && !getRuntimeAdapter(adapterKey)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown adapter key." });
      }
      const updated = await ctx.db.runtime.update({
        where: { id: row.id },
        data: {
          ...rest,
          ...(adapterKey !== undefined ? { adapterKey } : {}),
          ...(endpoint !== undefined ? { endpoint: endpoint || null } : {}),
          // "" → keep; null → clear; non-empty → set.
          ...(secret === undefined ? {} : { secret: secret || null }),
        },
      });
      return redactRuntime(updated);
    }),

  /** Adapter catalog for the UI (managed runtimes are creatable). */
  adapters: workspaceProcedure.query(() =>
    managedAdapters().map((a) => ({
      key: a.key,
      title: a.title,
      tagline: a.tagline,
      iconKey: a.iconKey,
      transport: a.transport,
      multiAgent: a.multiAgent,
      providers: a.providers,
      capabilities: a.capabilities,
    })),
  ),
});
