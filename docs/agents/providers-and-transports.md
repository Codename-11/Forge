# Agents, Tiers & Transports

Forge talks to agents in a few fundamentally different ways. This page lays
out the tiers so it's clear what each kind of agent can do, when it's
available, and how chat is served — and why a Codex CLI session must **not**
"answer via Hermes" (right persona, wrong platform).

There are two independent axes:

- **Tier** — *how reachable and how rich* the connection is (presence +
  transport). First-class managed runtime → session CLI → basic webhook.
- **Engine** — *who owns the agent loop* for a chat turn: **Runs** (the
  runtime) or **Streaming/Completions** (Forge). Orthogonal to tier; see
  [Chat & Dispatch Engines](./engines.md).

## Tier 1 — First-class agents (managed runtimes)

The agent is a **full workspace member**: always-on presence, realtime chat,
orchestration, issues, and dispatched work. Forge holds **no model API key** —
the runtime runs the model; the agent answers *as itself*.

- **Hermes** — persistent daemon hosting multiple profiles (Victor, Mizu)
  behind one gateway (`/v1/runs`). Owns the loop, streams, approvals,
  runtime-level presence. `chatMode: "runs"`. Repo tools are a runtime
  declaration, not an engagement-mode setting: configure the Hermes gateway
  profile with terminal/filesystem/git access first, then declare
  `localWorkspaceTools`, `toolCapabilities`, and `workspaceRoot` on the
  Runtime in Settings or with `forge runtimes configure`.
- **Codex (app server)** — Codex's long-lived `app server` (stdio JSON-RPC),
  the OpenAI analogue to the Hermes gateway: a managed runtime so a Codex
  agent is first-class exactly like a Hermes profile. `chatMode: "runs"`,
  `transport: "app-server"`. Forge dials a WebSocket, so a small **stdio↔ws
  bridge** sits in front of `codex app-server` (it has no `--listen ws://`
  flag). The reference deployment runs that bridge in a container
  (`~/docker/codex-bridge/` on docker-server) so the agent is sandboxed to a
  scoped workspace; add a runtime pointing at the bridge's `ws(s)://` URL
  (Settings → Runtimes). **Sandbox + approvals are configurable per runtime**
  — see [Codex sandboxing](#codex-sandboxing--approvals) below.

**Engine choice (per agent):**

| | **Runs** (recommended) | **Streaming** (Completions) |
|---|---|---|
| Loop owner | The runtime | Forge |
| Agent memory / persona / commands | **Preserved** — runs as itself | None (stateless) |
| Tools | The agent's own | Forge's chat allowlist + approvals |
| Same engine as dispatched work | Yes | No |
| Latency | Slightly higher | Lowest |
| Model | Provider-native | Any OpenAI-compatible |

We default first-class agents to **Runs** so Hermes/Codex keep their memory,
session, and native commands. Flip to **Streaming** only for a stateless
utility assistant where identity doesn't matter — and note it needs a
configured chat model (see Tier-1 streaming backend below). Full pros/cons:
[engines.md](./engines.md).

## Tier 2 — Session connectors (CLI)

Local CLIs: **Claude Code**, **Codex CLI**, **OpenCode**. **Full
functionality while the session is active**, but **ephemeral presence** — not
always online. Best for in-session, active work rather than always-on duty.

- **ACP** — Agent Client Protocol: a portable, bidirectional agent session.
  The CLI chats *as itself* while live, with no per-vendor wiring.
  `transport: "acp"`, `chatMode: "acp"`. **Daemon-mediated** (ACP is stdio
  JSON-RPC): on the daemon host set `FORGE_ACP_CMD="<agent> acp"` (e.g.
  `claude-code-acp`, `codex acp`, `opencode acp`) and run `forge daemon start`
  — the daemon then drives chat over ACP for any provider. Unset → the
  per-vendor adapters are used. So ACP is opt-in and flexible.
- **MCP (pull/act, today)** — the CLI connects over MCP with a Bearer key to
  **read context and take actions**. It does **not** serve an interactive chat
  turn (`chatMode: "none"`) — it has no model key and isn't a chat backend.
  Chatting with such an agent shows a "no chat model configured" notice *by
  design*; to chat with it as itself, give it an ACP session or promote it to
  a first-class app-server runtime.

The `forge` **local daemon** is a managed bridge in this tier: `forge daemon
start` registers over MCP, opens an SSE subscription, and spawns the detected
local CLI per event, streaming replies back via chat drafts.

## Tier 3 — Basic connectors

`webhook` / `http`. Any runtime that can receive a Forge webhook (or be polled)
and call back over MCP with a Bearer token. Fire-and-react; no Forge-driven
chat turn (`chatMode: "none"`). The lowest common denominator for bring-your-own
runtimes.

## At a glance

| Tier | Examples | Transport | Presence | Chat | Best for |
|------|----------|-----------|----------|------|----------|
| 1 — First-class | Hermes, Codex app server | `runs-api`, `app-server` | Always-on | Runs (or Streaming) | Full members: chat + dispatch + orchestration |
| 2 — Session CLI | Claude Code, Codex CLI, OpenCode | `acp`, `mcp`, `local-daemon` | Session/ephemeral | ACP (as itself) or pull/act | In-session active work |
| 3 — Basic | Custom bot | `webhook`, `http` | Delivery-derived | None | BYO integrations |

## Codex sandboxing & approvals

A Codex app-server runtime touches a real filesystem, so its blast radius is
controlled on **two layers**:

1. **The bridge container is the hard boundary.** The reference bridge
   (`~/docker/codex-bridge/`) mounts only the operator's Codex *auth*
   (read-only) and a single scoped workspace (`/work`). The host filesystem is
   unreachable from inside, so even a full-access Codex turn can't read host
   secrets. This is fixed by the deployment, not a per-runtime setting.
2. **Per-turn sandbox + approval policy, set in Forge.** Each Codex runtime
   carries a config the connector sends with every turn (codex-cli's
   `sandboxPolicy` / `approvalPolicy` / `cwd` overrides). Edit it in
   **Settings → Runtimes → (the Codex runtime) → Codex sandbox**:

   | Field | Values | Effect |
   |-------|--------|--------|
   | **Sandbox mode** | `Full access` · `Workspace-write` · `Read-only` | OS-level file/network scope. Workspace-write limits writes to the workspace root. |
   | **Approval policy** | `Never` · `On request` · `On failure` · `Untrusted` | Anything but `Never` makes Codex raise an approval before risky commands/edits — Forge renders these as **accept/deny cards in chat**. |
   | **Workspace root** | a path, e.g. `/work/agent-forge` | The turn's working dir; in workspace-write it's the only writable root. Setting it also makes Forge declare the Codex runtime as having repo tools for preflight and runtime cards. |

   Defaults (no config) = **full access, no prompts** — the original behavior.
   Forge tightens this per run: non-Execute dispatches (Research, Review, and
   Discuss) are sent to Codex with a read-only sandbox even if the runtime's
   default sandbox is broader. Execute runs use the configured sandbox/approval
   policy.

**Disable without deleting.** Each runtime has an **Enable/Disable** toggle
(distinct from Archive, which hides/deletes). A disabled runtime stays
configured but won't dial: dispatch skips it and chat reports
`[runtime disabled]`. Use it as a kill-switch for a host-touching runtime.

## Two kinds of "provider", and the chat-only model backend

- **Agent/runtime providers** (all of the above) — the agent is the provider;
  no Forge-held API key. Reached via a transport tier.
- **Chat-only model backends** — raw OpenAI-compatible model access via API
  key/base URL (plain OpenAI/Anthropic/custom gateway). This is the **backend
  the Streaming engine calls**. Configure it per-workspace in **Settings →
  Workspace → AI → Model credentials** (key encrypted at rest) — a stored
  credential takes precedence over the `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
  / `FORGE_AI_BASE_URL` environment fallback, so Streaming works with no env
  config. Forge never lets a first-class agent silently borrow another
  platform's model — an unconfigured Streaming backend yields a clear "no chat
  model configured" notice that links to the credential UI.

## Where this lives in code

- Taxonomy + capabilities: `src/server/runtimes/adapters.ts`
  (`RuntimeAdapter`, `RuntimeTransport`, `ChatMode`, `RUNTIME_ADAPTERS`,
  `PLANNED_ADAPTERS`).
- Engine resolution + connectors: `src/server/services/dispatch/`.
- Design history + remaining work:
  [runtime-adapter ADR](../plans/runtime-adapter-refactor.md).
