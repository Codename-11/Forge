import "server-only";
import type { AgentProvider } from "@prisma/client";
import { defaultAdapterForProvider, getRuntimeAdapter } from "@/server/runtimes/adapters";
import {
  hermesEnvRunsConfigured,
  hermesRunsConnector,
  makeHermesRunsConnector,
  parseHermesRuntimeConfig,
} from "./hermes-runs";
import {
  makeCodexAppServerConnector,
  parseCodexRuntimeConfig,
} from "./codex-app-server";
import { makeMockRunsConnector } from "./mock-runs";
import type { DispatchConnector, RunEngine, RunEvent } from "./types";

/**
 * Sentinel connector for a *disabled* runtime. A disabled runtime is paused,
 * not deleted: it stays configured and visible, but must not open a session.
 * Returning this (rather than `null`) keeps the engine resolving to RUNS so
 * the operator sees a clear `[runtime disabled]` message in chat / on the
 * `AgentRun` instead of a silent fallback to a different transport.
 */
function makeDisabledConnector(label: string): DispatchConnector {
  const reason = `Runtime "${label}" is disabled — enable it in Settings → Runtimes to dispatch.`;
  return {
    kind: "disabled",
    async startRun() {
      throw new Error(reason);
    },
    async subscribe(_id: string, onEvent: (e: RunEvent) => void) {
      onEvent({ type: "error", message: reason });
      onEvent({ type: "completed" });
    },
    async getStatus() {
      return { state: "failed" as const, output: reason };
    },
    async approve() {
      /* no live session to approve against */
    },
    async stop() {
      /* nothing running */
    },
  };
}

/**
 * Resolve the effective chat engine for an agent. Precedence:
 *   1. the agent's explicit `runEngine`, if set;
 *   2. the **attached runtime's** adapter default — so attaching an agent to
 *      a managed runs runtime (Hermes, Codex app server) makes it run as
 *      itself even when the provider's *default* adapter is a completions one
 *      (e.g. CODEX's default is the local daemon);
 *   3. the provider's default adapter;
 *   4. COMPLETIONS as a safe fallback.
 *
 * Canonical source is the provider-agnostic RuntimeAdapter registry
 * (`src/server/runtimes/adapters.ts`); the legacy integrations manifest is
 * deprecated.
 */
/** Free-form provenance for a resolved run engine (display-only, like triggerKind). */
export type RunEngineSource =
  | "agent-explicit"
  | "runtime-adapter"
  | "provider-default"
  | "fallback";

export interface ResolvedRunEngine {
  engine: RunEngine;
  source: RunEngineSource;
}

/**
 * Resolve the effective engine AND why (Phase 2). The engine value is frozen
 * onto `AgentRun.runEngine` at dispatch so run-scoped consumers don't re-resolve
 * against later config drift. Precedence mirrors `resolveRunEngine` exactly.
 */
export function resolveRunEngineWithSource(agent: {
  runEngine: RunEngine | null;
  provider: AgentProvider;
  runtime?: AgentRuntimeRef;
}): ResolvedRunEngine {
  if (agent.runEngine) return { engine: agent.runEngine, source: "agent-explicit" };
  const attached = getRuntimeAdapter(agent.runtime?.adapterKey);
  if (attached) return { engine: attached.defaultRunEngine, source: "runtime-adapter" };
  const provider = defaultAdapterForProvider(agent.provider)?.defaultRunEngine;
  if (provider) return { engine: provider, source: "provider-default" };
  return { engine: "COMPLETIONS", source: "fallback" };
}

export function resolveRunEngine(agent: {
  runEngine: RunEngine | null;
  provider: AgentProvider;
  runtime?: AgentRuntimeRef;
}): RunEngine {
  return resolveRunEngineWithSource(agent).engine;
}

/**
 * The structured-run connector for a provider, or null when the provider
 * has no runs API wired up (callers fall back to completions / webhook).
 * Only Hermes is implemented in the prototype; other providers slot in
 * here without touching call sites.
 */
export function getRunsConnector(provider: AgentProvider): DispatchConnector | null {
  switch (provider) {
    case "HERMES":
      return hermesEnvRunsConfigured() ? hermesRunsConnector : null;
    default:
      return null;
  }
}

export type AgentRuntimeRef = {
  adapterKey: string | null;
  endpoint: string | null;
  secret: string | null;
  lastProbeAttempted?: boolean | null;
  lastProbeReachable?: boolean | null;
  lastProbeDetail?: string | null;
  /** Sanitized, explicitly negotiated runtime protocol metadata. */
  runtimeInfo?: unknown;
  /** Adapter-specific config (`Runtime.config`); parsed per adapter. */
  config?: unknown;
  /** Set when the runtime is paused — see `makeDisabledConnector`. */
  disabledAt?: Date | null;
  /** For the disabled message; falls back to the adapter key. */
  name?: string | null;
} | null | undefined;

/**
 * Runs connector for an agent, honoring a managed runtime's endpoint/secret
 * when present. A Hermes runtime with a configured `endpoint` targets that
 * specific gateway; otherwise we fall back to the env-based connector.
 *
 * Backfilled "(legacy webhook)" runtimes have their `endpoint` nulled in
 * migration 0060 (a Hermes runtime's endpoint must be the runs gateway base,
 * not the per-agent webhook URL 0018 put there), so they fall through only
 * when the env gateway is explicitly configured. Otherwise chat reports that
 * a managed runtime must be attached instead of silently dialing localhost
 * with placeholder credentials.
 */
export function getRunsConnectorForAgent(agent: {
  provider: AgentProvider;
  runtime?: AgentRuntimeRef;
}): DispatchConnector | null {
  const rt = agent.runtime;
  // A paused runtime never dials, regardless of adapter — short-circuit to
  // the sentinel so chat/dispatch report it clearly.
  if (rt?.disabledAt) {
    return makeDisabledConnector(rt.name || rt.adapterKey || "runtime");
  }
  // E2E-only: an in-process scripted connector so the RUNS path (streaming +
  // approvals) is testable with no external runtime. Never resolves in prod.
  if (process.env.FORGE_E2E === "1" && rt?.adapterKey === "mock-runs") {
    return makeMockRunsConnector();
  }
  if (rt && rt.endpoint) {
    if (rt.adapterKey === "hermes") {
      const hermes = parseHermesRuntimeConfig(rt.config);
      return makeHermesRunsConnector({
        baseUrl: rt.endpoint,
        token: rt.secret,
        profile: hermes.profile,
        mode: hermes.mode,
        model: hermes.model,
        yoloMode: hermes.yoloMode,
      });
    }
    if (rt.adapterKey === "codex-app-server") {
      // Codex app server (WebSocket JSON-RPC). Only resolvable when the
      // runtime carries a concrete ws(s):// endpoint. `config` drives the
      // per-turn sandbox / approval / cwd overrides.
      const codex = parseCodexRuntimeConfig(rt.config);
      return makeCodexAppServerConnector({
        baseUrl: rt.endpoint,
        token: rt.secret,
        sandboxMode: codex.sandboxMode,
        approvalPolicy: codex.approvalPolicy,
        model: codex.model,
        yoloMode: codex.yoloMode,
        workspaceRoot: codex.workspaceRoot,
      });
    }
  }
  return getRunsConnector(agent.provider);
}
