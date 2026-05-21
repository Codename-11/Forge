# Events

ActivityEvents drive webhooks and the SSE stream. Every state change in
Forge writes an event in the same transaction as the database mutation
(via `recordChange()`), and that event is the source of truth for both
push delivery and the in-app activity feed. This page lists every kind,
what `subjectType` / `subjectId` it carries, and what the payload contains.

## `EventKind`

| EventKind                | When it fires                                                          |
|--------------------------|------------------------------------------------------------------------|
| `ISSUE_CREATED`          | New issue inserted                                                     |
| `ISSUE_UPDATED`          | Any non-status/priority/assignment field changes                       |
| `ISSUE_DELETED`          | Soft-delete                                                            |
| `ISSUE_STATUS_CHANGED`   | Status moves                                                           |
| `ISSUE_ASSIGNED`         | Human or agent assigned (also fires `AGENT_ASSIGNED` for agents)       |
| `ISSUE_PRIORITY_CHANGED` | Priority changes                                                       |
| `ISSUE_QUEUED`           | `queued` flips true (entering the dispatch pool)                       |
| `COMMENT_CREATED`        | New comment posted                                                     |
| `COMMENT_UPDATED`        | Comment edited                                                         |
| `PROJECT_CREATED`        | New project                                                            |
| `PROJECT_UPDATED`        | Project edits / archival                                               |
| `SKILL_INVOKED`          | Plugin skill fired                                                     |
| `PLUGIN_ERROR`           | Plugin runtime error                                                   |
| `AGENT_CREATED`          | Agent row created                                                      |
| `AGENT_UPDATED`          | Agent row edited                                                       |
| `AGENT_DELETED`          | Agent archive/delete                                                   |
| `AGENT_ASSIGNED`         | Agent assigned to issue (manual or dispatch)                           |
| `AGENT_STATUS_CHANGED`   | Agent ONLINE/BUSY/OFFLINE flip                                         |
| `MEMBERSHIP_CREATED`     | Member added to workspace                                              |
| `MEMBERSHIP_ROLE_CHANGED`| Member role changed                                                    |
| `MEMBERSHIP_REMOVED`     | Member removed                                                         |
| `ISSUE_STALLED`          | Stale-work watchdog fired                                              |
| `AGENT_NOACK`            | Required-ack window elapsed without ack                                |
| `ISSUE_SLA_BREACH`       | Per-issue SLA window elapsed                                           |
| `CHAT_MESSAGE_POSTED`    | Chat message sent (role: USER or AGENT)                                |
| `GOAL_CREATED`           | Orchestration goal created (`subjectType: "goal"`)                     |
| `GOAL_STATUS_CHANGED`    | Goal OPEN→PLANNING→ACTIVE→ACHIEVED / ABANDONED (`subjectType: "goal"`)  |
| `EXECUTION_STEP_READY`   | A plan step became READY and its worker/judge was dispatched           |
| `EXECUTION_STEP_JUDGED`  | A judge recorded a PASS/FAIL verdict on a step                         |
| `PLAN_BUDGET_EXCEEDED`   | A RUNNING plan exceeded its cost / wall-time cap and was BLOCKED        |

The `subjectType` / `subjectId` of each event identifies the primary
entity:

- `ISSUE_*`, `ISSUE_STALLED`, `ISSUE_SLA_BREACH`, `AGENT_NOACK` →
  `subjectType: "issue"`, `subjectId: <issueId>`.
- `COMMENT_*` → `subjectType: "comment"`, `subjectId: <commentId>`.
- `PROJECT_*` → `subjectType: "project"`.
- `AGENT_CREATED` / `UPDATED` / `DELETED` / `STATUS_CHANGED` →
  `subjectType: "agent"`.
- `AGENT_ASSIGNED` → `subjectType: "issue"` (the issue is the subject;
  the agent is in the payload).
- `MEMBERSHIP_*` → `subjectType: "membership"`.
- `SKILL_INVOKED` / `PLUGIN_ERROR` → `subjectType: "plugin"`.
- `CHAT_MESSAGE_POSTED` → two sub-channels; see below.
- `GOAL_CREATED` / `GOAL_STATUS_CHANGED` → `subjectType: "goal"`,
  `subjectId: <goalId>`.
- `EXECUTION_STEP_READY` / `EXECUTION_STEP_JUDGED` →
  `subjectType: "execution-step"`, `subjectId: <stepId>`. The
  READY event additionally drives a per-agent webhook dispatch (worker
  for the normal phase, reviewer when `payload.phase === "judge"`).
- `PLAN_BUDGET_EXCEEDED` → `subjectType: "execution-plan"`,
  `subjectId: <planId>`.

## `CHAT_MESSAGE_POSTED`

This event fires for both user and agent messages. It uses two different `subjectType`
values that the SSE client discriminates on:

### `subjectType: "chat-thread"` — persisted message

Fires when a `ChatMessage` row is written (send or single-shot/finalized reply).

```json
{
  "kind": "CHAT_MESSAGE_POSTED",
  "subjectType": "chat-thread",
  "subjectId": "<threadId>",
  "payload": {
    "threadId": "<threadId>",
    "messageId": "<messageId>",
    "agentId": "<agentId>",
    "role": "USER",
    "body": "Can you summarize AXI-31?",
    "context": { "route": "/w/axiom/issues/AXI-31", "issueId": "iss_..." }
  }
}
```

For AGENT replies the `body` is the reply text; `context` is absent.
`sourceRunId` is present when the agent linked the reply to an `AgentRun`.

Agent dispatch (branch d in `src/server/audit.ts`) fires only when `role = "USER"` —
a `WebhookDelivery` is enqueued to `agent:dispatch:{agentId}`. Agent replies do not
trigger dispatch.

### `subjectType: "chat-thread-stream"` — ephemeral streaming events

Never persisted in `ActivityEvent`. Published Redis-only via `publish()` so the SSE
client can render progressive deltas.

```json
// phase: started
{
  "kind": "CHAT_MESSAGE_POSTED",
  "subjectType": "chat-thread-stream",
  "payload": { "phase": "started", "threadId": "...", "agentId": "...", "draftId": "abc123" }
}

// phase: delta
{
  "payload": { "phase": "delta", "threadId": "...", "agentId": "...", "draftId": "abc123",
               "delta": "Here's ", "seq": 0 }
}

// phase: finalized
{
  "payload": { "phase": "finalized", "threadId": "...", "agentId": "...",
               "draftId": "abc123", "messageId": "msg_..." }
}
```

The `draftId` carried through all three phases lets the client swap the draft bubble
for the committed message row when `finalized` fires — no flicker, no duplication.

::: warning
`chat-thread-stream` events are best-effort SSE only. If the client reconnects during
a streaming reply it will miss delta events. The `finalized` phase still persists the
full `body` so the thread can be fully reconstructed from the DB after the fact.
:::

## High-value payload shapes

### `AGENT_ASSIGNED.payload`

```json
{
  "agentId": "cle9k4z2j0040qg9k7m4n8p2x",
  "profileKey": "victor",
  "from": "cle9k4z2j0039qg9k7m4n8p2x",
  "to": "cle9k4z2j0040qg9k7m4n8p2x",
  "auto": true,
  "reason": "round-robin",
  "rationale": null,
  "commentId": null,
  "dispatch": {
    "mode": "ROUND_ROBIN",
    "candidates": [
      "cle9k4z2j0039qg9k7m4n8p2x",
      "cle9k4z2j0040qg9k7m4n8p2x",
      "cle9k4z2j0041qg9k7m4n8p2x"
    ],
    "chosen": "cle9k4z2j0040qg9k7m4n8p2x",
    "reason": "round-robin",
    "ruleId": null
  }
}
```

`reason` is a stable string the agent ops UI groups on:

- `"round-robin"` — `ROUND_ROBIN` mode picked the least-recently-dispatched
  eligible agent.
- `"priority-match:high"` — `PRIORITY_MATCH` picked an agent whose
  `capabilities` include the issue's priority name (lowercased).
- `"capability-match:2/3"` — `CAPABILITY_MATCH` picked the agent with the
  most overlap between issue labels and agent capabilities (numerator =
  matches, denominator = total label count on the issue).
- `"rule:abc:target-ineligible,round-robin pick"` — a `dispatchRule`
  matched (id `abc`) but its target was ineligible at fire time, so the
  dispatcher fell through to round-robin. The trailing fragment after the
  comma always names the actual selection method.
- `"handoff"` — emitted by `issues.reassign`. `rationale` is the operator
  string (≥ 10 chars) and `commentId` references the auto-posted handoff
  comment.

`auto` is `true` for dispatcher selections, `false` for manual
`assign`/`reassign`. `from` is `null` on first assignment.

### `ISSUE_STALLED.payload`

```json
{
  "issueId": "cle9k4z2j0033qg9k7m4n8p2x",
  "slaMinutes": 60,
  "breachedByMinutes": 12,
  "priority": "HIGH",
  "reason": "no activity since assignment"
}
```

Emitted by the stale-work watchdog (P1 layer 2). `slaMinutes` is the window
the watchdog was checking against; `breachedByMinutes` is how far past it
the issue is at fire time. `reason` is a short human-readable string —
current values include `"no activity since assignment"` and
`"no activity since last status change"`.

### `AGENT_NOACK.payload`

```json
{
  "agentId": "cle9k4z2j0040qg9k7m4n8p2x",
  "issueId": "cle9k4z2j0033qg9k7m4n8p2x",
  "requiredAckSeconds": 300,
  "reason": "no comment or status move"
}
```

Emitted when an agent is assigned an issue with required-ack and the
window elapses without a qualifying ack (a comment from the assigned
agent, or a status move on the issue). `requiredAckSeconds` reflects the
workspace's configured window at fire time.

### `ISSUE_UPDATED.payload` (ActionRequest vote / close)

Poll-related ActionRequest activity rides on `ISSUE_UPDATED` with
`subjectType: "action-request"` (NOT `"issue"` — the request id is
the subject). Subscribers can discriminate on `subjectType` to
filter for vote / close-voting events without inventing new
EventKind values. Two shapes:

```json
// actionRequest.vote — emitted on every vote / re-vote
{
  "kind": "ISSUE_UPDATED",
  "subjectType": "action-request",
  "subjectId": "ar_...",
  "payload": {
    "optionKey": "isolate",
    "previousOptionKey": "retry",
    "changed": true,
    "issueId": "iss_..."
  }
}

// actionRequest.closeVoting — emitted when the requester closes voting
{
  "kind": "ISSUE_UPDATED",
  "subjectType": "action-request",
  "subjectId": "ar_...",
  "payload": {
    "winningOptionKey": "isolate",
    "total": 5,
    "issueId": "iss_..."
  }
}
```

`winningOptionKey` may be null if voting was closed before any vote
was cast (rare but legal — the requester might cancel a poll
early). Ties are broken by earliest first-vote timestamp.

### `ISSUE_SLA_BREACH.payload`

```json
{
  "issueId": "cle9k4z2j0033qg9k7m4n8p2x",
  "slaMinutes": 240,
  "breachedByMinutes": 18,
  "priority": "URGENT"
}
```

Emitted when a per-issue SLA elapses without resolution. Distinct from
`ISSUE_STALLED` — SLA breach is about the *clock since the issue entered
the queue / hit a status threshold*, not whether anyone is touching it.

### `EXECUTION_STEP_READY.payload`

```json
{
  "planId": "plan_…",
  "stepId": "step_…",
  "title": "Write the migration",
  "body": "…",
  "expectedOutput": "migration.sql applied cleanly",
  "verification": [ { "label": "pnpm prisma migrate status clean", "done": false } ],
  "contextSetId": "ctx_…",
  "assignedAgentId": "agent_…",
  "lastFeedback": "missing rollback section",
  "retryCount": 1
}
```

When `phase: "judge"` is present, the event is a judge dispatch (carries
`judgeAgentId` + a judging `prompt`) rather than a worker dispatch.

### `EXECUTION_STEP_JUDGED.payload`

```json
{
  "planId": "plan_…",
  "verdict": "PASS",
  "feedback": "meets the contract",
  "score": 0.95,
  "outcome": "DONE"
}
```

`outcome` is `DONE` (PASS), `RETRY` (FAIL, retries remain — step
re-readied with `lastFeedback`), or `BLOCKED` (FAIL, retries exhausted —
a ReviewGate is opened on the step).

### `PLAN_BUDGET_EXCEEDED.payload`

```json
{
  "totalCostUsd": 6.21,
  "maxTotalCostUsd": 5.0,
  "maxWallTimeMinutes": null,
  "reason": "cost $6.2100 > cap $5.0000"
}
```

Emitted when a RUNNING plan's accumulated cost or wall-time crosses its
cap (via `runs.recordUsage` on a run tied to a plan step). The plan flips
to `BLOCKED` and a ReviewGate ("approve continuation or abandon") opens.

### `GOAL_STATUS_CHANGED.payload`

```json
{ "from": "PLANNING", "to": "ACTIVE", "planId": "plan_…" }
```

## SSE stream

Subscribe at:

```http
GET /api/plugins/events
Authorization: Bearer <api-key>   # SUBSCRIBE_EVENTS scope required
Accept: text/event-stream
```

The stream emits JSON `RealtimeEvent` objects scoped to the key's
workspace. Events are flushed on every `recordChange()` — best-effort
fan-out via Redis pub/sub.

```
event: message
data: {"id":"cle9k4z2j0001qg9k7m4n8p2x","kind":"ISSUE_CREATED","subjectType":"issue","subjectId":"cle9k4z2j0002qg9k4f7r2x1d","payload":{...},"createdAt":"2026-04-26T18:00:00.000Z"}
```

::: warning
SSE is best-effort. If the consumer disconnects, events fired during the
gap are not replayed. Durability lives in `WebhookDelivery` rows — for
guaranteed delivery, register a webhook per
[/automation/webhooks.html](/automation/webhooks.html).
:::

The stream sends a heartbeat comment every 25 seconds so proxies do not
close idle connections:

```
: heartbeat
```

Clients should treat any line starting with `:` as a no-op.

## Webhook envelope

Every event listed above is also the payload of a webhook delivery (when a
`Webhook` row matches the kind). The full HMAC contract — both
`x-forge-signature` and `x-webhook-signature`, the timestamp replay
window, the retry/dead-letter behavior — lives at
[/automation/webhooks.html](/automation/webhooks.html).

## Cross-references

- [/automation/webhooks.html](/automation/webhooks.html) — wire format and
  delivery durability.
- [/agents/auto-dispatch.html](/agents/auto-dispatch.html) — the dispatch
  modes that produce the `reason` strings above.
- [/agents/slas-and-watchdogs.html](/agents/slas-and-watchdogs.html) —
  the watchdogs behind `ISSUE_STALLED`, `AGENT_NOACK`, and
  `ISSUE_SLA_BREACH`.
