# Forge — TODO & Gaps

> Living backlog. Triage order: P0 → P3. Strikethrough = shipped.

## Misc findings

- [~] GitHub PRs should be linked to an issue automatically (or by the
      agent) when relevant. Agents should have proper access to manage
      GitHub links + attachments in Forge.
      - [x] Issue-page link modal (URL / `owner/repo#123` / browse) with
            inline remediation (connect repo / resume / install) — shipped
            2026-06-24.
      - [x] Agents can discover linkable repos (`github.listMappings`) and
            already have `github.link` / `search` / `sync` / `importIssue`
            + attachment tools.
      - [ ] *Auto*-link a PR to its issue when relevance is detectable
            (e.g. PR title/body references the issue key, or a branch/issue
            convention) — not yet built.

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

- [x] ~~Email invite flow~~ — **superseded 2026-04-23**. Authelia
      is the identity source; self-service invites don't fit. Replaced
      with admin-gated `/settings/members` (listMembers, addMember,
      setMemberRole, removeMember). Migration `0007_membership_events`.
- [ ] BullMQ webhook delivery worker — separate container (AXI-4)
      currently co-located with forge main process
- [ ] Per-agent permission lattice (beyond ApiKey scopes) — e.g.
      "Victor can only touch issues he's assigned" without needing
      workspace-wide WRITE_ISSUES

---

## P1 — Task follow-through (push-dispatch reliability)

Push-dispatch (2026-04-25) made delivery bulletproof — Forge POSTs
to Hermes' webhook adapter, the worker drains PENDING rows on a 5s
sweep, retries with backoff, and bumps `lastHeartbeatAt` on each
success. **What's still missing:** there is no guarantee the agent
actually does the work after the wake event lands. Hermes returns
202 immediately; if the LLM call drops mid-thought, nothing notices.

Three layers, increasing in scope. Pick up in order:

- [x] **(1) Stale-work watchdog (assignment SLA)** — shipped
      2026-04-25. `Workspace.assignmentSlaMinutes` (default 0 =
      disabled) + `Workspace.autoRedispatchOnStall` (default false)
      knobs. Migration `0009_stale_work_watchdog`. New EventKind
      `ISSUE_STALLED`. Maintenance worker `stale-work-sweep` job
      every 60s emits the event for assigned BACKLOG/TODO issues
      past the cutoff; idempotent within a 1h grace; optionally
      clears `assignedAgentId` and re-runs the auto-dispatcher.
      Surfaced in activity drawer, agent timeline, issue activity
      panel, and as a Sonner warning toast. Workspace settings UI
      knob in a new "Agent SLA" section.

- [x] **(2) Required acknowledgement** — shipped 2026-04-25.
      `Workspace.requiredAckSeconds` (default 0 = disabled) +
      `Workspace.autoRedispatchOnNoack` (default false). New
      `AGENT_NOACK` EventKind. Worker schedules a delayed
      `required-ack-check` BullMQ job per successful AGENT_ASSIGNED
      delivery; the job checks for a follow-up `COMMENT_CREATED`
      authored by the agent OR an `ISSUE_STATUS_CHANGED` actor-event
      on the same issue within the window. If neither, emits
      AGENT_NOACK and (when configured) clears assignedAgentId so
      the dispatcher re-picks. Idempotent on `originalAssignedEventId`.
      Surfaces in activity drawer, agent timeline, issue activity
      panel, and as a `toast.warning`.

- [x] **(3) Real SLA enforcement** — shipped 2026-04-25.
      `Workspace.slaEnforcementEnabled` (default false) gates the
      sweep. Per-issue `Issue.slaMinutes` (already in schema) is the
      cutoff. New `ISSUE_SLA_BREACH` EventKind. Maintenance worker
      `sla-breach-sweep` job runs every 60s; emits the event for
      non-DONE/CANCELED issues past `slaMinutes` from `createdAt`.
      Idempotent within 24h grace per issue. Surfaces in activity
      drawer, agent timeline, issue activity panel, and as a
      `toast.warning`.

---

## UX polish wave (shipped 2026-04-24)

- [x] **MinIO compose + storage misconfig surface** — `forge-minio`
      service in `docker/docker-compose.yml` (host ports 59000/59001), `S3_*`
      vars in `.env*`. New `StorageNotConfiguredError` typed exception +
      `isStorageConfigured()` helper. Attachment router maps the typed error
      to `PRECONDITION_FAILED`. `IssueAttachmentsPanel` shows an inline
      `StorageNotConfiguredBanner` with the exact env vars to set;
      `MarkdownWithAttachments` shows a clear "Attachment unavailable —
      storage error" pill with the error in the title.
- [x] **Per-user Appearance prefs** — `User.density` /
      `User.textSize` (migration `0008`). New `userRouter.me` +
      `updateAppearance`. `AppearanceProvider` mirrors prefs onto
      `<html data-density data-textsize>`. Auto-saving page at
      `/settings/appearance` with live-preview row. Four density-aware
      utility classes (`text-id`, `text-meta`, `text-filename`,
      `text-subtitle`) cascade on the data attributes.
- [x] **Cycles → Sprints (UI rename only)** — sidebar nav, page titles,
      buttons, tooltips, placeholders, keyboard help. Data model, tRPC
      routers, routes, folder names, `Workspace.cycleLengthDays`, and MCP
      namespace `cycles.*` all stay `cycle*`. Future: full data-layer rename
      if needed (separate migration pass).
- [x] **Empty states across pages** — Issues, Inbox, Analytics, Sprints,
      Roadmap, Standup. Each has its own voice; CTAs route to creation
      surfaces where appropriate.
- [x] **Quick-create overlay polish** — wider (`max-w-3xl`), bigger
      input (`text-base`), real ModeChip dropdown so users can switch
      Issue/Sprint/Project/Initiative without navigating first.
- [x] **Pathname-aware sidebar "New X"** — label adapts: `/projects` →
      "New project", `/cycles` → "New sprint", `/initiatives` → "New
      initiative", else "New issue".
- [x] **Onboarding re-entry** — `useOnboardingDismissed` + dashboard
      topbar `<ResumeSetupPill>` reappears when card was dismissed mid-flow.
- [x] **Tooltip / subtext sweep** — workspace settings (Sprint length,
      Cooldown, Attachment quota), Agents page (`profileKey`, capabilities,
      webhookUrl, maxConcurrent), Dispatch rules subtitle.
- [x] **Density class application** — issue IDs across dashboard /
      projects / initiatives, activity timestamps, filename overlays, topbar
      subtitle now respond to the user's Appearance setting.
- [x] **Life Ops-compatible issue templates** — first `template.list`
      call seeds generic dev task, agent-ready task, home/personal task,
      finance follow-up, side quest, and review item templates. Agent-ready
      includes objective, system area, acceptance criteria, safety/approval
      boundaries, and verification path.
- [x] **Agent queue visibility** — Inbox now surfaces queued issues with
      ready/blocked/claimed states, assigned-agent presence, and queue counts
      so backlog, assignment, and claim states are visibly distinct.

---

## P3 — Nice to have (shipped 2026-04-23)

- [x] **Agent presence indicators** — new `AgentPresenceDot`
      primitive (tokens only, motion-safe pulse, heartbeat title).
      Placed on issue list, board cards, detail assignee chip + picker,
      bulk assignee picker, agents settings list. RealtimeProvider
      invalidates on AGENT\_\* events.
- [x] **Per-agent issue templates** — `Agent.templateMarkdown`
      (migration `0005`). Applied via `maybeApplyAgentTemplate` at all
      4 assignment paths, guarded by empty-description check. Audit-only
      (`ISSUE_UPDATED` with `fromAgentTemplate: true`).
- [x] **Dispatch analytics** — `analytics.dispatch.summary` +
      `.timeseries`. TTFA uses LATERAL join bounded by next AGENT_ASSIGNED
      to isolate re-assignments. UI tab, SVG line chart, stacked-bar mode
      distribution. No schema, no new deps.
- [x] **Notification bridge plugin** —
      `plugins/notification-bridge/` with pure `formatEvent` + Slack/Discord
      webhook POSTs. Config in `Plugin.manifest.config`. `mentionsOnly`
      filter + blocklist for noisy kinds.
- [x] **Dispatch rules engine** — `DispatchRule` table (migration
      `0006`). Rules consulted before mode switch, ordered + ANDed,
      wildcards on null. Target-ineligible falls through; reason string
      preserves provenance. Drag-n-drop UI reusing Statuses pattern.
