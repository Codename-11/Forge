# Chat

Chat gives every user a persistent, per-(workspace, user, agent) thread accessible from
Mission Control's Chat tab (keyboard chord `5`). It is not a general-purpose messaging
channel — it is purpose-built for issuing instructions to a specific agent and receiving
responses grounded in your current workspace context.

::: tip Engine
How replies are produced depends on the agent's **chat engine** — *Completions*
(Forge owns the loop; the default) or *Runs* (the agent runs as itself with its
own memory + tools). Both stream. See [Chat & Dispatch Engines](/agents/engines.html).
:::

## How it works

### Opening a thread

Mission Control → Chat renders your thread list. Clicking an agent (or pressing Enter on
a selected row) opens the per-agent thread. `chat.thread({ agentId })` on the tRPC side
upserts the `ChatThread` row via the `(workspaceId, userId, agentId)` unique, so the same
thread is opened regardless of which device or session you're in.

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
User types → chat.send (tRPC)
  → ChatMessage persisted (role: USER)
  → CHAT_MESSAGE_POSTED event recorded
  → agent:dispatch:{agentId} WebhookDelivery enqueued
  → worker POSTs to agent.webhookUrl

Agent processes → chat.appendMessage OR chat.startDraft / appendDraftChunk / finalizeDraft (MCP)
  → ChatMessage persisted (role: AGENT)
  → client picks up via SSE fan-out
```

The `CHAT_MESSAGE_POSTED` dispatch branch in `src/server/audit.ts` (branch d) fires only
when `role === "USER"` — the agent's own reply does not loop back to the agent.

### Streaming replies

When the agent runtime is wired to a Forge platform adapter (see [Hermes
Integration](/agents/hermes.html)) replies stream token-by-token:

1. **`chat.startDraft({ threadId })`** — allocates a `draftId`, publishes a `started`
   event on the `chat-thread-stream` pub/sub channel. No DB row yet.
2. **`chat.appendDraftChunk({ threadId, draftId, delta, seq? })`** — publishes `delta`
   events, one per chunk. Ephemeral; never written to DB.
3. **`chat.finalizeDraft({ threadId, draftId, body, sourceRunId? })`** — persists the
   full `ChatMessage`, publishes `finalized` with `draftId` so the client can swap the
   draft bubble for the committed row without flicker.

Agents that have not yet been wired to the platform adapter use the single-shot fallback:
**`chat.appendMessage({ threadId, body, sourceRunId? })`** — writes one complete message,
no streaming.

> **Either/or:** use streaming or single-shot for a given reply, never both. Calling
> `appendMessage` after `startDraft` (without finalizing) leaves an open draft bubble.
> Always call `finalizeDraft` to close a draft you started.

### Markdown rendering

AGENT-role messages render through a hand-rolled lightweight markdown renderer
(`src/components/mission-control/chat-tab.tsx`). Supported: headings, bold/italic,
inline code, fenced code blocks (with copy buttons), blockquotes, unordered lists.
No external library dependency. USER and SYSTEM messages are rendered plain.

## Presence honesty

The chat header shows the agent's runtime mode and last-heartbeat age. Presence is
reflected in the composer area:

| Agent state | Composer hint |
|---|---|
| ONLINE, PERSISTENT | Normal — no hint needed. |
| OFFLINE, PERSISTENT | "Queued — delivered on next heartbeat." |
| ONLINE or OFFLINE, EPHEMERAL | "Session — replies arrive when the session is active." |
| Any status, no `webhookUrl` | "MCP-only — this agent pulls work; it will not reply here." |

## Slash commands

The composer supports client-side slash commands. Type `/` to open the inline popover.
Arrow keys cycle, Enter or Tab accepts, Escape closes.

| Command | Category | Behavior |
|---|---|---|
| `/help` (alias `/`?) | info | Appends a local SYSTEM bubble listing all commands. |
| `/clear` | control | Clears the visible thread locally (server history unchanged; refresh to restore). |
| `/info` | info | Appends a local bubble with the agent's profile, status, and runtime mode. |
| `/agents` | info | Appends a local link to the Agents page. |
| `/issue <KEY>` | prompt | Transforms into `Summarize <KEY> — current status, blockers, recent activity.` and sends normally. |
| `/assign <KEY>` | prompt | Asks the agent to take ownership of an issue and start working it. |
| `/status` | prompt | Transforms into a status-request prompt and sends normally. |
| `/engine [completions\|runs]` | control | Shows the agent's current [chat engine](/agents/engines.html), or switches it (admin). |
| `/summarize` | prompt | Asks the agent to summarize the conversation. |
| `/compact` | control | Compacts the conversation into Forge-owned summary context. |

Commands that take arguments show a usage hint (e.g. `<KEY>`) in the autocomplete,
and accepting one fills the stub so you can type the argument.

`info` and `control` commands append a SYSTEM-role bubble client-side only — they never
hit the server. `prompt` commands (`/issue`, `/status`) dispatch as real user messages.

Source: `src/lib/chat-slash-commands.ts`.

## Data model

```
ChatThread  ─── (workspaceId, userId, agentId)   UNIQUE
ChatMessage ─── threadId, role (USER | AGENT | SYSTEM), body, contextSnapshot?, sourceRunId?
```

`ChatThread.lastMessageAt` is bumped on every send for sort ordering. `sourceRunId` on
`ChatMessage` links a reply to a concurrent `AgentRun` for deep-linking in the UI.

## Cross-references

- [Runtime modes](/agents/runtime-modes.html) — persistent vs ephemeral, presence honesty.
- [Hermes Integration](/agents/hermes.html) — streaming platform adapter.
- [MCP Tools](/reference/mcp.html) — `chat.*` tool schemas.
- [Events](/reference/events.html) — `CHAT_MESSAGE_POSTED` and `chat-thread-stream`.
- [tRPC Routers](/reference/trpc.html) — `chat.*` router procedures.
