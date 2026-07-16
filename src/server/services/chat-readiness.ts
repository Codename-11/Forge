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
export type ChatTransportMode = "sessions" | "runs" | "completions" | "dispatch" | "none";

export type ChatRuntimeCapabilities = {
  /** Provider streams partial output back into the Forge chat surface. */
  streaming: boolean;
  /** Provider can surface explicit thinking/reasoning deltas. */
  thinking: boolean;
  /** Forge can surface tool calls inline for this turn. */
  tools: boolean;
  /** Tool calls can pause for operator approval in Forge. */
  approvals: boolean;
  /** The current turn can be stopped from the chat UI. */
  stop: boolean;
  /** The latest user turn can be replayed/retried. */
  retry: boolean;
  /** Attachments can be persisted and linked to chat turns. */
  files: boolean;
  /** Image attachments can be passed to the model/runtime as context. */
  vision: boolean;
  /** Runtime owns durable run state that Forge can inspect. */
  runs: boolean;
  /** Runtime answers asynchronously via dispatch/webhook/draft events. */
  dispatch: boolean;
  /** Slash commands and local chat controls are available. */
  commands: boolean;
  /** Forge can compact/summarize conversation context. */
  compact: boolean;
  /** Provider/runtime may carry profile memory or durable instructions. */
  memory: boolean;
  /** Forge can report connection/run/delivery diagnostics. */
  diagnostics: boolean;
};

export type ChatReadiness = {
  ready: boolean;
  mode: ChatTransportMode;
  /** Effective provider after applying any per-thread override. */
  provider: AgentProvider;
  /** Short label for the runtime/transport serving chat (UI chip). */
  transportLabel: string;
  /** Short machine-ish reason code (for tests / telemetry). */
  reason:
    | "sessions-connector"
    | "no-sessions-connector"
    | "runs-connector"
    | "no-runs-connector"
    | "runtime-probe-failed"
    | "model-configured"
    | "dispatch-path"
    | "pull-act-only"
    | "no-model";
  /** Provider-neutral capabilities the chat UI can safely expose. */
  capabilities: ChatRuntimeCapabilities;
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

  // Hermes interactive chat always uses the native Sessions API. An
  // environment-level `/v1/runs` connector is deliberately insufficient:
  // the runtime binding owns the durable tenant/session mapping and secret.
  if (provider === "HERMES" && input.runtime?.adapterKey === "hermes") {
    if (input.runtime.lastProbeAttempted && input.runtime.lastProbeReachable === false) {
      return {
        ready: false,
        mode: "sessions",
        provider,
        transportLabel: runtimeLabel(input, adapter?.title) ?? "Hermes Sessions",
        reason: "runtime-probe-failed",
        capabilities: chatCapabilities("sessions", provider, false, input, adapter),
        hint: `The attached Hermes runtime failed its last contract probe: ${input.runtime.lastProbeDetail || "probe did not succeed"}.`,
      };
    }
    return {
      ready: true,
      mode: "sessions",
      provider,
      transportLabel: runtimeLabel(input, adapter?.title) ?? "Hermes Sessions",
      reason: "sessions-connector",
      capabilities: chatCapabilities("sessions", provider, true, input, adapter),
      hint: "",
    };
  }
  if (provider === "HERMES") {
    return {
      ready: false,
      mode: "none",
      provider,
      transportLabel: "—",
      reason: "no-sessions-connector",
      capabilities: chatCapabilities("none", provider, false, input, adapter),
      hint:
        "Interactive Hermes chat requires a bound Hermes runtime that explicitly advertises native Sessions streaming. /v1/runs remains background-only.",
    };
  }

  // 1. RUNS with a server connector.
  if (engine === "RUNS") {
    const connector = getRunsConnectorForAgent({ provider, runtime: input.runtime });
    if (connector) {
      if (
        input.runtime?.lastProbeAttempted === true &&
        input.runtime.lastProbeReachable === false
      ) {
        return {
          ready: false,
          mode: "runs",
          provider,
          transportLabel: runtimeLabel(input, adapter?.title) ?? runsFallbackLabel(provider),
          reason: "runtime-probe-failed",
          capabilities: chatCapabilities("runs", provider, false, input, adapter),
          hint:
            `The attached runtime failed its last contract probe: ` +
            `${input.runtime.lastProbeDetail || "probe did not succeed"}. ` +
            `Verify the runtime connection before chatting.`,
        };
      }
      return {
        ready: true,
        mode: "runs",
        provider,
        transportLabel: runtimeLabel(input, adapter?.title) ?? runsFallbackLabel(provider),
        reason: "runs-connector",
        capabilities: chatCapabilities("runs", provider, true, input, adapter),
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
        capabilities: chatCapabilities("none", provider, false, input, adapter),
        hint: missingRunsConnectorHint(provider),
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
      capabilities: chatCapabilities("completions", provider, true, input, adapter),
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
      capabilities: chatCapabilities("dispatch", provider, true, input, adapter),
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
      capabilities: chatCapabilities("none", provider, false, input, adapter),
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
    capabilities: chatCapabilities("none", provider, false, input, adapter),
    hint: noModelHint(providerId),
  };
}

function chatCapabilities(
  mode: ChatTransportMode,
  provider: AgentProvider,
  ready: boolean,
  input: ChatReadinessInput,
  adapter: ReturnType<typeof getRuntimeAdapter>,
): ChatRuntimeCapabilities {
  const active = ready && mode !== "none";
  const forgeOwnedLoop =
    active && (mode === "sessions" || mode === "runs" || mode === "completions");
  const richRuntime = active && (provider === "HERMES" || provider === "CODEX");
  const dispatchStreaming =
    active &&
    mode === "dispatch" &&
    Boolean(
      input.daemonLinked ||
        input.runtimeKind === "LOCAL_DAEMON" ||
        adapter?.capabilities.streaming,
    );
  const runsApprovals =
    mode === "runs" &&
    (adapter?.capabilities.approvals ?? (provider === "HERMES" || provider === "CODEX"));
  return {
    streaming: active && (mode !== "dispatch" || dispatchStreaming),
    thinking: forgeOwnedLoop,
    tools: forgeOwnedLoop,
    approvals: active && (mode === "completions" || runsApprovals),
    stop: active && (mode === "runs" || mode === "completions"),
    retry: true,
    files: mode !== "sessions",
    // Structured Runs currently receive text/history only. Image blocks are
    // passed through the Forge-owned completions loop; dispatch runtimes own
    // their attachment ingestion and advertise it independently later.
    vision: active && mode === "completions",
    runs: active && mode === "runs",
    dispatch: active && mode === "dispatch",
    commands: true,
    compact: true,
    memory: richRuntime,
    diagnostics: true,
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
  const name = input.runtime?.name?.trim();
  return name || fallback || null;
}

function runsFallbackLabel(provider: AgentProvider): string {
  return provider === "HERMES" ? "Hermes env" : "Runs";
}

function missingRunsConnectorHint(provider: AgentProvider): string {
  if (provider === "HERMES") {
    return (
      `This Hermes agent uses the Runs engine, but no managed runtime is attached ` +
      `and the env fallback is not configured. Attach it to a Hermes runtime ` +
      `with endpoint + secret, set HERMES_GATEWAY_TOKEN, or explicitly allow ` +
      `an unauthenticated local gateway with HERMES_GATEWAY_ALLOW_UNAUTH=1.`
    );
  }
  return (
    `This agent uses the Runs engine, but no managed runtime is attached ` +
    `to serve ${provider} as itself. Attach it to a chat-capable runtime ` +
    `(Hermes, or a Codex app server), or switch its engine to Streaming ` +
    `with a configured chat model.`
  );
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

function noModelHint(providerId: string): string {
  if (providerId === "hermes") {
    return (
      `No Hermes chat model is configured. Set HERMES_GATEWAY_TOKEN, ` +
      `explicitly allow an unauthenticated local gateway with ` +
      `HERMES_GATEWAY_ALLOW_UNAUTH=1, register a Hermes credential in ` +
      `Settings → Workspace → AI, or back the agent with a chat-capable ` +
      `runtime. It will not fall back to another platform.`
    );
  }
  return (
    `No chat model is configured for this agent's provider (${providerId}). ` +
    `Set its key (OPENAI_API_KEY / ANTHROPIC_API_KEY / FORGE_AI_BASE_URL), ` +
    `register one in Settings → Workspace → AI, or back the agent with a ` +
    `chat-capable runtime. It will not fall back to another platform.`
  );
}
