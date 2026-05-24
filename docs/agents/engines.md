# Chat & Dispatch Engines

Every agent in Forge runs through one of two **execution engines**. The
engine decides *who owns the agent loop* — Forge, or the agent's own
runtime (e.g. Hermes).

You pick the engine per agent in **Settings → Agents → (create or edit) →
Chat engine**. The default comes from the integration — **Hermes defaults to
Runs** (you're talking to *your* agent, with its own memory and tools) —
and any agent can override it. Flip an agent to **Completions** for a
stateless, Forge-owned loop.

::: warning Completions needs a configured chat model
**Completions** calls an OpenAI-compatible endpoint, so it only works when a
chat model is actually configured for the agent's provider (e.g.
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or a `FORGE_AI_BASE_URL` gateway). A
CLI/MCP connection like **Codex CLI** or **Claude Code** does *not* answer
chat from an API key — those reach Forge to read context and take actions
(pull/act), not to serve a chat turn. To chat with such an agent *as itself*,
back it with a chat-capable runtime (Hermes, or — planned — a Codex app
server / ACP session). If neither is configured, chat returns a clear "no
chat model configured" notice and **does not** fall back to another platform.
See **[Providers & transports](./providers-and-transports.md)** for the full
model.
:::

| | **Completions** | **Runs** (Hermes default) |
|---|---|---|
| Underlying API | OpenAI-compat `/v1/chat/completions` | Provider agent-run API (Hermes `/v1/runs`) |
| Who owns the loop | **Forge** | **The agent's runtime** |
| Tools | Forge's chat-tool allowlist, with approval cards | The agent's own tools |
| Context injection | Forge injects page/canvas/issue context | Sent as run input; the agent decides |
| Agent memory / persona | None (stateless model call) | Full — the agent runs as itself |
| Streaming | Yes (token deltas) | Yes (`message.delta` + lifecycle events) |
| First-token latency | Lowest | Slightly higher (run setup) |
| Model flexibility | Any OpenAI-compatible model | Provider-specific |

## When to use which

**Hermes agents default to Runs** — when you chat with Victor or Mizu you
want *that agent*, with its own long-term memory, persona and native
tools, not a stateless model. Chat still streams token-by-token; you also
get structured tool/approval/lifecycle events and a native stop/approval
control plane. Assigned work uses Runs too, so chat and dispatch behave
consistently.

**Switch an agent to Completions for a general, stateless chat surface.**
It's fast and predictable, and Forge stays in control of the tools the
agent can use, the approval prompts you see, and the page context it
receives — and it works with any OpenAI-compatible model. Good for a
utility assistant where agent memory/identity doesn't matter.

### Pros & cons at a glance

**Completions**
- ✅ Lowest latency; predictable; Forge owns tools + approvals + context.
- ✅ Model-agnostic (any OpenAI-compatible endpoint).
- ⛔ No agent memory or identity continuity between turns.
- ⛔ The agent can't use its own (Hermes) tools — only Forge's chat allowlist.

**Runs**
- ✅ The agent runs as itself: memory, persona, its own tools.
- ✅ Structured lifecycle events + native approval / stop.
- ✅ Same engine that powers dispatched (assigned) work — consistent behaviour.
- ⛔ Slightly higher first-token latency and more operational surface.
- ⛔ Forge's canvas/issue context injection and chat-tool allowlist don't
  apply — the agent's runtime owns that.

## Who owns chat vs. the run

Forge **always** owns the conversation record (the thread + messages) and
the UI. The engine only changes who owns the *loop* and the agent's
*memory*:

- **Completions** — Forge runs the loop: it builds the prompt, injects
  context, calls the model, executes any approved tools, and persists the
  reply. The model is stateless.
- **Runs** — the provider runs the loop with the agent's own memory and
  tools. Forge sends the turn as run input, streams the result back, and
  persists the reply.

## Dispatch (assigned work) always uses Runs

When you **assign an issue** to an agent whose engine is **Runs**, Forge
drives the work through the provider's agent-run API instead of a webhook:

1. On assignment, Forge opens an `AgentRun` and starts a provider run.
2. The background worker polls the run's status every few seconds and
   mirrors progress onto the `AgentRun` — current step, token usage, and
   the terminal result — so **Mission Control** shows live progress.
3. Completion (or failure / cancellation) closes the `AgentRun` with the
   agent's final summary.

::: tip
A Runs-engine agent is driven entirely through the agent-run API, so it
**should not** also carry a dispatch `webhookUrl` — that would dispatch
the same work twice. Leave the webhook blank for Runs agents.
:::

Completions / webhook-based agents keep using the existing webhook
dispatch path unchanged.

## Permission blocks (approvals)

The Hermes runtime can pause an agent when it's about to run a dangerous
shell command (depending on its `approvals.mode`; agents running
`approvals.mode: off` never pause). Forge surfaces this as a block you
resolve:

- **In chat** — the reply shows an approval card with the command. **Approve**
  allows it once and the agent continues; **Decline** stops the run (a bare
  "deny" would otherwise leave the agent blocked).
- **In dispatch** — a paused run shows **"needs permission to run a command"**
  with **Approve / Reject** in Mission Control's Live tab. Approve resumes it;
  Reject stops and abandons the run. While blocked, the stale watchdog leaves
  the run alone (it's intentionally idle, not dead).

Either way, approving forwards `once` to the gateway; rejecting interrupts the
run via `/v1/runs/{id}/stop`.

## Switching engines

Changing an agent's engine takes effect on the **next** chat turn or
assignment. In-flight runs finish on the engine they started with. The
choice is per-agent, so you can run some agents on Completions and others
on Runs in the same workspace.
