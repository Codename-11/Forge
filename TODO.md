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

## P1 — High-value follow-ups (discovered during dogfooding)

- [ ] **Dead-letter inspection UI** — admin page listing recent
  `WebhookDelivery.status === DEAD_LETTER` rows with response body +
  "retry" button. Webhook failures are currently only visible via DB.
- [ ] **Agent identity in comments** — add `Comment.authoringAgentId`
  or an actor discriminator on `recordChange` so an agent-authored
  comment renders as "Victor (agent)" rather than the human key owner.
- [ ] **Heartbeat-driven auto-offline** — scheduled job that flips
  `Agent.status → OFFLINE` when `lastHeartbeatAt` is older than a
  workspace-configurable window (default 10 min).
- [ ] **Observability for dispatch decisions** — persist `{mode,
  candidates, chosen, reason}` on the `AGENT_ASSIGNED` payload (or a
  new `DispatchLog` table) so "why Victor and not Mizu" is queryable.
- [ ] **Handoff flow** — `issues.reassign` MCP tool that takes a
  rationale, forces a comment, and swaps `assignedAgentId`. Cheaper
  than each caller stitching `issues.assign` + `comments.create`.
- [ ] **Bulk label / bulk assign on issues** (already in P2, bumped)

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
