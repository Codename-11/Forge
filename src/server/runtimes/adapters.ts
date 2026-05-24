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

/**
 * How Forge sends work to a runtime, tiered low→high capability:
 *
 * - **`webhook`** / **`mcp`** — the *basic* tier. Forge pushes a webhook or
 *   the agent pulls/acts over MCP with a Bearer key. Fire-and-react; no
 *   Forge-driven interactive chat turn. Any runtime that can speak HTTP
 *   fits here.
 * - **`local-daemon`** — the `forge` CLI daemon: a managed SSE bridge that
 *   spawns a local CLI per event. Basic tier, locally hosted.
 * - **`acp`** — Agent Client Protocol session. A *mid* tier: a structured,
 *   bidirectional agent session (richer than fire-and-react MCP, lighter
 *   than a bespoke runs API). The portable way to drive CLIs like Claude
 *   Code / Codex / OpenCode as live agents without per-vendor wiring.
 *   Daemon-mediated (stdio) — see `forge` daemon `dispatch/acp.ts`.
 * - **`app-server`** — a vendor's own long-lived agent server (e.g. Codex's
 *   `app server`), analogous to how Hermes exposes `/v1/runs`. The *rich*
 *   tier for a specific vendor when ACP isn't enough. WebSocket JSON-RPC —
 *   see `dispatch/codex-app-server.ts`.
 * - **`runs-api`** — a managed runtime that owns the full agent loop and
 *   exposes a runs API + streaming + approvals (Hermes today). Richest tier.
 */
export type RuntimeTransport =
  | "runs-api"
  | "app-server"
  | "acp"
  | "webhook"
  | "mcp"
  | "local-daemon";

/**
 * How an agent on this adapter produces an *interactive chat* reply in Forge.
 *
 * This is the axis that the "Codex answered via Hermes" confusion lived on.
 * Forge has two fundamentally different ways to get a chat reply:
 *
 * - **`runs`** — a managed runtime owns the loop and streams the reply back
 *   (Hermes via `/v1/runs`; a future Codex `app-server`; ACP sessions). The
 *   agent answers *as itself* with its own memory/tools. No model API key in
 *   Forge — the runtime is the provider.
 * - **`completions`** — Forge owns the loop and calls an OpenAI-compatible
 *   endpoint with an API key / base URL. This is the **chat-only provider**
 *   concept (raw OpenAI / Anthropic / a custom gateway). It is deliberately
 *   **deferred** as its own first-class surface — no registry adapter ships
 *   with this mode yet; `streamChatReply` still supports it via env-configured
 *   `ai-providers`, but creating an agent whose chat depends on it is the
 *   thing we now surface a clear "no chat model configured" error for instead
 *   of silently falling back to another platform.
 * - **`acp`** — chat served over an Agent Client Protocol session (daemon-mediated).
 * - **`none`** — this connection does **not** serve interactive chat in Forge.
 *   It reads context and takes actions over MCP/webhook (pull/act), e.g. a
 *   Claude Code or Codex CLI session. To chat with such an agent, attach it
 *   to a chat-capable runtime (Hermes / app-server / ACP) — don't expect it
 *   to answer from an API key it doesn't have.
 */
export type ChatMode = "runs" | "completions" | "acp" | "none";

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
  /**
   * How an agent on this adapter produces an interactive chat reply. Drives
   * editor/onboarding copy and lets chat warn (instead of silently failing)
   * when an agent's connection can't actually serve chat. See {@link ChatMode}.
   */
  chatMode: ChatMode;
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
    chatMode: "runs",
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
    // The daemon spawns a local CLI that streams its reply back via chat
    // drafts — the CLI owns the turn, so this is a runs-style chat path
    // (not a Forge-owned completions loop), even though dispatched work
    // still defaults to the COMPLETIONS engine for now.
    chatMode: "runs",
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
    key: "codex-app-server",
    title: "Codex (app server)",
    tagline:
      "OpenAI Codex's long-lived app server over WebSocket JSON-RPC. Managed runtime — a Codex agent chats as itself, like Hermes.",
    iconKey: "Code2",
    managed: true,
    multiAgent: false,
    transport: "app-server",
    chatMode: "runs",
    providers: ["CODEX"],
    defaultRunEngine: "RUNS",
    defaultRuntimeMode: "PERSISTENT",
    defaultKeyKind: "AGENT",
    capabilities: { streaming: true, approvals: true, presence: "runtime-heartbeat" },
    autoProvisionable: false,
    setupMarkdown: `# Codex app server (managed runtime)

OpenAI's \`codex app-server\` is a long-lived process speaking bidirectional
JSON-RPC 2.0 — the same surface that powers the Codex web/desktop/VS Code
clients. Running it with a network listener makes a Codex agent **first-class**
in Forge (owns the loop, streams, approvals), the OpenAI analogue to Hermes.

**Connect:**
1. \`codex app-server\` speaks **stdio** only (no \`--listen\` flag), so a small
   **stdio↔WebSocket bridge** sits in front of it. The reference deployment runs
   that bridge in a container (\`~/docker/codex-bridge/\`) so the agent is
   sandboxed to a scoped \`/work\` and can't reach the host filesystem. Run the
   bridge (publishes \`ws://HOST:4505\`); external hosts MUST use \`wss://\` (TLS).
2. Add a runtime here with this adapter; set **endpoint** to the
   \`ws(s)://HOST:PORT\` URL and (if your deployment gates the socket) a
   **secret** sent as a Bearer header.
3. Register a Codex Agent and **attach it to this runtime**. It defaults to the
   Runs engine, so it chats as itself with its own tools + approvals.
4. (Optional) Set **sandbox mode** + **approval policy** + **workspace root** on
   the runtime — the connector sends them per turn (defaults: full access, no
   prompts). Use **Disable** to pause the runtime without deleting it.

Pin exact method shapes with \`codex app-server generate-ts --out <dir>\`.`,
  },
  {
    key: "claude-code",
    title: "Claude Code (session)",
    tagline: "Local Claude Code session — reads context and acts over MCP. Pull/act, not chat.",
    iconKey: "Terminal",
    managed: false,
    multiAgent: false,
    transport: "mcp",
    chatMode: "none",
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
    tagline: "Persistent Claude Desktop with MCP. Pull/act connection, key persists.",
    iconKey: "MonitorPlay",
    managed: false,
    multiAgent: false,
    transport: "mcp",
    chatMode: "none",
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
    tagline: "OpenAI Codex CLI — reads context and acts over MCP. Pull/act, not chat.",
    iconKey: "Code2",
    managed: false,
    multiAgent: false,
    transport: "mcp",
    chatMode: "none",
    providers: ["CODEX"],
    defaultRunEngine: "COMPLETIONS",
    defaultRuntimeMode: "EPHEMERAL",
    defaultKeyKind: "SESSION",
    capabilities: { streaming: false, approvals: false, presence: "session" },
    autoProvisionable: true,
    setupMarkdown: `# Codex CLI (pull/act connection)

Generate a SESSION key, export it, and point Codex's MCP at Forge. In this
mode Codex reads workspace context and takes actions — it does **not** answer
Forge chat from an API key. To chat with a Codex agent as itself, back it with
a chat-capable runtime: a Codex **app server** (\`app-server\` transport) or an
**ACP** session (both planned — see the runtime-adapter ADR), the same way
Hermes agents chat via \`/v1/runs\`.`,
  },
  {
    key: "acp",
    title: "ACP session (CLI)",
    tagline:
      "Drive a local agent CLI (Claude Code, Codex, OpenCode, …) as a live agent over the Agent Client Protocol. Daemon-mediated; chats as itself while the session is active.",
    iconKey: "TerminalSquare",
    managed: false,
    multiAgent: false,
    transport: "acp",
    chatMode: "acp",
    providers: ["CLAUDE", "CODEX", "CUSTOM"],
    defaultRunEngine: "COMPLETIONS",
    defaultRuntimeMode: "EPHEMERAL",
    defaultKeyKind: "AGENT",
    capabilities: { streaming: true, approvals: true, presence: "session" },
    autoProvisionable: false,
    setupMarkdown: `# ACP session (Agent Client Protocol)

The portable, multi-vendor way to run a local agent CLI as a live agent —
no per-vendor flag wiring. ACP is JSON-RPC 2.0 over the agent's stdio, so it's
**daemon-mediated**: the \`forge daemon\` spawns the agent and bridges its
\`session/update\` stream onto Forge chat.

**Enable on the daemon host:**
\`\`\`bash
# Point the daemon at any ACP-capable agent command:
export FORGE_ACP_CMD="claude-code-acp"   # or "codex acp", "opencode acp", …
forge daemon start
\`\`\`
When set, the daemon prefers ACP for chat dispatch (Tier 2 — full power while
the session is live). Unset → the per-vendor adapters are used. To make such an
agent a *first-class* always-on member instead, back it with a managed runtime
(Hermes, or the Codex app server).`,
  },
  {
    key: "custom-http",
    title: "Custom (webhook)",
    tagline: "Bring your own runtime — register an agent + webhook URL.",
    iconKey: "Webhook",
    managed: false,
    multiAgent: false,
    transport: "webhook",
    // A webhook runtime *may* reply by calling chat.appendMessage/drafts back,
    // but Forge doesn't drive an interactive turn for it — treat as pull/act.
    chatMode: "none",
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
 * Does this adapter serve interactive Forge chat on its own? `false` for
 * pull/act connections (`chatMode: "none"`) — the UI uses this to steer the
 * operator toward attaching a chat-capable runtime instead of presenting a
 * chat composer that can only error.
 */
export function adapterServesChat(adapter: RuntimeAdapter | null | undefined): boolean {
  return adapter ? adapter.chatMode !== "none" : false;
}

/**
 * Planned adapters — declared here as documentation so the taxonomy is
 * discoverable in one place. They are intentionally NOT in
 * `RUNTIME_ADAPTERS` yet (no dispatch connector), so they don't appear in
 * the editor or shift `defaultAdapterForProvider`. Promote an entry into the
 * array once its connector lands. See `docs/plans/runtime-adapter-refactor.md`.
 */
export const PLANNED_ADAPTERS: ReadonlyArray<
  Pick<RuntimeAdapter, "key" | "title" | "transport" | "chatMode" | "managed"> & {
    note: string;
  }
> = [
  // (Empty.) Both originally-planned adapters now ship as real entries in
  // RUNTIME_ADAPTERS: `codex-app-server` (managed runs connector) and `acp`
  // (daemon-mediated session connection). Kept as an extension point.
];

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
