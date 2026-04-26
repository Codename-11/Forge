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
