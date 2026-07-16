# Chat & Dispatch Engines

Forge separates interactive conversation transport from background execution.
For Hermes, interactive chat uses the native Sessions API so one Forge thread
resumes one durable Hermes conversation. Issue work and other background
execution continue to use the asynchronous Runs API.

You pick the engine per agent in **Settings → Agents → (create or edit) →
Chat engine**. Hermes uses Sessions when the runtime explicitly advertises the
required session resources and streaming endpoint. A non-Hermes agent can use
Completions for a stateless, Forge-owned loop. `/v1/runs` remains an execution
engine rather than being overloaded into a conversation transport.

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

| | **Completions** | **Hermes Sessions** | **Runs** |
|---|---|---|---|
| Underlying API | OpenAI-compat `/v1/chat/completions` | `/api/sessions/{id}/chat/stream` | Provider agent-run API (`/v1/runs`) |
| Intended use | Stateless utility chat | Interactive agent conversation | Issue and background execution |
| Lifecycle owner | **Forge** | **Forge mapping + Hermes transcript** | **The agent runtime** |
| Agent memory / persona | None | Durable per-session identity | Run-scoped runtime identity |
| Streaming | Token deltas | Session lifecycle SSE | Run lifecycle SSE + status polling |
| Reconnect | Forge stream checkpoints | Resume the mapped session on the next turn; in-flight replay only when explicitly advertised | Poll run status after stream loss |
| Model flexibility | Any OpenAI-compatible model | Hermes runtime | Provider-specific |

## When to use which

**Hermes interactive chat uses Sessions.** Reusing the mapped Hermes session ID
preserves the runtime's transcript, memory scope, persona, and native tools
without manufacturing a new background run for every message. Forge owns the
mapping and display record; Hermes owns the native transcript.

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

**Hermes Sessions**
- ✅ One durable Hermes conversation per mapped Forge thread.
- ✅ Native transcript history, persona, memory scope, and streaming events.
- ⛔ Current upstream streaming does not imply in-flight replay, tool approval,
  proactive delivery, or attachments beyond explicitly advertised image input.

**Runs**
- ✅ Durable asynchronous execution status, stop, and approval controls.
- ✅ Appropriate for assignment and background work that must outlive a browser.
- ⛔ Not an interactive session transport and must not own a ChatThread mapping.

## Who owns chat vs. the run

Forge **always** owns the conversation record (the thread + messages) and
the UI. The engine only changes who owns the *loop* and the agent's
*memory*:

- **Completions** — Forge runs the loop: it builds the prompt, injects
  context, calls the model, executes any approved tools, and persists the
  reply. The model is stateless.
- **Hermes Sessions** — Forge persists its ChatThread and a tenant-scoped
  mapping to the Hermes session. Hermes persists the native transcript and
  runs each interactive turn.
- **Runs** — the provider owns an asynchronous execution. Forge mirrors its
  progress into AgentRun and does not treat the run ID as a chat session ID.

## Dispatch and background work use Runs

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

Changing an agent's execution configuration takes effect on the next turn or
assignment. In-flight sessions and runs finish on the transport they started
with. A Hermes interactive fallback is selected only from a successful,
versioned capability negotiation; Forge does not guess from server version,
endpoint naming, or a successful health check.
