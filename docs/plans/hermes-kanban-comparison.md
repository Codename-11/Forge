# Forge Agent Dispatch Inbox vs. Hermes Kanban — Design Comparison

**Date:** 2026-05-19  
**Scope:** Medium-depth comparison across work-state models, missed-event recovery, idempotency keys, and ack semantics.

## Q1: Work-State Models

### Hermes Kanban States
Hermes tracks 7 states (per `/home/bailey/.hermes/hermes-agent/hermes_cli/kanban_db.py:93`):
- `triage` → new, no assignee (rare)
- `todo` → has assignee, parents unmet
- `ready` → all parents done, awaiting dispatcher claim
- `running` → dispatcher claimed, worker spawned + active
- `blocked` → worker called `kanban_block(reason=...)`
- `done` → worker called `kanban_complete(...)`
- `archived` → manually or auto-archived (final)

### Forge Agent Dispatch Inbox States
Forge derives states from lifecycle fields (per `/home/bailey/forge/docs/plans/agent-dispatch-inbox-design.md:162`):
- `queued` → run/message created, no wake sent
- `wake-sent` → webhook delivery attempted (one or more times)
- `acknowledged` → agent set `acknowledgedAt` (ack read the dispatch)
- `running` → agent set `outputStartedAt` (first output appeared)
- `stalled` → no activity for threshold seconds; wake stale or agent silent
- `completed` → run/message in final state (reply sent, issue resolved, etc.)
- `abandoned` → manual or auto-abandoned (e.g., required-ack timeout)

### Mapping
| Hermes | Forge | Notes |
|--------|-------|-------|
| `todo`, `ready` | `queued` | Pre-dispatch work; Forge doesn't gate on parents |
| **[none]** | `wake-sent` | Hermes' `running` is post-dispatch; Forge distinguishes wake delivery from ack |
| **[none]** | `acknowledged` | Hermes has no explicit "ack" lifecycle field; workers move straight `ready → running` |
| `running` | `running` | Both: work in progress |
| `blocked` | `stalled` | Different trigger: Hermes is explicit worker call; Forge is deadline-driven timeout |
| `done` | `completed` | Terminal state |
| `archived` | `abandoned` | Manual/auto terminal state |

**Key divergence:** Hermes models "pull the task and start work" as one atomic transition (`claim_task` → `ready → running`); Forge models "wake sent" and "agent acknowledged" as separate steps. This reflects different architectures:
- Hermes: dispatcher spawns worker **process**; claim confirms spawn success.
- Forge: external agent **service** receives webhook; ack is explicit API call proving agent read the dispatch.

---

## Q2: Missed-Event Recovery

### Hermes Kanban Recovery
**Yes, Hermes has a self-poll loop.** (Per `/home/bailey/.hermes/hermes-agent/gateway/run.py:4721` and `kanban_db.py:3860`)

**Mechanism:**
- **Dispatcher tick interval:** 60 seconds (default, configurable in `kanban.dispatch_interval_seconds`).
- **What it polls:** Tasks in `status='ready'` with no active claim.
- **Recovery actions:**
  1. `release_stale_claims(conn)` — reclaims tasks whose TTL (15 min default) expired.
  2. `detect_crashed_workers(conn)` — detects PIDs no longer alive.
  3. `recompute_ready(conn)` — promotes `todo → ready` when parents complete.
  4. `claim_task()` — atomically tries to claim each ready task and spawn a worker.

**Heartbeats:** Workers can call `kanban_heartbeat(...)` to extend the claim TTL if long-running; if they don't, the dispatcher reclaims after 15 minutes and respawns.

**Indexing:** Indexed on `tasks(status, claim_lock)` and `tasks(created_at)` for efficient ready-queue scans.

### Forge Agent Dispatch Inbox Recovery
**Yes, Forge has a backstop, but it's external.** (Per `/home/bailey/forge/docs/plans/agent-dispatch-inbox-design.md:116–158`)

**Mechanism:**
- **MCP `runs.kick` (existing):** Operator or backstop worker calls this to bump wake telemetry and retry wake.
- **Worker-side `forge-inbox-poll` skill:** Runs on a separate cadence (not yet spec'd, but implied as external backup).
- **What it polls:** Rows in `AgentRun` or `ChatMessage` with `acknowledgedAt IS NULL` and `lastWakeAt` stale (or `wakeAttempts < N`).
- **Recovery actions:**
  1. Increment `wakeAttempts`, set `lastWakeAt`.
  2. Emit webhook retry (same dispatch event).
  3. Optional: emit `AgentRunEvent(kind="KICK")` for UI/audit trail.

**Ack semantics:** The `required-ack-check` worker job schedules on wake success but only if `acknowledgedAt` is still null; once acked, no further check needed.

**No heartbeat equivalent:** Forge's ack + output-start lifecycle fields are write-once; there's no ongoing heartbeat to extend a claim TTL.

**Indexing:** Index on `AgentRun(workspaceId, status, acknowledgedAt, lastEventAt)` and `ChatMessage(workspaceId, threadId, role, acknowledgedAt)`.

### Recovery Comparison
| Aspect | Hermes | Forge |
|--------|--------|-------|
| **Trigger** | Dispatcher tick every ~60s (embedded in gateway) | External `forge-inbox-poll` skill (not yet active) + manual `runs.kick` |
| **Detection** | Polls task table; checks TTL, PID aliveness, parent readiness | Polls run/message table; checks `acknowledgedAt` and `wakeAttempts` |
| **Action** | Reclaim + respawn worker process | Retry webhook delivery; optionally emit kick event |
| **Guarantee** | Automatic; embedded in gateway (always runs) | Manual or delegated; not automatic in current design |

**Verdict:** Hermes' recovery is **automatic and builtin**; Forge's is **delegated and event-driven**. Hermes will never lose a ready task; Forge relies on an operator-side skill to backstop missed wakes.

---

## Q3: Idempotency Key

### Hermes Kanban
**Uses an optional internal idempotency key, NOT an external event ID.**

Per `/home/bailey/.hermes/hermes-agent/hermes_cli/kanban_db.py:579, 1244, 1333–1338`:
```python
class Task:
    idempotency_key: Optional[str] = None  # line 579

def open_task(
    conn, ...,
    idempotency_key: Optional[str] = None,  # line 1244
):
    """If idempotency_key is provided and a non-archived task with that key
    exists, return its ID. Otherwise create a new task."""
    if idempotency_key:
        row = conn.execute(
            "SELECT id FROM tasks WHERE idempotency_key = ? "
            "AND status != 'archived'",
            (idempotency_key,),
        ).fetchone()
        if row:
            return row["id"]  # Idempotent: return existing
    # ... create new task with this idempotency_key ...
```

**How it's used:** Caller (usually an orchestrator profile) generates or passes an idempotency key (arbitrary string, often a derived hash or external identifier). When the same key arrives twice, Kanban returns the existing task ID instead of creating a duplicate.

**Hermes does NOT track the originating event ID.** The task has no `external_event_id` or `activity_event_id` field. The mapping (if needed) is caller-managed (e.g., an orchestrator might store "ActivityEvent.id → Kanban task.id" in its own memory or context).

**Index:** `tasks(idempotency_key)` at `/home/bailey/.hermes/hermes-agent/hermes_cli/kanban_db.py:874`.

### Forge Agent Dispatch Inbox
**Uses external event IDs as the canonical trigger identifier.**

Per `/home/bailey/forge/docs/plans/agent-dispatch-inbox-design.md:49–88`:
```prisma
model AgentRun {
  /// ActivityEvent.id that caused the wake (assignment, mention, etc.)
  triggerEventId       String?
  triggerKind          String?  // "AGENT_ASSIGNED", "COMMENT_CREATED", etc.
  ...
  @@index([workspaceId, triggerEventId])
}
```

**How it's used:** When an `ActivityEvent` is recorded, `ensureCanonicalFromEvent()` resolves the event to 0..N canonical work units (issue runs or chat messages). The `triggerEventId` is recorded on the run/message so that webhooks can be deduplicated and recovery can tie retry attempts back to the original event.

**Mapping:** Forge's `triggerEventId` directly mirrors `ActivityEvent.id` — no intermediate mapping table needed. One event may fan out to multiple runs (e.g., a comment mentioning 3 agents), but each run tracks its source event.

**Index:** `AgentRun(workspaceId, triggerEventId)` and `ChatMessage` has `dispatchedAt` (not event-id indexed).

### Idempotency Comparison
| Aspect | Hermes | Forge |
|--------|--------|-------|
| **ID style** | Optional internal key (caller-managed) | External `ActivityEvent.id` |
| **Deduplication** | Caller passes idempotency key on `open_task()`; Kanban looks up existing | `ensureCanonicalFromEvent()` does 1-time dedup at event time; subsequent retries use same run |
| **Event tracking** | No; task has no link back to original trigger | Yes; `triggerEventId` + `triggerKind` stored on every run |
| **Mapping table** | Caller's responsibility (optional) | Built into schema; no join needed |
| **Recovery usage** | Idempotency key can be passed to `claim_task()` if retrying manually | `triggerEventId` used to correlate wake retries with original event |

**Verdict:** Hermes delegates idempotency to the caller; Forge bakes it in. **Forge's approach is better for Hermes integration:** if `forge-inbox-poll` needs to kick a Hermes task, it can pass Forge's `ActivityEvent.id` (or a derived hash) as the Hermes `idempotency_key`, ensuring no duplicate task creation on retry.

---

## Q4: Ack Semantics

### Hermes Kanban
**No explicit ack field.** The state machine is:
- **Ready → Running:** `claim_task(conn, task_id)` (atomic CAS, per `kanban_db.py:1862`).
  - Dispatcher acquires the claim, records `claim_lock`, `claim_expires`, `worker_pid`.
  - Immediately spawns a worker subprocess.
- **Worker startup:** The worker's system prompt includes `KANBAN_GUIDANCE` auto-injected (per `kanban-worker` SKILL.md:14).
  - Worker must call `kanban_show(task_id)` to read the task body and understand what to do.
  - No explicit "I read it" signal — just the implicit assumption that spawning a process means work will proceed.
- **Output:** Worker calls `kanban_heartbeat()` or `kanban_complete()` / `kanban_block()` to signal progress.
- **Protocol assumption:** Dispatcher assumes that `claim → spawn` implies the worker will start reading soon. If the worker crashes before calling any lifecycle tool, the dispatcher's reap loop detects a stale PID and auto-blocks the task with a crash marker.

**Ack happens before worker spawns, not after,** and it's implicit in the claim+spawn rather than an explicit API call.

Per `kanban_db.py:1862–1878`, `claim_task()` is the only step that transitions to `running`; there's no subsequent "output-started" field.

### Forge Agent Dispatch Inbox
**Explicit two-step ack + output-started.**

Per `/home/bailey/forge/docs/plans/agent-dispatch-inbox-design.md:67–72, 139–150`:
```ts
/// Set when the agent has read the dispatch and intends to act.
/// Drives the UI transition from "wake sent" → "acknowledged".
acknowledgedAt       DateTime?

/// Set the first time the agent's reply/status output lands. Drives
/// the UI transition from "acknowledged" → "running".
outputStartedAt      DateTime?

// MCP-facing:
ackInboxItem(tx, { target: { runId } | { chatMessageId } }): Promise<void>
markOutputStarted(tx, { target: { runId } | { chatMessageId } }): Promise<void>
```

**Workflow:**
1. **Webhook delivers dispatch** → run created with `triggerEventId`, `acknowledgedAt=null`.
2. **Agent reads from `agent.inbox.list(status='unacked')`** → sees pending runs.
3. **Agent calls `agent.inbox.ack(runId)`** → sets `acknowledgedAt = now()`.
   - This is explicitly driven by the agent prompt (or auto-wired into skill calls); **not automatic**.
4. **Agent starts producing output** → calls `agent.inbox.outputStarted(runId)` or `chat.startDraft()` → sets `outputStartedAt = now()`.
5. **Webhook retry timer** respects these fields: retries pause after ack, escalate after output-stalled timeout.

**Auto-ack possibility:** Design notes (line 147) say ack "can be hard-wired into" an agent action recorder's first step, making it less prompt-dependent. Currently it's prompt-driven, but the infrastructure supports auto-ack.

### Ack Comparison
| Aspect | Hermes | Forge |
|--------|--------|-------|
| **Ack model** | Implicit (claim + spawn = acknowledged) | Explicit (two API calls: ack, then output-started) |
| **When ack happens** | Before worker process spawns | After agent reads dispatch from API |
| **Guarantee** | Spawn failure auto-blocks; workers are assumed to start reading | Ack is optional/prompt-driven; output-started is producer-side |
| **Retry implications** | If worker crashes pre-claim, TTL reclaims and respawns | If ack doesn't arrive, required-ack worker job escalates after timeout |
| **UI feedback** | "Running" starts as soon as claim succeeds | "Acknowledged" feedback delays until agent calls ack; typing animation only after ack |

### Hard-Wiring Ack into Forge
**Yes, it would slot in cleanly.** Current design allows:
```ts
// Inside recordAgentAction (first step of any agent output):
async function recordAgentAction(run, ...) {
  await markOutputStarted(tx, { target: { runId: run.id } });
  // If ack not yet set:
  if (!run.acknowledgedAt) {
    await ackInboxItem(tx, { target: { runId: run.id } });
  }
  // ... emit activity, chat message, etc. ...
}
```

This would eliminate prompt dependency: the **infrastructure guarantees** ack on first output, not the agent. Hermes could adopt the same pattern if it added an `acknowledgedAt` field to tasks.

---

## Summary: Consolidation vs. Enhancement

### Verdict: **Enhance, don't consolidate. Learn three patterns from Hermes.**

Forge and Hermes solve **different problems:**
- **Hermes Kanban:** Multi-profile **orchestration within a single Hermes instance**. Roles coordinate via SQLite board + subprocess spawning. State is **process-centric** (spawned = acknowledged).
- **Forge Agent Dispatch:** Single-operator **cross-instance agent dispatch**. An external agent service (Claude Code, Hermes agent, etc.) receives webhooks and calls back via MCP. State is **event-centric** (event → wake → ack → output).

**No code should be deleted.** However, Forge should:

1. **Adopt Hermes' automatic recovery pattern** (`forge-inbox-poll` skill should run on the gateway ticker, not external schedule). Reference: `/home/bailey/.hermes/hermes-agent/gateway/run.py:4721`.
   - Replace delegated `required-ack-check` logic with a built-in ticker that calls `runs.kick` for stale `acknowledgedAt`.

2. **Use external event IDs as Hermes does** (Forge already does this; good). Ensure `agent.inbox.ack` and output-started calls can be **auto-wired** into the first agent action, not prompt-driven. Reference: `/home/bailey/.hermes/hermes-agent/hermes_cli/kanban_db.py:1333`.

3. **Consider a heartbeat mechanism** for long-running output (chat drafts). Hermes workers can `kanban_heartbeat()` every N seconds; Forge agents have no equivalent. If chat drafts stay `outputStarted` for >5 min without new deltas, should they stall? Reference: `/home/bailey/.hermes/hermes-agent/hermes_cli/kanban_db.py:1976`.

**Files to cite for engineers:**
- Hermes dispatcher ticker: `/home/bailey/.hermes/hermes-agent/gateway/run.py:4721–4858` (embedded auto-recovery).
- Hermes idempotency: `/home/bailey/.hermes/hermes-agent/hermes_cli/kanban_db.py:1333–1338` (optional key, existing task lookup).
- Forge ack design: `/home/bailey/forge/docs/plans/agent-dispatch-inbox-design.md:139–151` (explicit two-step, auto-wireable).

