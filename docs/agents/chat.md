# Chat

Chat gives every user a persistent, per-(workspace, user, agent) thread accessible from
Mission Control's Chat tab (keyboard chord `5`). It is not a general-purpose messaging
channel — it is purpose-built for issuing instructions to a specific agent and receiving
responses grounded in your current workspace context.

::: tip Engine
How replies are produced depends on the agent's **chat engine** — _Completions_
(Forge owns the loop; the default) or _Runs_ (the agent runs as itself with its
own memory + tools). Both stream. See [Chat & Dispatch Engines](/agents/engines.html).
:::

## How it works

### Opening a thread

Mission Control → Chat renders your thread list. Clicking an agent opens the agent's
default thread; named side conversations use concrete `threadId` links.
`chat.thread({ agentId })` keeps the default DM behavior, while
`chat.getThread({ threadId })` opens a specific conversation.

Viewing a thread on the full Chat page, Mission Control's Chat tab, or the Activity
drawer calls `chat.markRead({ threadId })`. Forge stores that read anchor per
`(threadId, userId)` and also writes a browser-local marker so badges clear
immediately while the server write is in flight. The server never moves a read
anchor backward.

### Context bundle

Every send carries an optional context snapshot attached to the `ChatMessage` row:

```ts
{
  route?: string;          // current Next.js route
  slug?: string;           // workspace slug
  issueId?: string;        // issue open in the right panel, if any
  selectedIds?: string[];  // multi-selected issues
  pinnedRunIds?: string[]; // agent run IDs pinned to the side panel
  liveRunIds?: string[];   // agent runs currently active on screen
}
```

Agents can read this from the inbound webhook payload's `context` field to ground replies
without the user having to describe where they are in the product.

Source: `src/hooks/use-chat-context.ts`, `src/server/services/chat-context.ts`.

### The reply path

```
User types → /api/chat/stream
  → chatReadiness resolves the effective provider, engine, runtime, and transport
  → ChatMessage persisted (role: USER)
  → CHAT_MESSAGE_POSTED event recorded
  → one of three transport paths runs:
       runs        Forge streams through a managed runtime connector
       completions Forge streams through the configured model provider
       dispatch    Forge wakes the agent runtime/daemon and waits for its draft/reply

Agent/runtime replies → chat.appendMessage OR chat.startDraft / appendDraftChunk / finalizeDraft
  → latest unfinished USER turn is acknowledged/output-started
  → ChatMessage persisted (role: AGENT) or draft stream finalized
  → client picks up via SSE fan-out and cache invalidation
```

The `CHAT_MESSAGE_POSTED` dispatch branch in `src/server/audit.ts` (branch d) fires only
when `role === "USER"` — the agent's own reply does not loop back to the agent.
Dispatch-backed sends deliberately do not create an empty AGENT placeholder and
do not mark the operator message read until the agent/runtime acknowledges the
turn. That keeps the outbox at `Sent` while Forge is waking the runtime, then
moves it to `Read` when `acknowledgedAt` or `outputStartedAt` is present.

### Streaming replies

When Forge owns the loop (`runs` or `completions` readiness), replies stream
token-by-token from `/api/chat/stream`. When a runtime owns the loop through the
dispatch path, it can still stream drafts through the MCP chat draft tools:

1. **`chat.startDraft({ threadId })`** — allocates a `draftId`, publishes a `started`
   event on the `chat-thread-stream` pub/sub channel. No DB row yet.
2. **`chat.appendDraftChunk({ threadId, draftId, delta, seq? })`** — publishes `delta`
   events, one per chunk. Ephemeral; never written to DB.
3. **`chat.finalizeDraft({ threadId, draftId, body, sourceRunId? })`** — persists the
   full `ChatMessage`, publishes `finalized` with `draftId` so the client can swap the
   draft bubble for the committed row without flicker.

Agents that have not wired draft streaming use the single-shot fallback:
**`chat.appendMessage({ threadId, body, sourceRunId? })`** — writes one complete
message, no streaming.

> **Either/or:** use streaming or single-shot for a given reply, never both. Calling
> `appendMessage` after `startDraft` (without finalizing) leaves an open draft bubble.
> Always call `finalizeDraft` to close a draft you started.

### Markdown rendering

AGENT-role messages render through the shared chat message renderer
(`src/components/mission-control/chat-message.tsx`). Supported: headings,
bold/italic, inline code, fenced code blocks (with copy buttons), blockquotes,
unordered lists, attachments, tool-call cards, and local SYSTEM bubbles from
slash commands.

## Status and diagnostics

The right-hand Chat status rail is the operator-facing source of truth for a
weird conversation. It shows:

- Members and linked work inferred from message context snapshots.
- Effective provider, transport, runtime, runtime health, and whether chat can
  reach a model/runtime.
- Turn lifecycle (`queued`, `delivered`, `read`, `thinking`, `running`,
  `stalled`, `failed`) derived from the latest USER message, delivery rows, and
  linked runs.
- Last run, webhook delivery, stream error/interruption, and context summary
  state.
- Actions for retry, stop, kick, compact, archive/restore, delete, plus a
  **Copy diagnostic report** button.

Diagnostic reports are redacted client-side before copying. They include the
thread, agent, runtime, readiness, turn, run, delivery, and linked-work state,
but redact bearer tokens, secrets/keys/signatures, and URLs. Runtime names in
the rail deep-link to the exact runtime detail page for probe/config inspection.

## Presence honesty

The chat header and connection chip use the same provider-neutral readiness
resolver as `/api/chat/stream`. Presence and availability are deliberately
separate:

| Transport / state               | Composer or rail behavior                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `runs` ready                    | Managed runtime owns the loop; stop/run diagnostics are available.                              |
| `completions` ready             | Forge owns the model loop; streaming/tool UI is available when the provider supports it.         |
| `dispatch` ready                | Runtime/daemon answers asynchronously; the send stays `Sent` until the runtime acknowledges it. |
| Runtime probe failed            | Composer warns with the last probe detail and points the operator at runtime settings.           |
| No model/runtime/dispatch path  | Composer disables sends and explains what to configure.                                         |

Hermes gateway reachability is also distinct from agent presence. A gateway can
probe reachable while the `@victor` presence heartbeat is stale or missing; the
runtime page labels that as `presence stale` / `presence missing` instead of
collapsing every case into generic offline.

## Slash commands

The composer supports client-side slash commands. Type `/` to open the inline popover.
Arrow keys cycle, Enter or Tab accepts, Escape closes.

| Command                       | Category | Behavior                                                                                                                                                    |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/help` (alias `/`?)          | info     | Appends a local SYSTEM bubble listing all commands.                                                                                                         |
| `/clear` (alias `/reset`)     | control  | Clears this conversation's persisted messages, chat-message attachments, message events, and summary context while preserving the thread row.               |
| `/localclear`                 | control  | Clears only local slash-command output bubbles.                                                                                                             |
| `/new` (alias `/newchat`)     | control  | Starts a fresh conversation with the current agent. For Hermes agents, Forge also dispatches a short starter prompt so the model replies in the new thread. |
| `/info`                       | info     | Appends a local bubble with the agent's profile, status, and runtime mode.                                                                                  |
| `/agents`                     | info     | Appends a local link to the Agents page.                                                                                                                    |
| `/issue <KEY>`                | prompt   | Transforms into `Summarize <KEY> — current status, blockers, recent activity.` and sends normally.                                                          |
| `/assign <KEY>`               | prompt   | Asks the agent to take ownership of an issue and start working it.                                                                                          |
| `/status`                     | prompt   | Transforms into a status-request prompt and sends normally. Selecting it from the popover dispatches immediately because it takes no arguments.             |
| `/engine [completions\|runs]` | control  | Shows the agent's current [chat engine](/agents/engines.html), or switches it (admin).                                                                      |
| `/skills`                     | info     | Lists the agent's **live** Hermes skills (via the gateway `/api/skills`).                                                                                   |
| `/memory`                     | info     | Shows the agent's **live** Hermes memory (via the gateway `/api/memory`).                                                                                   |
| `/hermes <status\|usage>`     | info     | `status` = live gateway health; `usage` = asks the agent for a token report.                                                                                |
| `/summarize`                  | prompt   | Asks the agent to summarize the conversation.                                                                                                               |
| `/compact`                    | control  | Compacts the conversation into Forge-owned summary context.                                                                                                 |

Commands that take arguments show a usage hint (e.g. `<KEY>`) in the autocomplete,
and accepting one fills the stub so you can type the argument.

Most `info` commands append a SYSTEM-role bubble client-side only. Durable `control`
commands like `/clear`, `/new`, and `/compact` call Forge server mutations. `prompt`
commands (`/issue`, `/status`, `/summarize`, `/hermes usage`) dispatch as real user
messages.

Source: `src/lib/chat-slash-commands.ts`.

## Data model

```
ChatThread  ─── (workspaceId, userId, agentId)   UNIQUE
ChatMessage ─── threadId, role (USER | AGENT | SYSTEM), body, contextSnapshot?, sourceRunId?
```

`ChatThread.lastMessageAt` is bumped on every send for sort ordering. `sourceRunId` on
`ChatMessage` links a reply to a concurrent `AgentRun` for deep-linking in the UI.

## Cross-references

- [Engagement Modes](/agents/engagement-modes.html) — chat dispatch defaults to
  `DISCUSS` (conversational; opens no heavyweight run).
- [Runtime modes](/agents/runtime-modes.html) — persistent vs ephemeral, presence honesty.
- [Hermes Integration](/agents/hermes.html) — streaming platform adapter.
- [MCP Tools](/reference/mcp.html) — `chat.*` tool schemas.
- [Events](/reference/events.html) — `CHAT_MESSAGE_POSTED` and `chat-thread-stream`.
- [tRPC Routers](/reference/trpc.html) — `chat.*` router procedures.
