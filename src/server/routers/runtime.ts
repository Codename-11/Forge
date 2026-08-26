import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  AgentProvider,
  RuntimeDiagnosticKind,
  RuntimeDiagnosticTrigger,
  RuntimeKind,
  type Runtime,
  type PrismaClient,
} from "@prisma/client";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";
import { encryptSecret } from "@/server/crypto";
import { getRuntimeAdapter, managedAdapters, PLANNED_ADAPTERS } from "@/server/runtimes/adapters";
import { recordRuntimeHeartbeatPresence } from "@/server/services/heartbeat";
import { summarizeRuntimeInfo } from "@/server/services/runtime-info";
import { deriveRuntimeHealthStatus } from "@/server/services/runtime-status";
import { runtimeConfigStatus, validateRuntimeConfig } from "@/server/services/runtime-config";
import { summarizeRuntimeSelfTest } from "@/server/services/runtime-self-test";
import {
  diagnosticResult,
  requestRuntimeDiagnostic,
  waitForRuntimeDiagnostic,
} from "@/server/services/runtime-diagnostics";

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
function redactRuntime<T extends Partial<Runtime>>(
  rt: T,
): Omit<T, "secret"> & { hasSecret: boolean } {
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
  | "runtimeInfo"
  | "lastInfoAt"
>;

type RuntimeForSelfTest = Pick<
  Runtime,
  | "adapterKey"
  | "lastSelfTestAt"
  | "lastSelfTestStatus"
  | "lastSelfTestDetail"
  | "lastSelfTestDurationMs"
>;

function withRuntimeHealth<T extends Partial<Runtime> & RuntimeForHealth & RuntimeForSelfTest>(
  rt: T,
) {
  return {
    ...redactRuntime(rt),
    health: deriveRuntimeHealthStatus(rt),
    configStatus: runtimeConfigStatus(rt.adapterKey, rt.config),
    selfTest: summarizeRuntimeSelfTest(rt),
    runtimeInfoSummary: summarizeRuntimeInfo(rt),
  };
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

/** Confirm a runtime belongs to the caller's workspace, or 404. */
async function assertRuntimeInWorkspace(
  db: PrismaClient,
  workspaceId: string,
  id: string,
): Promise<{ id: string }> {
  const rt = await db.runtime.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });
  if (!rt) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Runtime not found in this workspace." });
  }
  return rt;
}

/** Env var name shape (also the per-runtime secret key). */
const envVarKey = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Must be a valid environment variable name.");

/** A safe relative clone path (no leading slash, no `..`). */
const repoPath = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._\-/]+$/, "Relative path: letters, numbers, . _ - / only.")
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), {
    message: "Must be a relative path without '..'.",
  });

const baseFields = {
  name: z.string().min(1).max(120),
  kind: z.nativeEnum(RuntimeKind),
  endpoint: z.string().url().max(500).optional().or(z.literal("")),
  providersAvailable: z.array(z.nativeEnum(AgentProvider)).max(16).default([]),
};

export const runtimeRouter = router({
  list: workspaceProcedure
    .input(
      z.object({ includeArchived: z.boolean().default(false) }).default({ includeArchived: false }),
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

  byId: workspaceProcedure.input(z.object({ id: runtimeId })).query(async ({ ctx, input }) => {
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
        diagnosticAttempts: {
          orderBy: { createdAt: "desc" },
          take: 20,
        },
      },
    });
    if (!runtime) throw new TRPCError({ code: "NOT_FOUND" });
    return withRuntimeHealth(runtime);
  }),

  register: workspaceProcedure.input(z.object(baseFields)).mutation(async ({ ctx, input }) => {
    // Same transport guard as `create` / `update`: a REMOTE_HTTP endpoint
    // on a public host must use TLS. `register` previously skipped this, so
    // a plaintext public endpoint could slip in through this path.
    assertEndpointTransport(input.endpoint || null);
    const now = new Date();
    // LOCAL_DAEMON: "connected" the moment we register; REMOTE_HTTP gets
    // connectedAt only on real heartbeats.
    const liveTimes =
      input.kind === RuntimeKind.LOCAL_DAEMON ? { connectedAt: now, heartbeatAt: now } : {};
    // Upsert on the natural key (workspaceId + name + kind). There's no
    // unique index to Prisma-upsert against, and the daemon can lose its
    // cached runtime id (fresh clone / config wipe), so a plain create would
    // stack a duplicate row for the same host every re-register. Reuse a
    // non-archived match instead.
    const existing = await ctx.db.runtime.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        name: input.name,
        kind: input.kind,
        archivedAt: null,
      },
      select: { id: true },
    });
    if (existing) {
      return ctx.db.runtime.update({
        where: { id: existing.id },
        data: {
          endpoint: input.endpoint || null,
          providersAvailable: input.providersAvailable,
          ...liveTimes,
        },
      });
    }
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
        ...liveTimes,
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
  // Admin-gated: create/update write `config`, which carries the host tool
  // policy (whether an agent gets terminal/filesystem/git on the host). That's
  // a privilege-granting control, so it matches the ADMIN gate on this
  // runtime's secrets/repos and the MCP `runtimes.configure` mirror — rather
  // than the member-level `workspaceProcedure` used for daemon self-registration
  // (`register`) and read/diagnostic paths.
  create: adminProcedure
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

  update: adminProcedure
    .input(
      z.object({
        id: runtimeId,
        name: z.string().min(1).max(120).optional(),
        adapterKey: z.string().min(1).max(60).optional(),
        endpoint: z.string().url().max(500).nullable().optional().or(z.literal("")),
        // Empty string = leave the stored secret unchanged; explicit null clears it.
        secret: z.string().max(500).nullable().optional(),
        providersAvailable: z.array(z.nativeEnum(AgentProvider)).max(16).optional(),
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
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Runtime is archived; restore it before testing.",
        });
      }
      const requestId = await requestRuntimeDiagnostic({
        workspaceId: ctx.workspaceId,
        runtimeId: runtime.id,
        kind: RuntimeDiagnosticKind.PROBE,
        trigger: RuntimeDiagnosticTrigger.MANUAL_RUNTIME,
        requestedById: ctx.session.user.id,
      });
      let attempt;
      try {
        attempt = await waitForRuntimeDiagnostic(requestId, { timeoutMs: 15_000 });
      } catch (error) {
        throw new TRPCError({
          code: "TIMEOUT",
          message: error instanceof Error ? error.message : "Runtime diagnostic timed out.",
        });
      }
      const updated = await ctx.db.runtime.findUniqueOrThrow({ where: { id: runtime.id } });
      const health = deriveRuntimeHealthStatus(updated);
      return {
        runtime: withRuntimeHealth(updated),
        probe: diagnosticResult(attempt),
        health,
      };
    }),

  runSelfTest: workspaceProcedure
    .input(z.object({ id: runtimeId }))
    .mutation(async ({ ctx, input }) => {
      const runtime = await ctx.db.runtime.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      if (!runtime) throw new TRPCError({ code: "NOT_FOUND" });
      if (runtime.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Runtime is archived; restore it before running a self-test.",
        });
      }

      const requestId = await requestRuntimeDiagnostic({
        workspaceId: ctx.workspaceId,
        runtimeId: runtime.id,
        kind: RuntimeDiagnosticKind.SELF_TEST,
        trigger: RuntimeDiagnosticTrigger.MANUAL_RUNTIME,
        requestedById: ctx.session.user.id,
      });
      let attempt;
      try {
        attempt = await waitForRuntimeDiagnostic(requestId, { timeoutMs: 55_000 });
      } catch (error) {
        throw new TRPCError({
          code: "TIMEOUT",
          message: error instanceof Error ? error.message : "Runtime self-test timed out.",
        });
      }
      const updated = await ctx.db.runtime.findUniqueOrThrow({ where: { id: runtime.id } });
      const result = diagnosticResult(attempt);
      return {
        runtime: withRuntimeHealth(updated),
        selfTest: summarizeRuntimeSelfTest(updated),
        result,
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

  // ── Runtime secrets ──────────────────────────────────────────────────
  // Encrypted env injected into the runtime at provision time (gh/git tokens,
  // deploy creds, …). Values are WRITE-ONLY — never returned to any client.
  // The runtime fetches its own decrypted values via `runtimes.provisioning`.

  listSecrets: workspaceProcedure.input(z.object({ runtimeId })).query(async ({ ctx, input }) => {
    await assertRuntimeInWorkspace(ctx.db, ctx.workspaceId, input.runtimeId);
    // valueEnc is intentionally never selected — only key + metadata leave.
    return ctx.db.runtimeSecret.findMany({
      where: { runtimeId: input.runtimeId },
      orderBy: { key: "asc" },
      select: { id: true, key: true, description: true, createdAt: true, updatedAt: true },
    });
  }),

  setSecret: adminProcedure
    .input(
      z.object({
        runtimeId,
        key: envVarKey,
        value: z.string().min(1).max(20_000),
        description: z.string().trim().max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rt = await assertRuntimeInWorkspace(ctx.db, ctx.workspaceId, input.runtimeId);
      const valueEnc = encryptSecret(input.value);
      return ctx.db.runtimeSecret.upsert({
        where: { runtimeId_key: { runtimeId: rt.id, key: input.key } },
        create: {
          runtimeId: rt.id,
          workspaceId: ctx.workspaceId,
          key: input.key,
          valueEnc,
          description: input.description ?? null,
        },
        update: { valueEnc, description: input.description ?? null },
        select: { id: true, key: true, description: true, createdAt: true, updatedAt: true },
      });
    }),

  deleteSecret: adminProcedure
    .input(z.object({ runtimeId, key: envVarKey }))
    .mutation(async ({ ctx, input }) => {
      await assertRuntimeInWorkspace(ctx.db, ctx.workspaceId, input.runtimeId);
      await ctx.db.runtimeSecret.deleteMany({
        where: { runtimeId: input.runtimeId, key: input.key },
      });
      return { ok: true };
    }),

  // ── Runtime repos ────────────────────────────────────────────────────
  // Repositories the runtime materializes (clone-or-pull) into its workspace
  // so a dispatched agent lands in a ready checkout. Auth comes from secrets.

  listRepos: workspaceProcedure.input(z.object({ runtimeId })).query(async ({ ctx, input }) => {
    await assertRuntimeInWorkspace(ctx.db, ctx.workspaceId, input.runtimeId);
    return ctx.db.runtimeRepo.findMany({
      where: { runtimeId: input.runtimeId },
      orderBy: { path: "asc" },
      select: { id: true, url: true, branch: true, path: true, createdAt: true, updatedAt: true },
    });
  }),

  setRepo: adminProcedure
    .input(
      z.object({
        runtimeId,
        url: z.string().trim().min(1).max(500),
        branch: z.string().trim().max(200).optional(),
        path: repoPath,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rt = await assertRuntimeInWorkspace(ctx.db, ctx.workspaceId, input.runtimeId);
      return ctx.db.runtimeRepo.upsert({
        where: { runtimeId_path: { runtimeId: rt.id, path: input.path } },
        create: {
          runtimeId: rt.id,
          workspaceId: ctx.workspaceId,
          url: input.url,
          branch: input.branch || null,
          path: input.path,
        },
        update: { url: input.url, branch: input.branch || null },
        select: { id: true, url: true, branch: true, path: true, createdAt: true, updatedAt: true },
      });
    }),

  deleteRepo: adminProcedure
    .input(z.object({ runtimeId, id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertRuntimeInWorkspace(ctx.db, ctx.workspaceId, input.runtimeId);
      await ctx.db.runtimeRepo.deleteMany({
        where: { id: input.id, runtimeId: input.runtimeId },
      });
      return { ok: true };
    }),

  // ── Runtime GitHub App ───────────────────────────────────────────────
  // The recommended alternative to a static GH_TOKEN PAT: bind ONE GitHub
  // App, manage repo access in GitHub's UI, and Forge mints a short-lived
  // installation token into GH_TOKEN at provision time. The PEM private key
  // is write-only (encrypted at rest, never returned).

  // Which workspace GitHub App (if any) this runtime uses for git auth. Apps
  // are managed workspace-wide (see the `githubApp` router); a runtime just
  // links to one. Returns the linked app's metadata (never the PEM).
  getGithubApp: workspaceProcedure.input(z.object({ runtimeId })).query(async ({ ctx, input }) => {
    const rt = await ctx.db.runtime.findFirst({
      where: { id: input.runtimeId, workspaceId: ctx.workspaceId },
      select: {
        githubAppId: true,
        githubApp: {
          select: {
            id: true,
            name: true,
            appId: true,
            installationId: true,
            slug: true,
            lastMintedAt: true,
            lastError: true,
          },
        },
      },
    });
    if (!rt) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Runtime not found in this workspace." });
    }
    return rt.githubApp; // null = no app linked
  }),

  // Link this runtime to a workspace GitHub App (or pass null to unlink).
  linkGithubApp: adminProcedure
    .input(z.object({ runtimeId, githubAppId: z.string().min(1).max(40).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const rt = await assertRuntimeInWorkspace(ctx.db, ctx.workspaceId, input.runtimeId);
      if (input.githubAppId) {
        // Must be an app in the same workspace.
        const app = await ctx.db.githubApp.findFirst({
          where: { id: input.githubAppId, workspaceId: ctx.workspaceId },
          select: { id: true },
        });
        if (!app) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "GitHub App not found in this workspace.",
          });
        }
      }
      await ctx.db.runtime.update({
        where: { id: rt.id },
        data: { githubAppId: input.githubAppId },
      });
      return { ok: true };
    }),
});
