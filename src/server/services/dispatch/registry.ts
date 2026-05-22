import "server-only";
import type { AgentProvider } from "@prisma/client";
import { getIntegrationAdapter } from "@/server/integrations/adapters";
import { hermesRunsConnector } from "./hermes-runs";
import type { DispatchConnector, RunEngine } from "./types";

/**
 * Resolve the effective chat engine for an agent: its explicit
 * `runEngine` if set, otherwise the integration's `defaultRunEngine`
 * (falling back to COMPLETIONS for safety / unknown providers).
 */
export function resolveRunEngine(agent: {
  runEngine: RunEngine | null;
  provider: AgentProvider;
}): RunEngine {
  if (agent.runEngine) return agent.runEngine;
  return getIntegrationAdapter(agent.provider)?.defaultRunEngine ?? "COMPLETIONS";
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
