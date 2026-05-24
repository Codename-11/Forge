# Providers & Transports

Forge talks to agents in two fundamentally different ways. Keeping them
straight is what stops a Codex agent from "answering via Hermes" — right
persona, wrong platform.

## Two kinds of provider

**Agent / runtime providers** — the normal case. The *agent itself* (running
in some runtime) is the provider: Hermes profiles (Victor, Mizu), a Codex
agent, a Claude Code session, OpenCode, a custom webhook bot. Forge does **not**
hold a model API key for these — it reaches the runtime, and the runtime runs
the model. How it reaches the runtime is the **transport** (below).

**Chat-only providers** — *(its own concept, deferred)* — raw model access over
an OpenAI-compatible endpoint with an API key / base URL (plain OpenAI,
Anthropic, or a custom gateway). Here Forge owns the loop and the model is a
stateless completion backend. This is the **Completions** engine's backend.
It is intentionally **not** a first-class adapter in the runtime registry yet;
`streamChatReply` supports it via env-configured `ai-providers`, but there's
no UI to register "an OpenAI key as a provider." Tracked as a TODO — see the
[runtime-adapter ADR](../plans/runtime-adapter-refactor.md).

> The split matters because an *agent/runtime* provider with no chat-capable
> runtime attached has **no** way to chat — and it must not borrow another
> platform's model to fake one. Forge surfaces a "no chat model configured"
> notice instead.

## Transport tiers (agent/runtime providers)

How Forge sends work to a runtime, from basic to rich:

| Tier | Transport | What it is | Chat? |
|------|-----------|------------|-------|
| Basic | `webhook` / `mcp` | Push a webhook, or the agent pulls/acts over MCP with a Bearer key. Fire-and-react. | No (pull/act) |
| Basic | `local-daemon` | The `forge` CLI daemon — a managed SSE bridge that spawns a local CLI per event. | Via the spawned CLI |
| Mid | `acp` *(planned)* | Agent Client Protocol — a portable, bidirectional agent session. Drives CLIs (Claude Code, Codex, OpenCode) as live agents without per-vendor wiring. | Yes (as itself) |
| Rich | `app-server` *(planned)* | A vendor's own long-lived agent server, e.g. Codex's `app server` — the OpenAI analogue to the Hermes gateway. | Yes (as itself) |
| Rich | `runs-api` | A managed runtime that owns the full agent loop + streaming + approvals (**Hermes** today, via `/v1/runs`). | Yes (as itself) |

`acp` and `app-server` are declared in the adapter taxonomy
(`src/server/runtimes/adapters.ts`, `PLANNED_ADAPTERS`) but their dispatch
connectors aren't wired yet. We deliberately support **both** so the operator
keeps flexibility: ACP for portable, multi-vendor CLI control; a vendor app
server (Codex) when its native protocol is richer than ACP — exactly the role
Hermes already fills for its own agents.

## How chat is served (`chatMode`)

Each adapter declares a `chatMode` — the axis the "Codex via Hermes" bug lived
on:

- **`runs`** — a managed runtime owns the loop and streams the reply (Hermes;
  the local daemon's spawned CLI; a future Codex app server).
- **`acp`** — chat over an ACP session *(planned)*.
- **`completions`** — Forge owns the loop and calls an OpenAI-compatible model.
  The **chat-only provider** concept (deferred — no shipped adapter uses it).
- **`none`** — pull/act connection: reads context and takes actions over
  MCP/webhook, but does not serve an interactive chat turn. Claude Code, Codex
  CLI, Claude Desktop, custom webhook. To chat with one of these agents,
  attach it to a chat-capable runtime.

## Worked example: a Codex agent

- **Codex CLI (MCP connection)** → `chatMode: "none"`. It reads issues and
  acts via MCP. Chatting with it shows "no chat model configured" *by design*
  — it has no model key and is not a chat backend.
- **Codex app server** *(planned)* → `chatMode: "runs"`. The Codex agent chats
  as itself, with its own memory/tools, the same way Hermes agents do.
- If you genuinely want a stateless OpenAI completion, that's the **chat-only
  provider** path (deferred): set `OPENAI_API_KEY` and run the agent on the
  Completions engine. That is *not* "Codex the agent" — it's a bare model.

## Deferred / TODO

1. **Chat-only providers as a first-class surface** — register an OpenAI /
   Anthropic / custom-gateway key as a provider in the UI, instead of only via
   env. (`chatMode: "completions"`.)
2. **ACP connector** — a `DispatchConnector` over Agent Client Protocol;
   promote the `acp` entry from `PLANNED_ADAPTERS` into `RUNTIME_ADAPTERS`.
3. **Codex app-server connector** — a `DispatchConnector` over Codex's app
   server; promote `codex-app-server` likewise.
4. **Editor steering** — when an agent's only connection is `chatMode: "none"`,
   the chat composer should point the operator at attaching a chat-capable
   runtime rather than presenting an input that can only error.
