# Agent Dispatch Inbox — Design Decisions

> Companion to the Forge execution plan
> "Forge Durable Agent Dispatch Inbox (Single-Operator) Implementation Plan".
> The map file `agent-dispatch-inbox-map.md` is the orientation. This file
> records the **final design choices** before implementation.

## Architecture summary

Webhooks become **wake accelerators only**. The canonical record of "agent
X owes work on Y" is a database row that exists from the moment Bailey's
action creates the `ActivityEvent`, regardless of whether the wake POST
succeeded.

For agent-routed events on **issues** (branches a, b, c, e in `audit.ts`),
the canonical row is an extended `AgentRun`. For agent-routed events on
**chat threads** (branch d), the canonical row is the user `ChatMessage`
itself — that table already represents one operator turn that owes an
agent reply, and `dispatchedAt` is already there.

Both surfaces expose the same conceptual lifecycle:

```
queued → wake-sent → acknowledged → running → completed
                                  ↘ stalled  ↗
```

## Why extend AgentRun + ChatMessage, not a new table

The plan's v1 guidance is "extend `AgentRun` rather than introducing a
parallel queue table". We honor that for issues. For chat we extend
`ChatMessage` rather than promoting chat to use `AgentRun`, because:

1. `AgentRun` is conceptually "agent X is working an issue" — its FK to
   `Issue` is non-null in every existing call site (and exposed all the
   way out through MCP `runs.*`). Making `issueId` nullable cascades into
   ~20 queries, the chat composer doesn't actually need run telemetry
   (token counts, currentStep, etc.), and the chat draft mechanism
   (`chat.startDraft`/`appendDraftChunk`/`finalizeDraft`) already provides
   the closest thing to "agent is running".
2. The user `ChatMessage` row with `role=USER` is already the
   one-to-one unit of "operator turn awaiting agent response". Adding
   five timestamp/counter columns to it is cheaper and clearer than a
   join-on-AgentRun-of-kind-CHAT.
3. The MCP inbox surface naturally returns a small discriminated union
   (`kind: "run"` vs `kind: "chat"`), which a thin agent receiver can
   route by `kind`.

## Schema changes (migration 0039)

### `AgentRun` — durable lifecycle metadata

```prisma
model AgentRun {
  // ... existing fields ...

  /// ActivityEvent.id that *caused* the wake (assignment, mention,
  /// priority bump, watcher fan-out). For AGENT_ASSIGNED runs this
  /// equals assignmentEventId; for other triggers it lets the inbox
  /// distinguish "Victor was mentioned in AXI-31" from "Victor is the
  /// assignee of AXI-31".
  triggerEventId       String?
  /// String mirror of ActivityEvent.kind. Not enum-typed on purpose —
  /// EventKind grows and we don't want to migrate AgentRun every time.
  triggerKind          String?

  /// Set when the agent has read the dispatch and intends to act.
  /// Drives the UI transition from "wake sent" → "acknowledged".
  acknowledgedAt       DateTime?
  /// Set the first time the agent's reply/status output lands. Drives
  /// the UI transition from "acknowledged" → "running".
  outputStartedAt      DateTime?

  /// Latest wake attempt (worker-side; populated when WebhookDelivery
  /// completes regardless of success — diagnostic, not lifecycle).
  lastWakeAt           DateTime?
  /// Number of wake attempts the worker has made for this run. Distinct
  /// from WebhookDelivery.attempt (which counts retries on one row).
  wakeAttempts         Int       @default(0)
  /// Optional pointer at the most recent WebhookDelivery row so the
  /// diagnostics panel can link straight to the failed delivery.
  lastWakeDeliveryId   String?

  // ... existing relations ...

  @@index([workspaceId, status, acknowledgedAt, lastEventAt])
  @@index([workspaceId, triggerEventId])
}
```

`assignmentEventId` stays for backward-compat with existing watchdog
queries. New code reads `triggerEventId`.

### `ChatMessage` — same lifecycle dimensions

```prisma
model ChatMessage {
  // ... existing fields incl. dispatchedAt ...

  /// Set when the addressed agent has acknowledged this user turn.
  acknowledgedAt       DateTime?
  /// Set when the agent's reply draft is first written.
  outputStartedAt      DateTime?

  lastWakeAt           DateTime?
  wakeAttempts         Int       @default(0)
  lastWakeDeliveryId   String?

  @@index([workspaceId, threadId, role, acknowledgedAt])
}
```

Only meaningful when `role = USER`; agent/system messages keep them at
default/null.

## Service: `src/server/services/agent-dispatch-inbox.ts`

Idempotent helpers. All functions take an open `Tx` so callers compose
into the same transaction as the triggering write.

```ts
// Called from audit.recordChange() right after ActivityEvent insert.
// Resolves event → 0..N "canonical work units" and ensures rows exist.
ensureCanonicalFromEvent(tx, {
  workspaceId, eventKind, eventId, subjectType, subjectId,
  actorId, payload,
}): Promise<EnsureResult>
//   → { issueRunIds: string[]; chatMessageIds: string[] }

// MCP-facing list. Identity inferred from ctx.apiKey.linkedAgentId.
listInbox(db, {
  workspaceId, agentId, status: "unacked"|"active"|"stale"|"all",
  limit, scope: { projectIds, labelIds, initiativeIds },
}): Promise<InboxItem[]>
// InboxItem is a discriminated union: { kind: "run", runId, ... } or
// { kind: "chat", chatMessageId, threadId, ... } with normalized
// lifecycle state + snapshots.

// Idempotent ack. Validates linked agent owns the target.
ackInboxItem(tx, {
  workspaceId, agentId,
  target: { runId } | { chatMessageId },
}): Promise<void>

// Idempotent output-started marker. Called by chat.startDraft and
// (optionally) by recordAgentAction on the first agent-produced step.
markOutputStarted(tx, {
  workspaceId, agentId,
  target: { runId } | { chatMessageId },
}): Promise<void>

// Worker-side: bump wake telemetry. Does NOT create canonical work
// (canonical work already exists from event time).
recordWakeAttempt(tx, {
  workspaceId, agentId,
  target: { issueId } | { chatMessageId },
  deliveryId, eventKind, eventId, ok,
}): Promise<void>

// UI helper: map (run | chatMessage) → dispatch state label + diagnostic.
deriveDispatchState(item): {
  state: "queued"|"wake-sent"|"acknowledged"|"running"|"stalled"|"completed"|"abandoned",
  ageMs, lastDeliveryStatus, recommendedAction,
}
```

## audit.ts — minimal edit

After `tx.activityEvent.create(...)`, before the webhook fan-out, call
`ensureCanonicalFromEvent(tx, { ... })`. Pass the existing
`agentWebhookIds`-resolved agent set so we don't repeat the resolution.

`ensureCanonicalFromEvent` decides:
- branch (a) AGENT_ASSIGNED / ISSUE_QUEUED on issue → `openOrTouchRun()`
  with `triggerEventId = event.id`, `triggerKind = eventKind`, and (for
  AGENT_ASSIGNED) `assignmentEventId = event.id` to preserve compat.
- branch (b) ISSUE_PRIORITY_CHANGED to HIGH/URGENT → touch existing run
  if any, else open one with `triggerKind = "ISSUE_PRIORITY_CHANGED"`.
- branch (c) COMMENT_CREATED with mentions → for each mentioned agent,
  open-or-touch run; latest `triggerEventId/Kind` wins.
- branch (d) CHAT_MESSAGE_POSTED USER → no AgentRun; the row already
  exists as the user ChatMessage. We only need to ensure its lifecycle
  fields are at defaults (no-op on first insert).
- branch (e) watchers — same as (a) with `triggerKind = eventKind` for
  whatever sub-event fired.

No new transactions are introduced — everything composes into the open
`tx` the caller already holds.

## worker.ts — wake-only edit

Replace the `db.$transaction(... recordAgentAction(...))` block
(lines 171–186) with a thin call to
`recordWakeAttempt(tx, { ok: true, deliveryId, eventId, eventKind })`.

The block at line 191 (schedule `required-ack-check`) stays but moves
its trigger to the canonical run: schedule only if the run's
`assignmentEventId === event.id` and `acknowledgedAt` is still null —
otherwise the agent already acked elsewhere and we don't need a
second check.

Critically: **failed** deliveries also call `recordWakeAttempt({ ok:
false })`. That way the inbox UI surfaces "wake failed (3 attempts)"
instead of looking identical to "wake never tried".

## MCP additions (`src/server/services/mcp.ts`)

```ts
"agent.inbox.list": {
  scopes: ["READ_ISSUES"],
  input: z.object({
    status: z.enum(["unacked","active","stale","all"]).default("unacked"),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  // identity from ctx.apiKey?.linkedAgentId; 403 if missing.
  // returns InboxItem[] (run + chat union, lifecycle state derived).
},

"agent.inbox.ack": {
  scopes: ["WRITE_ISSUES"],
  input: z.object({
    runId: z.string().cuid().optional(),
    chatMessageId: z.string().cuid().optional(),
  }).refine((v) => !!v.runId !== !!v.chatMessageId, "exactly one of runId | chatMessageId"),
  // identity from linkedAgentId; rejects cross-agent.
},

"agent.inbox.outputStarted": {
  scopes: ["WRITE_ISSUES"],
  input: <same union as ack>,
  // idempotent.
},
```

`runs.kick` (existing) gains: increment `wakeAttempts`, set
`lastWakeAt`, append an `AgentRunEvent(kind="KICK")`. Already most of
this is in place; we wire it through `recordWakeAttempt`.

## UI contract

Issue surfaces (run pulse strip, agent activity panel) and chat
(`chat-workspace.tsx`) consume `deriveDispatchState(item)` and render:

| state          | UI                                                    |
|----------------|-------------------------------------------------------|
| queued         | "queued · waking…" (no wake attempt yet)              |
| wake-sent      | "wake sent · waiting for ack" (+ retry wake / kick)   |
| acknowledged   | "agent acked · drafting…" (typing animation OK here)  |
| running        | live status / draft delta rendering as today          |
| stalled        | "no activity since {ago}" + retry wake / kick / abandon |
| completed      | terminal label (unchanged from today)                 |
| abandoned      | terminal label (manual or auto-finished)              |

The chat typing animation runs **only** when `acknowledgedAt || draftId
present`. Before ack lands, the chat panel shows "wake sent" with a
retry button. After the configured `chatStaleSeconds` threshold (default
60s; will reuse `requiredAckSeconds` if present, otherwise hardcoded
default for v1), it switches to an actionable diagnostic.

## Backwards compatibility / migrations

- New AgentRun columns are nullable / defaulted; existing rows untouched.
- New ChatMessage columns are nullable / defaulted; existing rows
  untouched.
- worker.ts: the removal of `recordAgentAction(... DISPATCH_RECEIVED ...)`
  could regress historical "Victor picked up AXI-31" timeline rows.
  Mitigate by emitting `AgentRunEvent(kind="WAKE_DELIVERED")` inside
  `recordWakeAttempt({ ok: true })` so the timeline still has a row.
- `agent.context.bundle` remains the canonical "read me first"; no
  change.
- Required-ack worker job logic stays; we just re-derive
  `acknowledgedAt` from the new column rather than re-running the
  "did Victor comment?" heuristic.

## Out of scope (defer)

- Multi-human notification preferences (single operator).
- Cross-runtime load balancing of inbox items.
- Generalized event subscription system.
- Analytics rollups on dispatch state distributions.
