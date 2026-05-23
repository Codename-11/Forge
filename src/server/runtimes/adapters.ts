import "server-only";
import type { AgentProvider, AgentRuntimeMode, RunEngine } from "@prisma/client";
import type { DispatchConnector } from "@/server/services/dispatch/types";

/**
 * Provider-agnostic **runtime adapter** registry.
 *
 * A `Runtime` row instances one of these adapters (via `Runtime.adapterKey`)
 * with a concrete endpoint + secret; agents attach to a runtime. The adapter
 * describes *capabilities* (who owns the loop, can it stream, presence model,
 * can it host multiple profiles) — none of which is provider-specific in
 * principle. "Hermes" is just the first `managed` adapter; the abstraction is
 * open to other managed platforms.
 *
 * Capabilities live here in code; the DB only stores which adapter a runtime
 * is plus its concrete connection config. See
 * `docs/plans/runtime-adapter-refactor.md`.
 */

/** How Forge sends work to a runtime. */
export type RuntimeTransport = "runs-api" | "webhook" | "mcp" | "local-daemon";

/** How Forge learns a runtime/agent is alive. */
export type PresenceModel = "runtime-heartbeat" | "session" | "delivery-derived";

export type AdapterKeyKind = "AGENT" | "PERSONAL" | "SESSION";

export interface RuntimeAdapter {
  /** Stable, provider-agnostic id — the value stored in `Runtime.adapterKey`. */
  key: string;
  title: string;
  tagline: string;
  /** Lucide icon name (UI maps it). */
  iconKey: string;
  /**
   * `true` = a managed runtime: owns the endpoint/secret, has runtime-level
   * presence, and (usually) hosts agents. `false` = a thin per-agent
   * connection (CLI/BYO) that plugs in with a key + optional webhook.
   */
  managed: boolean;
  /** Can a single runtime host more than one agent profile? */
  multiAgent: boolean;
  transport: RuntimeTransport;
  /** AgentProviders this adapter is valid for (compat + editor filtering). */
  providers: AgentProvider[];
  defaultRunEngine: RunEngine;
  defaultRuntimeMode: AgentRuntimeMode;
  defaultKeyKind: AdapterKeyKind;
  capabilities: {
    /** Streams chat token-by-token (draft startDraft/append/finalize). */
    streaming: boolean;
    /** Supports interactive approvals mid-run. */
    approvals: boolean;
    presence: PresenceModel;
  };
  /**
   * Build a runs connector bound to a concrete runtime's endpoint/secret.
   * Only set for `transport: "runs-api"`. Wired in Phase 3 — defining the
   * field now keeps the descriptor complete. Until then dispatch resolves
   * connectors the legacy way (env-based).
   */
  makeConnector?: (rt: { endpoint: string | null; secret: string | null }) => DispatchConnector | null;
  autoProvisionable: boolean;
  setupMarkdown: string;
  mcpSnippet?: string;
}

export const RUNTIME_ADAPTERS: RuntimeAdapter[] = [
  {
    key: "hermes",
    title: "Hermes",
    tagline: "Persistent daemon hosting multiple agent profiles. Owns the loop, streams, approves.",
    iconKey: "Server",
    managed: true,
    multiAgent: true,
    transport: "runs-api",
    providers: ["HERMES"],
    defaultRunEngine: "RUNS",
    defaultRuntimeMode: "PERSISTENT",
    defaultKeyKind: "AGENT",
    capabilities: { streaming: true, approvals: true, presence: "runtime-heartbeat" },
    autoProvisionable: false,
    setupMarkdown: `# Hermes (managed runtime)

A persistent daemon that hosts one or more agent profiles (Victor, Mizu, …)
behind a single gateway. It owns the agent loop (\`/v1/runs\`), streams chat
token-by-token, handles approvals, and reports presence.

**Connect the runtime once, attach profiles to it:**
1. Install Hermes and point this runtime's **endpoint** at the gateway base
   (e.g. \`http://127.0.0.1:8642/v1\`); set its **secret** to the gateway's
   \`API_SERVER_KEY\`.
2. For each profile, register an Agent and **attach it to this runtime**.
3. Generate an AGENT key with \`linkedAgentId\` per agent; set it as the
   profile's \`FORGE_API_KEY\`.
4. The \`forge-presence\` skill keeps runtime presence honest (cron poke to
   \`agents.heartbeat\`).`,
  },
  {
    key: "local-daemon",
    title: "Forge local daemon",
    tagline: "The `forge` CLI daemon — detects local CLIs (claude/codex/…) and dispatches over SSE.",
    iconKey: "TerminalSquare",
    managed: true,
    multiAgent: true,
    transport: "local-daemon",
    providers: ["CLAUDE", "CODEX", "CUSTOM", "HERMES"],
    defaultRunEngine: "COMPLETIONS",
    defaultRuntimeMode: "PERSISTENT",
    defaultKeyKind: "AGENT",
    capabilities: { streaming: true, approvals: false, presence: "runtime-heartbeat" },
    autoProvisionable: false,
    setupMarkdown: `# Forge local daemon (managed runtime)

\`forge daemon start\` registers this runtime over MCP, opens an SSE
subscription to Forge, and dispatches \`CHAT_MESSAGE_POSTED\` to a local CLI
(claude/codex/hermes/gemini/cursor-agent). Heartbeats every 60s.`,
  },
  {
    key: "claude-code",
    title: "Claude Code (session)",
    tagline: "Local Claude Code session — read-only project context. Thin MCP connection.",
    iconKey: "Terminal",
    managed: false,
    multiAgent: false,
    transport: "mcp",
    providers: ["CLAUDE"],
    defaultRunEngine: "COMPLETIONS",
    defaultRuntimeMode: "EPHEMERAL",
    defaultKeyKind: "SESSION",
    capabilities: { streaming: false, approvals: false, presence: "session" },
    autoProvisionable: true,
    setupMarkdown: `# Claude Code

Run a local Claude Code session that reads workspace context via MCP. Use a
SESSION key — it auto-expires.`,
    mcpSnippet: `claude mcp add forge --transport http --url \${FORGE_URL}/api/mcp --header "Authorization: Bearer \${apiKey}"`,
  },
  {
    key: "claude-desktop",
    title: "Claude Desktop",
    tagline: "Persistent Claude Desktop with MCP. Thin connection, key persists.",
    iconKey: "MonitorPlay",
    managed: false,
    multiAgent: false,
    transport: "mcp",
    providers: ["CLAUDE"],
    defaultRunEngine: "COMPLETIONS",
    defaultRuntimeMode: "PERSISTENT",
    defaultKeyKind: "PERSONAL",
    capabilities: { streaming: false, approvals: false, presence: "session" },
    autoProvisionable: true,
    setupMarkdown: `# Claude Desktop

Add Forge as an MCP server in \`claude_desktop_config.json\`. Use a PERSONAL key.`,
  },
  {
    key: "codex",
    title: "Codex CLI",
    tagline: "OpenAI Codex CLI — session-scoped key. Thin MCP connection.",
    iconKey: "Code2",
    managed: false,
    multiAgent: false,
    transport: "mcp",
    providers: ["CODEX"],
    defaultRunEngine: "COMPLETIONS",
    defaultRuntimeMode: "EPHEMERAL",
    defaultKeyKind: "SESSION",
    capabilities: { streaming: false, approvals: false, presence: "session" },
    autoProvisionable: true,
    setupMarkdown: `# Codex CLI

Generate a SESSION key, export it, and point Codex's MCP at Forge.`,
  },
  {
    key: "custom-http",
    title: "Custom (webhook)",
    tagline: "Bring your own runtime — register an agent + webhook URL.",
    iconKey: "Webhook",
    managed: false,
    multiAgent: false,
    transport: "webhook",
    providers: ["CUSTOM"],
    defaultRunEngine: "COMPLETIONS",
    defaultRuntimeMode: "PERSISTENT",
    defaultKeyKind: "AGENT",
    capabilities: { streaming: false, approvals: false, presence: "delivery-derived" },
    autoProvisionable: false,
    setupMarkdown: `# Custom integration

Any runtime that can receive Forge webhooks and call back via MCP with a
Bearer token. Register the Agent with its webhook URL + an AGENT key.`,
  },
];

export function getRuntimeAdapter(key: string | null | undefined): RuntimeAdapter | null {
  if (!key) return null;
  return RUNTIME_ADAPTERS.find((a) => a.key === key) ?? null;
}

/** Adapters compatible with a provider (managed first, then connections). */
export function runtimeAdaptersForProvider(provider: AgentProvider): RuntimeAdapter[] {
  return RUNTIME_ADAPTERS.filter((a) => a.providers.includes(provider)).sort(
    (a, b) => Number(b.managed) - Number(a.managed),
  );
}

/** Best default adapter for a provider — the first managed one, else the first. */
export function defaultAdapterForProvider(provider: AgentProvider): RuntimeAdapter | null {
  const matches = runtimeAdaptersForProvider(provider);
  return matches[0] ?? null;
}

/** Managed adapters only — the ones that get first-class Runtime rows. */
export function managedAdapters(): RuntimeAdapter[] {
  return RUNTIME_ADAPTERS.filter((a) => a.managed);
}

/**
 * Map a pre-adapterKey ("legacy") runtime to its adapter key, for the
 * migration backfill and for displaying older rows. Mirrors the SQL backfill
 * in migration 0059 so code and data agree.
 */
export function adapterKeyForLegacyRuntime(rt: {
  kind: string;
  providersAvailable: AgentProvider[];
}): string {
  if (rt.kind === "LOCAL_DAEMON") return "local-daemon";
  if (rt.kind === "REMOTE_HTTP") {
    if (rt.providersAvailable.includes("HERMES")) return "hermes";
    return "custom-http";
  }
  // CLOUD or anything unknown → treat as a custom managed endpoint.
  return "custom-http";
}
