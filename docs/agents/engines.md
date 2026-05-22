# Chat & Dispatch Engines

Every agent in Forge runs through one of two **execution engines**. The
engine decides *who owns the agent loop* — Forge, or the agent's own
runtime (e.g. Hermes).

You pick the engine per agent in **Settings → Agents → (edit) → Chat
engine**. The default comes from the integration (Hermes ships with
**Completions**), and any agent can override it.

| | **Completions** (default) | **Runs** |
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

**Use Completions (the default) for general chat.** It's fast,
predictable, and Forge stays in control of the tools the agent can use,
the approval prompts you see, and the page context the agent receives. It
works with any OpenAI-compatible model, so it's the right default for a
consumer chat surface.

**Use Runs when you want the agent to be _itself_** — its own long-term
memory, persona, and native toolset — and you're on a provider that
supports it (Hermes today). Chat still streams token-by-token; you
additionally get structured tool/approval/lifecycle events and a native
stop/approval control plane.

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

## Switching engines

Changing an agent's engine takes effect on the **next** chat turn or
assignment. In-flight runs finish on the engine they started with. The
choice is per-agent, so you can run some agents on Completions and others
on Runs in the same workspace.
