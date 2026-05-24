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
 * How an interactive chat turn for this agent is actually served — the single
 * source of truth shared by the chat-stream route (which path to take) and the
 * chat UI (what to show / whether to warn). Resolving these together is what
 * keeps the header chip, the steering banner, and the route in agreement.
 *
 * Precedence (mirrors the route):
 *  1. **runs** — RUNS engine with a managed runs connector (Hermes,
 *     Codex app server). Forge streams the turn server-side.
 *  2. **completions** — COMPLETIONS engine with a configured chat model
 *     (env or a per-workspace ProviderCredential). Forge owns the loop.
 *  3. **dispatch** — no server model, but the agent is reachable via its
 *     runtime/daemon (per-agent webhook, a LOCAL_DAEMON runtime, or an
 *     ACP/local-daemon/webhook adapter). The daemon answers via chat drafts
 *     on the CHAT_MESSAGE_POSTED event — so the route must NOT also run a
 *     server loop (that would double-reply or error). Local ACP sessions and
 *     local CLIs land here.
 *  4. **none** — nothing can serve a chat turn; the composer warns.
 */
export type ChatTransportMode = "runs" | "completions" | "dispatch" | "none";

export type ChatReadiness = {
  ready: boolean;
  mode: ChatTransportMode;
  /** Effective provider after applying any per-thread override. */
  provider: AgentProvider;
  /** Short label for the runtime/transport serving chat (UI chip). */
  transportLabel: string;
  /** Short machine-ish reason code (for tests / telemetry). */
  reason:
    | "runs-connector"
    | "no-runs-connector"
    | "model-configured"
    | "dispatch-path"
    | "pull-act-only"
    | "no-model";
  /** Operator-facing guidance; empty/informational when ready. */
  hint: string;
};

export interface ChatReadinessInput {
  provider: AgentProvider;
  runEngine: RunEngine | null;
  runtime?: AgentRuntimeRef;
  providerOverride?: AgentProvider | null;
  /** Per-agent dispatch webhook, if any (a delivery path to the agent). */
  webhookUrl?: string | null;
  /** Runtime compute kind (LOCAL_DAEMON ⇒ the forge daemon hosts it). */
  runtimeKind?: string | null;
  /** True when an AGENT-kind ApiKey is linked to this agent (a daemon/runtime
   *  authenticates as it) — the strongest "daemon-served" signal. */
  daemonLinked?: boolean;
  /**
   * Predicate: is a chat model configured for this providerId? Defaults to the
   * env-based `isProviderAvailable`; the chat router passes a DB-aware
   * predicate so per-workspace `ProviderCredential` rows count as configured.
   */
  providerAvailable?: (providerId: string) => boolean;
}

export function resolveChatReadiness(input: ChatReadinessInput): ChatReadiness {
  const provider = input.providerOverride ?? input.provider;
  const engine = resolveRunEngine({
    runEngine: input.runEngine,
    provider,
    runtime: input.runtime,
  });
  const adapter = getRuntimeAdapter(input.runtime?.adapterKey);
  const isAvailable = input.providerAvailable ?? isProviderAvailable;

  // 1. RUNS with a server connector.
  if (engine === "RUNS") {
    const connector = getRunsConnectorForAgent({ provider, runtime: input.runtime });
    if (connector) {
      return {
        ready: true,
        mode: "runs",
        provider,
        transportLabel: runtimeLabel(input, adapter?.title) ?? "Runs",
        reason: "runs-connector",
        hint: "",
      };
    }
    // RUNS but no connector — still fall through to a dispatch path if one
    // exists, otherwise warn that a managed runtime must be attached.
    if (!hasDispatchPath(input, adapter)) {
      return {
        ready: false,
        mode: "none",
        provider,
        transportLabel: "—",
        reason: "no-runs-connector",
        hint:
          `This agent uses the Runs engine, but no managed runtime is attached ` +
          `to serve ${provider} as itself. Attach it to a chat-capable runtime ` +
          `(Hermes, or a Codex app server), or switch its engine to Streaming ` +
          `with a configured chat model.`,
      };
    }
  }

  // 2. COMPLETIONS with a configured model (server-owned loop).
  const providerId = providerIdFor(provider);
  if (engine === "COMPLETIONS" && isAvailable(providerId)) {
    return {
      ready: true,
      mode: "completions",
      provider,
      transportLabel: `Streaming · ${providerLabel(providerId)}`,
      reason: "model-configured",
      hint: "",
    };
  }

  // 3. Dispatch path — the agent's runtime/daemon answers via chat drafts.
  if (hasDispatchPath(input, adapter)) {
    return {
      ready: true,
      mode: "dispatch",
      provider,
      transportLabel: dispatchLabel(input, adapter),
      reason: "dispatch-path",
      hint:
        `Replies are delivered by this agent's ${dispatchLabel(input, adapter).toLowerCase()} ` +
        `(not a Forge-side model). Make sure it's running — the reply streams in ` +
        `once it responds.`,
    };
  }

  // 4. Nothing can serve a turn.
  const pullActOnly = adapter?.chatMode === "none";
  if (pullActOnly) {
    return {
      ready: false,
      mode: "none",
      provider,
      transportLabel: "—",
      reason: "pull-act-only",
      hint:
        `${adapter?.title ?? "This connection"} reaches Forge to read context ` +
        `and take actions — it isn't a chat backend, and no daemon is linked to ` +
        `it. To chat with this agent as itself, run its daemon / ACP session, or ` +
        `attach it to a chat-capable runtime (Hermes, or a Codex app server).`,
    };
  }
  return {
    ready: false,
    mode: "none",
    provider,
    transportLabel: "—",
    reason: "no-model",
    hint:
      `No chat model is configured for this agent's provider (${providerId}). ` +
      `Set its key (OPENAI_API_KEY / ANTHROPIC_API_KEY / FORGE_AI_BASE_URL), ` +
      `register one in Settings → Workspace → AI, or back the agent with a ` +
      `chat-capable runtime. It will not fall back to another platform.`,
  };
}

/** Is the agent reachable via a runtime/daemon delivery path (not a server loop)? */
function hasDispatchPath(
  input: ChatReadinessInput,
  adapter: ReturnType<typeof getRuntimeAdapter>,
): boolean {
  if (input.webhookUrl) return true;
  if (input.daemonLinked) return true;
  if (input.runtimeKind === "LOCAL_DAEMON") return true;
  const t = adapter?.transport;
  return t === "acp" || t === "local-daemon" || t === "webhook";
}

function dispatchLabel(
  input: ChatReadinessInput,
  adapter: ReturnType<typeof getRuntimeAdapter>,
): string {
  if (adapter?.transport === "acp") return "ACP session";
  if (adapter?.transport === "local-daemon" || input.runtimeKind === "LOCAL_DAEMON") {
    return "local daemon";
  }
  if (adapter?.title) return adapter.title;
  return input.webhookUrl ? "webhook runtime" : "runtime daemon";
}

function runtimeLabel(input: ChatReadinessInput, fallback?: string): string | null {
  return fallback ?? null;
}

function providerLabel(providerId: string): string {
  switch (providerId) {
    case "hermes":
      return "Hermes";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "custom":
      return "custom model";
    default:
      return providerId;
  }
}
