import "server-only";
import type { AgentProvider, RunEngine } from "@prisma/client";
import { getRuntimeAdapter } from "@/server/runtimes/adapters";
import { isProviderAvailable } from "./ai-providers";
import { providerIdFor } from "./chat-stream";
import {
  getRunsConnectorForAgent,
  resolveRunEngine,
  type AgentRuntimeRef,
} from "./dispatch/registry";

/**
 * Will an interactive chat turn for this agent actually reach a model?
 *
 * Mirrors exactly what `/api/chat/stream` does at send time — resolve the
 * effective provider + engine, then check the same backend the stream would
 * use — so the UI can steer the operator *before* they send a message that
 * can only error. This is the "Codex CLI agent can't chat from an API key it
 * doesn't have" steering signal (deferred item 4 in the runtime-adapter ADR).
 *
 * - **RUNS** engine → a runs connector must resolve (a managed runtime owns
 *   the loop). Hermes always resolves via env fallback; a CODEX/CUSTOM agent
 *   with no managed runtime attached does not.
 * - **COMPLETIONS** engine → the provider's chat model must be configured
 *   (`isProviderAvailable`). Pull/act CLI connections (`chatMode: "none"`)
 *   get a tailored "attach a chat-capable runtime" hint rather than a bare
 *   "set an API key", because a key is not how you'd make them chat.
 */
export type ChatReadiness = {
  ready: boolean;
  mode: "runs" | "completions";
  /** Effective provider after applying any per-thread override. */
  provider: AgentProvider;
  /** Short machine-ish reason code (for tests / telemetry). */
  reason:
    | "runs-connector"
    | "no-runs-connector"
    | "model-configured"
    | "pull-act-only"
    | "no-model";
  /** Operator-facing guidance; empty when ready. */
  hint: string;
};

export function resolveChatReadiness(input: {
  provider: AgentProvider;
  runEngine: RunEngine | null;
  runtime?: AgentRuntimeRef;
  providerOverride?: AgentProvider | null;
}): ChatReadiness {
  const provider = input.providerOverride ?? input.provider;
  const engine = resolveRunEngine({
    runEngine: input.runEngine,
    provider,
    runtime: input.runtime,
  });
  const adapter = getRuntimeAdapter(input.runtime?.adapterKey);

  if (engine === "RUNS") {
    const connector = getRunsConnectorForAgent({ provider, runtime: input.runtime });
    if (connector) {
      return { ready: true, mode: "runs", provider, reason: "runs-connector", hint: "" };
    }
    return {
      ready: false,
      mode: "runs",
      provider,
      reason: "no-runs-connector",
      hint:
        `This agent uses the Runs engine, but no managed runtime is attached ` +
        `to serve ${provider} as itself. Attach it to a chat-capable runtime ` +
        `(Hermes today; a Codex app server / ACP session once available), or ` +
        `switch its engine to Streaming with a configured chat model.`,
    };
  }

  // COMPLETIONS — Forge owns the loop and needs a configured chat model.
  const providerId = providerIdFor(provider);
  if (isProviderAvailable(providerId)) {
    return { ready: true, mode: "completions", provider, reason: "model-configured", hint: "" };
  }

  const pullActOnly = adapter?.chatMode === "none";
  if (pullActOnly) {
    return {
      ready: false,
      mode: "completions",
      provider,
      reason: "pull-act-only",
      hint:
        `${adapter?.title ?? "This connection"} reaches Forge to read context ` +
        `and take actions — it isn't a chat backend, and it has no model key. ` +
        `To chat with this agent as itself, attach it to a chat-capable ` +
        `runtime (Hermes, or a Codex app server / ACP session once available).`,
    };
  }
  return {
    ready: false,
    mode: "completions",
    provider,
    reason: "no-model",
    hint:
      `No chat model is configured for this agent's provider (${providerId}). ` +
      `Set its key (OPENAI_API_KEY / ANTHROPIC_API_KEY / FORGE_AI_BASE_URL), or ` +
      `back the agent with a chat-capable runtime. It will not fall back to ` +
      `another platform.`,
  };
}
