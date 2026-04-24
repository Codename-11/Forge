# Forge — TODO & Gaps

> Living backlog. Triage order: P0 → P3. Strikethrough = shipped.

## P0 — Agent Integration (shipped 2026-04-20)

### Agent identity & assignment — ✅ done

- [x] `Agent` model (`profileKey`, `webhookUrl`, `webhookSecret`,
  `capabilities[]`, `status`, `lastHeartbeatAt`, `maxConcurrent`,
  `lastDispatchedAt`)
- [x] `Issue.assignedAgentId` — explicit assignment vs pool claim
- [x] `ApiKey.linkedAgentId` — key identity reverse-lookup
- [x] MCP tool: `issues.assigned` — "what's assigned to me?" (infers
  agent from `linkedAgentId` or accepts explicit `profileKey`)
- [x] MCP tool: `issues.assign` — assign issue to a specific agent
  (WRITE_ISSUES)
- [x] Agent view in UI at `/settings/agents` — list, create, edit,
  archive, delete with typeToConfirm
- [x] Assignee picker on issue detail (`⇧A` chord)
- [x] Sidebar nav (`g e`)

### Webhook push dispatch — ✅ done

- [x] `WebhookDelivery` fan-out in `recordChange` — batched insert of
  one row per subscribed `Webhook`, in the same transaction as the
  `ActivityEvent`
- [x] Agent-targeted dispatch via synthetic per-workspace webhook
  (url `agent:dispatch`) + synthetic per-agent webhook
  (`agent:dispatch:{agentId}`) for comment mentions
- [x] Worker resolves real URL from `Issue.assignedAgent.webhookUrl`;
  HMAC with `Agent.webhookSecret` when present
- [x] Events fired on: `ISSUE_QUEUED` (queue transition),
  `AGENT_ASSIGNED` (assignment delta), `COMMENT_CREATED` (with
  `mentions[]` payload), `ISSUE_PRIORITY_CHANGED` (with from/to)

### Auto-dispatch — ✅ done

- [x] `Workspace.autoDispatch` — master toggle (default off)
- [x] `Workspace.autoDispatchMode` — `MANUAL_ONLY | ROUND_ROBIN |
  PRIORITY_MATCH | CAPABILITY_MATCH`
- [x] `Workspace.autoStartOnAssign` / `agentIdleTimeoutMinutes` /
  `requireApprovalBeforeStart` columns
- [x] `src/server/services/dispatcher.ts::maybeAutoDispatch` —
  invoked from `issue.create` and `issue.setQueued` inside tx
- [x] Dispatcher tests: 8 cases covering all modes + `maxConcurrent`
  ceiling + idempotency

### Hermes-side integration — consumer work, not Forge

- [ ] Hermes `forge.auto_claim` / `auto_start` / `poll_interval` /
  `show_inbox_on_greeting` / `max_concurrent_claims` config
- [ ] Hermes webhook receiver that routes by `agent:dispatch:{agentId}`
  back to the correct profile
- [ ] Hermes task-inbox surface on session greeting
- [ ] Completion flow — agent auto-transitions issue to Done/In Review,
  drops summary comment, releases claim

---

## P1 — Phase 3 MCP tools (shipped 2026-04-20)

- [x] `cycles.list` / `cycles.get` / `cycles.create` / `cycles.plan` /
  `cycles.addIssue` / `cycles.removeIssue`
- [x] `initiatives.list` / `initiatives.get`
- [x] `relations.add` / `relations.remove`
- [x] `time.start` / `time.stop` / `time.log`
- [x] `attachments.initUpload` / `attachments.finalize` /
  `attachments.list`

---

## P1 — High-value follow-ups (shipped 2026-04-23)

- [x] **Dead-letter inspection UI** — `admin.webhookDeliveries.list` +
  `.retry` + page at `settings/integrations/deliveries`. Retry writes
  `AuditLog` directly (no fitting `EventKind`).
- [x] **Agent identity in comments** — `Comment.authoringAgentId`
  (migration `0003`). `comment.create` stamps from
  `ctx.apiKey.linkedAgentId`. Renderer shows agent name + indigo
  `AGENT` chip.
- [x] **Heartbeat-driven auto-offline** — `maintenance` BullMQ queue +
  `sweepIdleAgents` runs every 60s, per-workspace
  `agentIdleTimeoutMinutes`. Emits new `AGENT_STATUS_CHANGED`
  `EventKind` (migration `0004`).
- [x] **Observability for dispatch decisions** —
  `AGENT_ASSIGNED.payload.dispatch = { mode, candidates[], chosen,
  reason }`. Ineligible candidates included with `eligible: false`.
  No table — JSON enrichment.
- [x] **Handoff flow** — `issues.reassign` MCP tool (tool 44).
  `rationale.min(10)`, rejects same-agent, forces comment, fires
  `AGENT_ASSIGNED` with `reason: "handoff"`.
- [x] **Bulk label / bulk assign on issues** — `issue.bulkSetLabels`,
  `bulkAssign`, `bulkAssignAgent`. `max(500)` per call, per-issue
  `recordChange`. UI: `BulkLabelPicker` (mixed-state add/remove) +
  `BulkAssigneePicker` (Humans/Agents tabs).

---

## P2 — Existing deferred

- [ ] Email invite flow
- [ ] BullMQ webhook delivery worker — separate container (AXI-4)
  currently co-located with forge main process
- [ ] Per-agent permission lattice (beyond ApiKey scopes) — e.g.
  "Victor can only touch issues he's assigned" without needing
  workspace-wide WRITE_ISSUES

---

## P3 — Nice to have

- [ ] Agent heartbeat / presence (agents ping every N minutes, UI
  shows online/offline) — partial: we have the column but no UI
  indicator beyond the status dot on the agents list
- [ ] Issue templates per agent (when agent claims, auto-populate
  description with structured checklist)
- [ ] Dispatch analytics — mean time to claim, mean time to complete,
  agent throughput
- [ ] Slack/Discord notification bridge (Forge → channel on
  assignment/completion)
- [ ] Dispatch rules engine (phase 2) — labels/priorities/projects →
  specific agents. E.g., `priority=URGENT → victor`,
  `label=ops → mizu`. Current auto-dispatch covers this via
  `CAPABILITY_MATCH` but a rules surface in UI would beat freeform
  capability strings.
