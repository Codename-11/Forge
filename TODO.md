# Forge — TODO & Gaps

> Living backlog of identified gaps. Triage order: P0 → P3.

## P0 — Agent Integration (Hermes first-class)

### Agent identity & assignment

The MCP surface currently only supports anonymous pool-based `issues.claim`. There's no concept of targeted assignment or agent-aware routing.

**Needs:**
- [ ] `Agent` model (or role on `User`) — `name`, `profileKey` (e.g. `victor`, `mizu`), `webhookUrl`, `capabilities[]`, `status` (online/offline/busy)
- [ ] `assignedAgentId` on `Issue` — explicit assignment vs pool claim
- [ ] MCP tool: `issues.assigned` — "what's assigned to me?" (filters by the calling key's agent identity)
- [ ] MCP tool: `issues.assign` — assign issue to a specific agent (requires WRITE_ISSUES)
- [ ] Agent view in UI — see which agents are registered, their current load, claimed issues, last heartbeat

### Webhook push dispatch

Currently no way to push work to agents. Requires AXI-4 (BullMQ worker container) plus:

- [ ] Wire `WebhookDelivery` to fire on: issue queued, issue assigned, issue commented (@mention), issue priority escalated
- [ ] Hermes webhook receiver endpoint (already exists at `/api/webhooks` in Hermes API server — needs Forge-specific handler)
- [ ] Delivery payload includes enough context for the agent to act without round-tripping (title, description, priority, project, status)

### Auto-dispatch system

Configurable per-workspace (settings-driven, not hardcoded):

- [ ] `Workspace.autoDispatch` — master toggle (default: off)
- [ ] `Workspace.autoDispatchMode` — `round_robin` | `priority_match` | `capability_match` | `manual_only`
- [ ] `Workspace.autoStartOnAssign` — when an issue is assigned (manually or auto-dispatched), immediately push webhook to start work (default: off)
- [ ] `Workspace.agentIdleTimeoutMinutes` — if a claimed issue sees no activity (comments, transitions) within this window, auto-release back to pool
- [ ] `Workspace.requireApprovalBeforeStart` — gated dispatch: issue lands in agent's queue but doesn't start until human approves (default: off)
- [ ] Dispatch rules engine (phase 2): labels/priorities/projects → specific agents. E.g., `priority=URGENT → victor`, `label=ops → mizu`

### Hermes-side integration (consumer)

Hermes needs a first-class "tasks" surface so agents see their work without manual polling:

- [ ] **Task inbox** — agent-facing view of assigned/claimed issues. Shows in session greeting or on-demand via command. Structured like: "You have 3 tasks: AXI-5 [HIGH, In Progress], AXI-8 [MEDIUM, Todo], AXI-21 [HIGH, Backlog]"
- [ ] **Webhook handler** — receives Forge dispatch events, routes to correct profile, optionally auto-starts work
- [ ] **Config flags** in Hermes `config.yaml`:
  ```yaml
  forge:
    auto_claim: false          # Poll queue and auto-claim when idle
    auto_start: false          # Start working immediately on assignment/claim
    poll_interval: 0           # Minutes between queue checks (0 = disabled, webhook-only)
    show_inbox_on_greeting: true  # Show task count in session greeting
    max_concurrent_claims: 1   # How many issues agent can hold at once
  ```
- [ ] **Session awareness** — if agent is mid-task on AXI-X, new assignments queue locally rather than interrupting
- [ ] **Completion flow** — when agent finishes work, auto-transition issue to Done/In Review, drop summary comment, release claim

---

## P1 — Phase 3 MCP tools

New primitives from 2026-04-20 push need MCP surface:

- [ ] `cycles.list` / `cycles.get` / `cycles.create` / `cycles.addIssue` / `cycles.removeIssue`
- [ ] `initiatives.list` / `initiatives.get`
- [ ] `issues.relate` / `issues.unrelate` (typed: blocks, duplicates, related)
- [ ] `time.start` / `time.stop` / `time.log` (manual entry)
- [ ] `attachments.upload` / `attachments.list` (MinIO-backed)

---

## P2 — Existing deferred

- [ ] Email invite flow
- [ ] Bulk label / bulk assign on issues
- [ ] BullMQ webhook delivery worker — separate container (AXI-4, prerequisite for dispatch)

---

## P3 — Nice to have

- [ ] Agent heartbeat / presence (agents ping every N minutes, UI shows online/offline)
- [ ] Issue templates per agent (when agent claims, auto-populate description with structured checklist)
- [ ] Dispatch analytics — mean time to claim, mean time to complete, agent throughput
- [ ] Slack/Discord notification bridge (Forge → channel on assignment/completion)
