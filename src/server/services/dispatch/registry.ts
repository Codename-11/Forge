import "server-only";
import type { AgentProvider } from "@prisma/client";
import { defaultAdapterForProvider, getRuntimeAdapter } from "@/server/runtimes/adapters";
import { hermesRunsConnector, makeHermesRunsConnector } from "./hermes-runs";
import { makeCodexAppServerConnector } from "./codex-app-server";
import type { DispatchConnector, RunEngine } from "./types";

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
export function resolveRunEngine(agent: {
  runEngine: RunEngine | null;
  provider: AgentProvider;
  runtime?: AgentRuntimeRef;
}): RunEngine {
  if (agent.runEngine) return agent.runEngine;
  const attached = getRuntimeAdapter(agent.runtime?.adapterKey);
  if (attached) return attached.defaultRunEngine;
  return defaultAdapterForProvider(agent.provider)?.defaultRunEngine ?? "COMPLETIONS";
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
      return hermesRunsConnector;
    default:
      return null;
  }
}

export type AgentRuntimeRef = {
  adapterKey: string | null;
  endpoint: string | null;
  secret: string | null;
} | null | undefined;

/**
 * Runs connector for an agent, honoring a managed runtime's endpoint/secret
 * when present. A Hermes runtime with a configured `endpoint` targets that
 * specific gateway; otherwise we fall back to the env-based connector.
 *
 * Backfilled "(legacy webhook)" runtimes have their `endpoint` nulled in
 * migration 0060 (a Hermes runtime's endpoint must be the runs gateway base,
 * not the per-agent webhook URL 0018 put there), so they fall through to the
 * env gateway until an operator sets the real base in Settings → Runtimes.
 */
export function getRunsConnectorForAgent(agent: {
  provider: AgentProvider;
  runtime?: AgentRuntimeRef;
}): DispatchConnector | null {
  const rt = agent.runtime;
  if (rt && rt.endpoint) {
    if (rt.adapterKey === "hermes") {
      return makeHermesRunsConnector({ baseUrl: rt.endpoint, token: rt.secret });
    }
    if (rt.adapterKey === "codex-app-server") {
      // Codex app server (WebSocket JSON-RPC). Only resolvable when the
      // runtime carries a concrete ws(s):// endpoint.
      return makeCodexAppServerConnector({ baseUrl: rt.endpoint, token: rt.secret });
    }
  }
  return getRunsConnector(agent.provider);
}
