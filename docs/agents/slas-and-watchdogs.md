# SLAs & Watchdogs

Three follow-through layers catch dropped, stuck, and overdue work — each
independently togglable, each emitting its own event.

The dispatcher gets work to an agent. The watchdogs make sure the work
actually moves. Each layer fires a distinct ActivityEvent so you can react
selectively (alerting, AI Coach comments, re-dispatch) without conflating
"never started" with "started but stalled" with "running long."

## Layer 1 — Stale-work watchdog

Catches issues that have an agent assigned but show no activity within an
SLA window.

### Knobs

| Column | Purpose |
| --- | --- |
| `Workspace.assignmentSlaMinutes` | Window of inactivity before an issue is considered stalled. `0` disables this layer. |
| `Workspace.autoRedispatchOnStall` | When true, clears `assignedAgentId` so the dispatcher picks again on the next cycle. |

### Mechanism

The worker runs a repeatable BullMQ job that scans non-terminal issues
(`status IN (BACKLOG, TODO, IN_PROGRESS)`). For each, it checks the most
recent activity timestamp — comments, status transitions, attachments. If
nothing has happened in `assignmentSlaMinutes` minutes, the worker emits
`ISSUE_STALLED` via `recordChange()`.

If `autoRedispatchOnStall = true`, the same transaction sets
`assignedAgentId = null`, which causes the dispatcher to re-select on its
next pass.

The event is idempotent within a 24-hour grace window — once an issue has
been marked stalled, it won't re-emit `ISSUE_STALLED` for the same stall
period. A subsequent activity (comment, transition) resets the clock.

```ts
await recordChange({
  kind: "ISSUE_STALLED",
  actor: { kind: "system" },
  subjectType: "issue",
  subjectId: issue.id,
  payload: {
    issueKey: issue.key,
    assignedAgentId: issue.assignedAgentId,
    minutesSinceActivity: 47,
    slaMinutes: 30,
  },
});
```

## Layer 2 — Required-ack window

Catches agents that received an assignment but never acknowledged it.

### Knobs

| Column | Purpose |
| --- | --- |
| `Workspace.requiredAckSeconds` | Seconds the agent has to ack after AGENT_ASSIGNED. `0` disables this layer. |
| `Workspace.autoRedispatchOnNoack` | When true, clears `assignedAgentId` on noack so the dispatcher picks again. |

### Mechanism

When an `AGENT_ASSIGNED` event fires, the worker schedules a delayed
BullMQ job for `requiredAckSeconds` later. When the job runs, it asks two
questions about the issue:

1. Has the assigned agent posted a comment since the assignment?
2. Has the issue moved out of `BACKLOG`/`TODO` since the assignment?

If either is true, the assignment was acknowledged and the job exits. If
both are false, the worker emits `AGENT_NOACK`.

The job is idempotent within a 24-hour grace window keyed by the
originating delivery — even if multiple ack-check jobs were enqueued, only
the first noack within the grace window emits.

If `autoRedispatchOnNoack = true`, `assignedAgentId` is cleared in the same
transaction.

```ts
// Two ways an agent acknowledges assignment.
// 1. Post a comment.
await mcp.call("comments.create", { issueId, body: "On it." });
// 2. Move the status out of BACKLOG/TODO.
await mcp.call("issues.transition", { issueId, to: "IN_PROGRESS" });
```

::: tip
The required-ack window is the single most useful watchdog for catching
dead agents. A working agent will always do one of the two within seconds;
a hung agent never will.
:::

## Layer 3 — SLA breach

Catches issues that have been open longer than their per-issue SLA.

### Knobs

| Column | Purpose |
| --- | --- |
| `Workspace.slaEnforcementEnabled` | Master toggle for this layer. |
| `Issue.slaMinutes` | Per-issue SLA. Null means "no SLA"; the issue is excluded from the scan. |

### Mechanism

A repeatable worker job scans non-terminal issues with `slaMinutes IS NOT
NULL`. For each, it computes the issue age (now minus `createdAt`) and
compares to `slaMinutes`. If the issue is over its SLA, the worker emits
`ISSUE_SLA_BREACH`.

The breach event is idempotent within a 24-hour rebreach grace window. An
issue that's been open 3× its SLA emits once, not three times. The next
emission requires the issue to either resolve and re-open, or for 24 hours
to pass since the last emission.

```ts
await recordChange({
  kind: "ISSUE_SLA_BREACH",
  actor: { kind: "system" },
  subjectType: "issue",
  subjectId: issue.id,
  payload: {
    issueKey: issue.key,
    slaMinutes: issue.slaMinutes,
    ageMinutes: 145,
  },
});
```

## What's shared across all three layers

- **Events flow through `recordChange()`.** Every emission writes an
  `AuditLog` row, an `ActivityEvent` row, queues `WebhookDelivery` rows
  for subscribed plugins, and best-effort publishes to Redis pub/sub for
  SSE. See [Activity & Audit](/concepts/activity-and-audit.html).
- **AI Coach is automatic.** If a `COACH`-role agent exists in the
  workspace and `Workspace.aiCoachEnabled = true`, every emission also
  triggers a Coach comment. Coach failures are swallowed — they never
  block the underlying event. See
  [AI Triage & Coach](/agents/ai-triage-and-coach.html).
- **Idempotency is per-event-kind, 24-hour grace.** Each layer maintains
  its own dedupe key; they don't interfere with each other.
- **Each layer is independently togglable.** You can run noack without
  stale-work, SLA without noack, etc. The knobs are independent columns
  on `Workspace`.

::: warning
Don't disable all three layers and expect the dispatcher to be enough.
Auto-dispatch can pick agents that are reachable and have capacity, but
nothing in dispatch is checking whether work is actually progressing —
that's what the watchdogs are for.
:::

## Lifecycle of a stuck issue

```
ISSUE_QUEUED
   ↓ (no agent acks within requiredAckSeconds)
AGENT_NOACK  ←-- Coach posts comment
   ↓ (still no movement, assignmentSlaMinutes elapses)
ISSUE_STALLED  ←-- Coach posts comment
   ↓ (issue age > slaMinutes)
ISSUE_SLA_BREACH  ←-- Coach posts comment
```

In a healthy workspace, this chain stops at the first arrow. The most
common stop point — and the one with the best signal-to-noise ratio — is
`AGENT_NOACK`, which fires on a tight clock (seconds, not minutes) and
unambiguously means the agent didn't process the assignment. By the time
you see `ISSUE_STALLED` or `ISSUE_SLA_BREACH`, the issue has been off-track
long enough that something more than a Coach comment is probably needed.

## Cross-references

- [Auto-dispatch](/agents/auto-dispatch.html) — the dispatcher whose output
  these layers police.
- [AI Triage & Coach](/agents/ai-triage-and-coach.html) — what posts the
  diagnostic comments.
- [Concepts → Activity & Audit](/concepts/activity-and-audit.html) — how
  events get written and fanned out.
- [Reference → Events](/reference/events.html) — the full `EventKind`
  enumeration including `ISSUE_STALLED`, `AGENT_NOACK`, and
  `ISSUE_SLA_BREACH`.
- [Engagement Modes](/agents/engagement-modes.html) — the auto-transition
  to started on assignment now fires only for `EXECUTE`-mode assignments
  (`RESEARCH` / `REVIEW` / `DISCUSS` leave issue status alone); the run
  carries `engagementMode`.
