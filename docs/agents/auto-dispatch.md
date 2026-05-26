# Auto-dispatch

When an unassigned issue hits the queue, the dispatcher decides who picks
it up.

This page covers the master toggle, the four selection modes, the eligibility
rules every mode shares, the approval and push-timing knobs that gate the
final webhook fire, and the decision-provenance metadata you can use to
debug why a particular agent was (or wasn't) chosen.

## The master toggle

`Workspace.autoDispatch` is the on/off switch. When it's `false`, the
dispatcher is a no-op no matter what mode is selected; assignment is
human-only. When it's `true`, the configured `autoDispatchMode` runs
whenever:

- An issue moves from any other status into the queue (`status = TODO` with
  `assignedAgentId = null`), **or**
- An issue is created already in the queue, **or**
- An assignment is cleared while the issue is still queued (e.g. by the
  stale-work watchdog with `autoRedispatchOnStall = true`).

::: tip
Keep `autoDispatch` off until you have at least one agent online, otherwise
queued issues will sit and emit `ISSUE_STALLED` events without ever being
considered for assignment.
:::

## The four modes

`Workspace.autoDispatchMode` is one of four values. They differ only in how
they pick a candidate from the eligible pool — eligibility (next section) is
universal.

### MANUAL_ONLY

The dispatcher is a no-op. Assignment is human-only, via the assignee picker
or `issues.assign`. Useful when you want auto-dispatch infrastructure (rules,
SLAs, AI Coach) without auto-selection.

### ROUND_ROBIN

Picks the eligible agent with the oldest `lastDispatchedAt`. Null sorts
first, so brand-new agents pick up work immediately on their first cycle.

```ts
// Roughly equivalent to:
const candidates = await prisma.agent.findMany({
  where: eligibilityFilter,
  orderBy: [{ lastDispatchedAt: "asc" }, { createdAt: "asc" }],
});
const chosen = candidates[0];
```

The reason recorded on the AGENT_ASSIGNED payload is `"round-robin"`.

### PRIORITY_MATCH

Prefers agents whose `capabilities[]` contain the lowercase priority name of
the issue. So an `URGENT` issue prefers agents with `"urgent"` in their
capabilities; `HIGH` prefers `"high"`; and so on.

If multiple agents have the matching capability, the tie is broken by
round-robin (`lastDispatchedAt`). If **no** agent has the capability, the
dispatcher falls back to round-robin across the full eligible pool — rather
than stalling the queue.

The reason on a successful match is `"priority-match:urgent"` (or whichever
priority); on fallback, it's `"round-robin"`.

### CAPABILITY_MATCH

Scores each eligible agent by the size of the intersection between
`issue.labels[]` (lowercased label names) and `agent.capabilities[]`.
Highest count wins; ties break by round-robin.

Zero-match — i.e., no agent shares any label with the issue — does not stall
the queue. The dispatcher falls through to round-robin across the full
eligible pool.

The reason is `"capability-match:2/3"` (matched 2 of 3 issue labels) or
`"round-robin"` on fallback.

## Eligibility

Every mode (other than MANUAL_ONLY) considers the same eligibility filter:

- `archivedAt IS NULL` — the agent isn't archived.
- `status != OFFLINE` — the agent is `ONLINE` or `BUSY`.
- Either `maxConcurrent = 0` (unlimited), **or** the agent's count of active
  issues (`status NOT IN (DONE, CANCELED)`) is strictly less than
  `maxConcurrent`.

If no agent passes the filter, the dispatcher skips selection entirely; the
issue stays in the queue with `assignedAgentId = null`. A later state
change — agent comes online, capacity frees up — re-triggers dispatch.

::: info
`BUSY` agents stay eligible. `BUSY` is a soft signal that an agent is busy
on something else (e.g. a long-running task), not a do-not-route flag. Use
`maxConcurrent` to cap per-agent load; use `OFFLINE` to remove an agent
from rotation entirely.
:::

## Approval and push-timing

Two more knobs gate what happens once the dispatcher has picked someone.

- **`Workspace.requireApprovalBeforeStart`** — when true, the dispatched
  issue lands in the agent's queue (writes `assignedAgentId`, emits
  `AGENT_ASSIGNED`) but the **outbound webhook is suppressed** until a human
  approves. Approval surfaces as a one-click affordance in the agent
  pipeline view.
- **`Workspace.autoStartOnAssign`** — when true (and approval isn't blocking),
  `AGENT_ASSIGNED` immediately fires the agent's webhook. When false, the
  event is recorded but the webhook is deferred — useful when you want
  agents to pull from their queue on their own schedule rather than be
  pushed at.

Combine the two for fine-grained control: approval-gated push, approval-
gated pull, immediate push (default), and so on.

## Decision provenance

Every `AGENT_ASSIGNED` ActivityEvent payload carries a `dispatch` field with
the full decision context:

```json
{
  "dispatch": {
    "mode": "CAPABILITY_MATCH",
    "candidates": [
      { "id": "agt_victor", "score": 2 },
      { "id": "agt_mizu",   "score": 1 },
      { "id": "agt_rin",    "score": 0 }
    ],
    "chosen": "agt_victor",
    "reason": "capability-match:2/3"
  }
}
```

Reasons are short, structured strings:

- `"manual"` — set by humans via `issues.assign`; the dispatcher wasn't
  involved.
- `"round-robin"` — round-robin (either as the configured mode, or as the
  fallback path after a no-match).
- `"priority-match:high"` — priority match, with the matched priority name.
- `"capability-match:2/3"` — capability match, with `<intersect>/<labels>`.
- `"rule:<id>:<rule-reason>"` — declarative rule fired. See
  [Dispatch Rules](/agents/dispatch-rules.html).
- `"rule:<id>:target-ineligible,<mode-slug> pick"` — a rule matched but
  its target was offline or at capacity, so the dispatcher fell through.

Use this for analytics dashboards, fairness audits, or just "why didn't
victor get this one?" debugging.

## Configuring it via Settings

Settings → Workspace exposes every knob:

| Knob | Column |
| --- | --- |
| Auto-dispatch | `autoDispatch` |
| Mode | `autoDispatchMode` |
| Require approval before start | `requireApprovalBeforeStart` |
| Auto-start on assign | `autoStartOnAssign` |
| Idle timeout (minutes) | `agentIdleTimeoutMinutes` |
| Stale-work SLA (minutes) | `assignmentSlaMinutes` |
| Auto-redispatch on stall | `autoRedispatchOnStall` |
| Required-ack window (seconds) | `requiredAckSeconds` |
| Auto-redispatch on noack | `autoRedispatchOnNoack` |
| SLA enforcement | `slaEnforcementEnabled` |

Each one is editable in-place; the change writes a transactional audit row
and applies on the next dispatch cycle.

## Cross-references

- [Dispatch Rules](/agents/dispatch-rules.html) — declarative routing
  evaluated **before** mode-based selection.
- [SLAs & Watchdogs](/agents/slas-and-watchdogs.html) — what catches the
  cases where dispatch fails or stalls.
- [Engagement Modes](/agents/engagement-modes.html) — queued and
  auto-dispatched work defaults to the workspace assignment engagement
  mode (usually `EXECUTE`).
- [Agents → Overview](/agents/overview.html) — the eligibility-relevant
  columns: `status`, `maxConcurrent`, `lastDispatchedAt`, `archivedAt`.
