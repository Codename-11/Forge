import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { AgentProvider, RuntimeKind, type Runtime } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import {
  getRuntimeAdapter,
  managedAdapters,
  PLANNED_ADAPTERS,
} from "@/server/runtimes/adapters";
import { recordRuntimeHeartbeatPresence } from "@/server/services/heartbeat";
import { probeRuntime, type RuntimeProbeResult } from "@/server/services/dispatch/runtime-probe";
import {
  deriveRuntimeHealthStatus,
  sanitizeRuntimeProbeDetail,
} from "@/server/services/runtime-status";
import { validateRuntimeConfig } from "@/server/services/runtime-config";

/** Compute location a managed adapter's transport implies. */
function kindForAdapterTransport(transport: string): RuntimeKind {
  if (transport === "local-daemon") return RuntimeKind.LOCAL_DAEMON;
  // runs-api + app-server + webhook are all reached over the network from Forge.
  return RuntimeKind.REMOTE_HTTP;
}

/** Loopback / private-LAN host — plaintext transport is acceptable here. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.endsWith(".local") || h.endsWith(".internal"))
    return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // IPv6 ULA
  return false;
}

/**
 * Best-practice transport guard: a runtime endpoint reaching a **public**
 * host must use TLS (`https://` or `wss://`). Plaintext `http://` / `ws://`
 * is allowed only to loopback / private-LAN hosts (the internal-network case).
 * Secrets and agent traffic must never cross the public internet in the clear.
 */
function assertEndpointTransport(endpoint: string | null | undefined): void {
  if (!endpoint) return;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Endpoint must be a valid URL." });
  }
  const scheme = u.protocol.replace(/:$/, "");
  const secure = scheme === "https" || scheme === "wss";
  if (!secure && !isPrivateHost(u.hostname)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `External endpoints must use a secure transport — use wss:// or https:// (got ${scheme}:// to a public host "${u.hostname}"). Plaintext is allowed only for loopback / private-LAN hosts.`,
    });
  }
}

/** Never leak the HMAC secret to clients — surface only whether one is set. */
function redactRuntime<T extends Partial<Runtime>>(rt: T): Omit<T, "secret"> & { hasSecret: boolean } {
  const { secret, ...rest } = rt as T & { secret?: string | null };
  return { ...(rest as Omit<T, "secret">), hasSecret: !!secret };
}

type RuntimeForHealth = Pick<
  Runtime,
  | "kind"
  | "adapterKey"
  | "endpoint"
  | "archivedAt"
  | "disabledAt"
  | "heartbeatAt"
  | "connectedAt"
  | "lastProbeAt"
  | "lastProbeAttempted"
  | "lastProbeReachable"
  | "lastProbeDetail"
>;

function withRuntimeHealth<T extends Partial<Runtime> & RuntimeForHealth>(rt: T) {
  return {
    ...redactRuntime(rt),
    health: deriveRuntimeHealthStatus(rt),
  };
}

function probeData(res: RuntimeProbeResult, at = new Date()) {
  return {
    lastProbeAt: at,
    lastProbeAttempted: res.attempted,
    lastProbeReachable: res.reachable,
    lastProbeDetail: sanitizeRuntimeProbeDetail(res.detail),
  };
}

function shouldProbeHeartbeatCountAsRuntimeHeartbeat(rt: RuntimeForHealth): boolean {
  const adapter = getRuntimeAdapter(rt.adapterKey);
  return adapter?.transport === "app-server" && adapter.capabilities.presence === "runtime-heartbeat";
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
      return rows.map(withRuntimeHealth);
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
      return withRuntimeHealth(runtime);
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
        select: { id: true, archivedAt: true, adapterKey: true },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (row.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Runtime is archived; cannot heartbeat.",
        });
      }
      const now = new Date();
      const updated = await ctx.db.runtime.update({
        where: { id: row.id },
        data: { heartbeatAt: now },
        select: { id: true, heartbeatAt: true },
      });
      // For a runtime whose adapter derives presence from its own heartbeat
      // (the Forge local daemon), propagate liveness to the persistent agents
      // it hosts so they read true online/offline. Runtimes reached outbound
      // (Codex app server, webhooks) don't heartbeat, so their agents stay
      // on-demand — never reached here.
      const adapter = getRuntimeAdapter(row.adapterKey);
      if (adapter?.capabilities.presence === "runtime-heartbeat") {
        await recordRuntimeHeartbeatPresence(row.id, now, ctx.db);
      }
      return updated;
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
        config: z.record(z.unknown()).optional(),
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
      assertEndpointTransport(input.endpoint || null);
      const config = validateRuntimeConfig(adapter.key, input.config);
      const row = await ctx.db.runtime.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: input.name,
          adapterKey: adapter.key,
          kind: kindForAdapterTransport(adapter.transport),
          endpoint: input.endpoint || null,
          secret: input.secret || null,
          providersAvailable: input.providersAvailable ?? adapter.providers,
          config,
          ownerId: ctx.session.user.id,
        },
      });
      return withRuntimeHealth(row);
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
        config: z.record(z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, secret, endpoint, adapterKey, config, ...rest } = input;
      const row = await ctx.db.runtime.findFirst({
        where: { id, workspaceId: ctx.workspaceId },
        select: { id: true, adapterKey: true },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (adapterKey !== undefined && !getRuntimeAdapter(adapterKey)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown adapter key." });
      }
      if (endpoint) assertEndpointTransport(endpoint);
      // Validate against the effective adapter (incoming override or stored).
      const effectiveAdapter = adapterKey ?? row.adapterKey;
      const validatedConfig =
        config !== undefined ? validateRuntimeConfig(effectiveAdapter, config) : undefined;
      const updated = await ctx.db.runtime.update({
        where: { id: row.id },
        data: {
          ...rest,
          ...(adapterKey !== undefined ? { adapterKey } : {}),
          ...(endpoint !== undefined ? { endpoint: endpoint || null } : {}),
          // "" → keep; null → clear; non-empty → set.
          ...(secret === undefined ? {} : { secret: secret || null }),
          ...(validatedConfig !== undefined ? { config: validatedConfig } : {}),
        },
      });
      return withRuntimeHealth(updated);
    }),

  verifyConnection: workspaceProcedure
    .input(z.object({ id: runtimeId }))
    .mutation(async ({ ctx, input }) => {
      const runtime = await ctx.db.runtime.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      if (!runtime) throw new TRPCError({ code: "NOT_FOUND" });
      if (runtime.archivedAt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Runtime is archived; restore it before testing." });
      }
      const probe = await probeRuntime({
        adapterKey: runtime.adapterKey,
        endpoint: runtime.endpoint,
        secret: runtime.secret,
      });
      const now = new Date();
      const data = probeData(probe, now);
      const heartbeatData =
        probe.reachable && shouldProbeHeartbeatCountAsRuntimeHeartbeat(runtime)
          ? { heartbeatAt: now }
          : {};
      const updated = await ctx.db.runtime.update({
        where: { id: runtime.id },
        data: { ...data, ...heartbeatData },
      });
      if (probe.reachable && heartbeatData.heartbeatAt) {
        await recordRuntimeHeartbeatPresence(runtime.id, now, ctx.db);
      }
      const health = deriveRuntimeHealthStatus(updated);
      return {
        runtime: withRuntimeHealth(updated),
        probe: {
          attempted: probe.attempted,
          reachable: probe.reachable,
          detail: data.lastProbeDetail ?? probe.detail,
        },
        health,
      };
    }),

  /**
   * Pause / resume a runtime (the `disabledAt` kill-switch). Distinct from
   * `archive` (a reversible delete): disabling keeps the row configured and
   * visible but stops it dialing — dispatch skips it and chat reports
   * `[runtime disabled]` via the sentinel connector. Idempotent.
   */
  setEnabled: workspaceProcedure
    .input(z.object({ id: runtimeId, enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.runtime.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      const updated = await ctx.db.runtime.update({
        where: { id: row.id },
        data: { disabledAt: input.enabled ? null : new Date() },
      });
      return withRuntimeHealth(updated);
    }),

  /** Adapter catalog for the UI (managed runtimes are creatable). */
  adapters: workspaceProcedure.query(() =>
    managedAdapters().map((a) => ({
      key: a.key,
      title: a.title,
      tagline: a.tagline,
      iconKey: a.iconKey,
      transport: a.transport,
      chatMode: a.chatMode,
      multiAgent: a.multiAgent,
      providers: a.providers,
      capabilities: a.capabilities,
    })),
  ),

  /**
   * Declared-but-not-yet-connectable adapters (e.g. Codex app server, ACP).
   * Surfaced so the full tier model is discoverable in-product; not
   * creatable until their dispatch connector ships. See
   * `docs/agents/providers-and-transports.md`.
   */
  plannedAdapters: workspaceProcedure.query(() =>
    PLANNED_ADAPTERS.map((a) => ({
      key: a.key,
      title: a.title,
      transport: a.transport,
      chatMode: a.chatMode,
      managed: a.managed,
      note: a.note,
    })),
  ),
});
