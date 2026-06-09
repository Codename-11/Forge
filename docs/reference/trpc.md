# tRPC Routers

The in-app contract. The canonical surface is the `AppRouter` type exported
from `src/server/routers/_app.ts`. Use the typed client (`trpc.*`) from React
client components and server components — input validation, output types, and
error shapes all flow from this router definition.

## Conventions

- All write procedures validate input with **Zod**, run inside a Prisma
  `$transaction`, and call `recordChange()` (audit + event + Redis fan-out
  in one atomic step).
- All read and write procedures are scoped to the caller's active workspace
  via `workspaceProcedure` / `adminProcedure` in `src/server/trpc.ts`.
- Self-service email invite is **disabled** — `workspace.invite` throws
  `PRECONDITION_FAILED`. Use `workspace.addMember` (admin-gated).
- The product label "Sprint" is UI-only. The data model, tRPC router, route
  paths, and MCP namespace stay `cycle*`.
- `template.list` seeds generic issue templates on first use (dev task,
  agent-ready task, home/personal task, finance follow-up, side quest,
  review item).
- Rate limits via `withRateLimit(limit, windowSec)` middleware are
  per-`(userId, procedure)`; default is none — added explicitly on hot
  paths.

## Router catalog

| Router            | Procedures                                                                                                      |
|-------------------|-----------------------------------------------------------------------------------------------------------------|
| `workspace`       | `list`, `current`, `create`, `listMembers`, `addMember`, `setMemberRole`, `removeMember` (admin)                |
| `project`         | `list`, `byId`, `create`, `update`, `archive`                                                                    |
| `issue`           | `list`, `byId`, `create`, `update`, `assign`, `softDelete`, `snooze`, `unsnooze`, `snoozeMany`, `nudge`, `bulkTransition`, `bulkAddLabel`, `bulkRemoveLabel`, `bulkAssign`, `bulkAssignAgent`, `bulkArchive`, `applyCommands`, `watch`, `unwatch`, `watchers`, `watching` |
| `comment`         | `create`, `update`, `softDelete`                                                                                 |
| `analytics`       | `summary`, `statusDistribution`, `throughput`, `cycleTime`, `slaBreaches`, `dispatch.summary`, `dispatch.timeseries` |
| `plugin`          | `list`, `byId`, `register`, `restoreBackup`, `exportBackup`, `approve`, `suspend`, `issueApiKey`, `revokeApiKey`, `remove`, `rotateSecret` |
| `status`          | `list`, `create`, `reorder`                                                                                      |
| `template`        | `list`, `byId`, `create`, `update`, `delete` (issue templates)                                                   |
| `projectTemplate` | `list`, `create`, `update`, `delete`                                                                             |
| `agent`           | `list`, `byId`, `byProfileKey`, `create`, `update`, `archive`, `delete`, `testWebhook`, `heartbeat`, `pipeline`, `timeline`, `uptime`, `webhookHealth` |
| `agentRun`        | `activeForIssue`, `events`, `activeAll`, `recentTerminal`, `heatmap`, `eventsInRange`, `recentEventCounts`, `coachDiagnosis`, `runsInRange`, `eta`, `abandon`, `redispatch`, `nudge` |
| `chat`            | `threads`, `defaultThread`, `thread`, `createConversation`, `forkThread`, `updateConversation`, `setOverride`, `markRead`, `compactThread`, `clearThread`, `getThread`, `send`, `createPendingMessage`, `dispatchMessage`, `appendAgentMessage`, `threadDiagnostics`, `chatReadiness`, `retryLastUserMessage`, `kickThreadRun`, `stopThreadRun`, `deleteThread`, `archiveThread`, `restoreThread`, `history` |
| `event`           | `recent`, `unreadCount`                                                                                          |
| `dispatchRule`    | `list`, `create`, `update`, `reorder`, `toggle`, `delete` (admin)                                                |
| `admin`           | `webhookDeliveries.list`, `webhookDeliveries.retry` (admin)                                                      |
| `user`            | `me`, `updateAppearance`                                                                                         |
| `cycle`           | `list`, `byId`, `current`, `create`, `update`, `plan`, `rollover`, `addIssue`, `removeIssue`                     |
| `initiative`      | `list`, `byId`, `create`, `update`, `linkProject`, `unlinkProject`                                               |
| `relation`        | `add`, `remove`, `listForIssue`                                                                                  |
| `time`            | `start`, `stop`, `log`, `list`, `summary`, `running`                                                             |
| `attachment`      | `initUpload`, `finalize`, `attachLink`, `list`, `getDownloadUrl`, `delete`                                       |
| `access`          | `list`, `create`, `update`, `revoke`, `delete`, `rotate`, `createPersonal`, `createSession`                      |
| `integration`     | `list`, `byKind`, `applyToAgent`                                                                                 |
| `runtime`         | `list`, `byId`, `register`, `heartbeat`, `archive`, `update`                                                     |
| `pin`             | `list`, `set`, `toggle` (legacy issue-only); `listAll`, `add`, `remove`, `toggleEntity`, `reorder` (polymorphic) |
| `recentItem`      | `list`, `track`                                                                                                  |
| `commandPalette`  | `search`                                                                                                         |
| `savedView`       | `list`, `create`, `update`, `delete`                                                                             |
| `note`            | `list`, `create`, `update`, `archive`, `unarchive`, `delete`, `convertToIssue`, `todayJournal`, `listJournal`     |
| `inbox`           | `list`, `badge`, `visit`                                                                                         |
| `dashboard`       | `suggestions`, `stalledInProgress`                                                                               |
| `notification`    | `list`, `markRead`, `markAllRead`, `dismiss`                                                                     |

## Notable procedures

### `agent.pipeline`

Returns the operator's per-agent dashboard data:

```ts
{
  pool: {
    ready: Issue[],   // queued, unassigned, no open BLOCKED_BY relations
    blocked: Issue[], // queued, unassigned, has at least one open blocker
  },
  lanes: Array<{
    agent: Agent,
    counts: {
      assigned: number,        // BACKLOG / TODO
      inFlight: number,        // IN_PROGRESS / IN_REVIEW
      recentlyDone: number,    // DONE within recentDays
      load: number,            // assigned + inFlight
    },
    assigned: Issue[],
    inFlight: Issue[],
    recentlyDone: Issue[],
  }>,
  generatedAt: string,
}
```

**Pool** holds queued+unassigned issues split by blocker presence — it is the
input to the dispatcher. **Lanes** slice each agent's queue into "to do",
"in flight", and "recently done" (default `recentDays = 7`). The shape is
optimized for the agents page so the UI can render the swimlane view in one
round trip.

### `agent.timeline`

Paged events filtered to `AGENT_*`, `ISSUE_QUEUED`, `ISSUE_STATUS_CHANGED`,
and `COMMENT_CREATED`. When `agentId` is supplied, the result narrows to
events about that agent (assignment, status flips, ack-on-issue comments).
Cursor-paginated:

```ts
const page = await trpc.agent.timeline.query({
  agentId: "cle9k4z...",
  limit: 50,
  cursor: undefined,
});
// page.items: ActivityEvent[], page.nextCursor: string | null
```

### `agent.uptime`

Walks `AGENT_STATUS_CHANGED` events over a `windowDays` window (default 7)
to compute presence:

```ts
{
  totalMs: number,
  onlineMs: number,
  busyMs: number,
  offlineMs: number,
  uptimePct: number,           // (onlineMs + busyMs) / totalMs
  currentStatus: AgentStatus,
  currentSince: string,        // ISO timestamp of last transition
  transitions: number,         // count of flips in window
}
```

The window is right-anchored at "now" and clipped on the left by the agent's
`createdAt`.

### `agent.webhookHealth`

Returns counts and recent rows from `WebhookDelivery` filtered by URL prefix
to the agent's synthetic dispatch shims (`agent:dispatch:{id}` and the
workspace-shared `agent:dispatch`). Used by the agent ops page to surface
delivery success/failure ratios per agent without joining through the
`Webhook` model.

### `agent.stalled`

Per-agent stalled visibility. Returns both flavours of "stalled":

```ts
agent.stalled({ agentId }) → {
  stalledRuns:    [{ id, issueId, currentStep, startedAt, lastEventAt, issue: { number, title, status, project, workspace } }],
  stalledIssues:  [{ id, number, title, updatedAt, status, project, workspace }],
  stalledThresholdDays: number, // 0 disables the issue bucket
}
```

- **Stalled runs** are `AgentRun` rows still `ACTIVE` whose `lastEventAt`
  is older than `STALE_RUN_MS` (5 min). UI signal — distinct from the
  watchdog that *closes* runs (`Workspace.agentRunStaleMinutes`).
- **Stalled issues** are issues currently assigned to the agent in an
  IN_PROGRESS / IN_REVIEW status that haven't been updated in
  `Workspace.stalledThresholdDays`. Snoozed rows are excluded. When
  `stalledThresholdDays === 0` the bucket is disabled and an empty array
  is returned.

Powers the per-agent "Stalled" bucket on the agent detail page; pairs
with the `agentRun.kick` mutation for the per-row Kick affordance.

### `dashboard.agentActivity`

Per-agent at-a-glance health for the dashboard "Agents" tile.

```ts
dashboard.agentActivity() → {
  agents: [{
    id, profileKey, name, avatar, status,
    lastHeartbeatAt,
    load,           // active runs for this agent
    maxConcurrent,  // 0 = ∞
    stalledRuns,    // active runs older than STALE_RUN_MS
    stalledIssues,  // assigned issues quiet past stalledThresholdDays
  }],
  stalledThresholdDays: number,
}
```

Sorted server-side by `stalledRuns desc → stalledIssues desc → load desc
→ name asc` so the worst-off agent renders first. Returns an empty
`agents` array when no non-archived agents exist; the tile hides itself
in that case.

### `inbox.waitingOnMe`

Conservative "agent is waiting on me" filter. Returns issues whose most
recent comment is from an agent and `@-mentions` the calling user, where
the caller hasn't replied since.

```ts
inbox.waitingOnMe({ limit? = 25 }) → {
  items: [{
    issue:       { id, number, title, status, project, workspace },
    lastComment: {
      id, body, createdAt,
      author: { kind: "agent", id, name, profileKey, avatar },
    },
  }],
}
```

Heuristic — by design, prefers false-negatives over false-positives. The
mention match is against `User.handle | name | email`'s lowercase
tokens. A future mention table would make this exact; the trade-off is
documented inline in `src/server/routers/inbox.ts`.

### `event.recent`

Last N workspace events filtered to relevant kinds (`ISSUE_*`,
`COMMENT_CREATED`, `AGENT_*`) with referenced issues and agents hydrated:

```ts
const events = await trpc.event.recent.query({
  limit: 100,
  mineOnly: false,
});
// events: Array<ActivityEvent & { issue?, agent?, actor? }>
```

`mineOnly: true` narrows to events where the caller is one of:
actor, comment author, issue claimer, or issue assignee.

### `event.unreadCount`

Cheap COUNT since `since` (defaults to 24 hours ago). The UI tracks
`lastReadAt` in `localStorage` and passes it as `since` — that keeps the
unread badge cheap (a single indexed `COUNT(*)` per poll) and does not
require a server-side read receipt model.

### `chat.*`

The chat router manages per-(workspace, user, agent) persistent threads.

| Procedure | Type | Summary |
|---|---|---|
| `threads` | query | List the caller's threads with all agents. Returns up to 75, newest last-message first, including `lastReadAt` for unread badges. |
| `thread({ agentId })` | mutation | Upsert and open a thread. Returns `{ thread, agent, messages }` (last 50 messages). |
| `getThread({ threadId })` | query | Fetch a concrete thread by id. Owner-scoped and includes `lastReadAt`, diagnostics, recent messages, and attachments. |
| `markRead({ threadId, readAt? })` | mutation | Move the caller's per-thread read anchor forward. Used by the Chat page and Mission Control Chat tab; timestamps never move backward. |
| `defaultThread({ agentId })` / `thread({ agentId })` | mutation | Upsert and open the caller's always-on DM thread for one agent. |
| `createConversation({ agentId, title?, topic?, ... })` | mutation | Create a named side conversation with an agent. |
| `forkThread({ threadId, fromMessageId? })` | mutation | Start a new conversation copied from an existing thread prefix. |
| `updateConversation({ threadId, title?, topic?, contextMode? })` | mutation | Update conversation metadata and context policy. |
| `setOverride({ threadId, provider? })` | mutation | Set or clear a per-thread provider override. |
| `compactThread({ threadId })` | mutation | Summarize older messages into durable context and keep recent messages live. |
| `clearThread({ threadId })` | mutation | Delete the thread's messages/attachments/events and reset summary context while preserving the thread row. |
| `send({ agentId, body, context? })` | mutation | Legacy tRPC send path: persist a USER message and trigger dispatch. The interactive UI now uses `/api/chat/stream` so runs/completions can stream. |
| `createPendingMessage({ threadId, ... })` / `dispatchMessage({ messageId })` | mutation | Two-step dispatch path used by clients that need an optimistic pending row before waking an agent. |
| `appendAgentMessage({ threadId, body, sourceRunId? })` | mutation | Agent-only path. Requires the calling API key's `linkedAgentId` to match the thread's agent; acknowledges the latest unfinished USER turn and returns `{ messageId }`. |
| `threadDiagnostics({ threadId })` | query | Return provider-neutral turn state, latest USER lifecycle, stream error/interruption, last run, and last delivery for the status rail. |
| `chatReadiness({ agentId, threadId? })` | query | Resolve whether chat reaches a model/runtime and report the effective transport/capabilities/hint. |
| `retryLastUserMessage({ threadId })` | mutation | Re-wake the latest dispatched USER message when a reply or delivery stalls. |
| `kickThreadRun({ threadId, runId })` | mutation | Emit a kick event for a stale active run linked to the conversation. |
| `stopThreadRun({ threadId, runId })` | mutation | Best-effort stop a live managed-runtime run and close the Forge mirror. |
| `archiveThread({ threadId })` / `restoreThread({ threadId })` | mutation | Hide or restore a conversation without deleting its history. |
| `deleteThread({ threadId })` | mutation | Permanently delete a conversation, its messages, and attachments; stops a live managed run when possible. |
| `history({ threadId, before?, limit })` | query | Paginate older messages. `before` is a date cursor; `limit` max 100. Scoped to the caller's own threads. |

### `agentRun.*` additions

In addition to the original `activeForIssue`, `events`, `activeAll`, `recentTerminal`,
and `heatmap` procedures, the following were added:

| Procedure | Type | Summary |
|---|---|---|
| `recentEventCounts({ windowMinutes?, bucketSeconds? })` | query | Per-minute bucketed event counts for the activity sparkline in Mission Control. Default 30-minute window, 60-second buckets. |
| `coachDiagnosis({ runId })` | query | Latest AI Coach comment for a run (or `null` when coaching is disabled). |
| `runsInRange({ fromMinutesAgo?, limit? })` | query | All runs (active + terminal) overlapping a sliding window. Powers the swimlane/Gantt view. |
| `eta({ runId })` | query | Predictive ETA based on median agent+label duration over the past 30 days. Returns `{ medianMs, sampleSize, etaMs }` or `null`. |
| `eventsInRange({ from, to, limit? })` | query | `AgentRunEvent` rows in an explicit time range with run+agent+issue summary. Powers the timeline scrubber. |
| `abandon({ runId, summary?, alsoUnassign? })` | mutation | Mark a run ABANDONED, optionally clear the issue assignment. |
| `redispatch({ runId })` | mutation | Abandon the current run, re-queue the issue, and trigger auto-dispatch. |
| `nudge({ runId, message? })` | mutation | Post a `@{profileKey} {message}` comment on the issue; the audit fan-out routes it to the agent's webhook. |
| `kick({ runId })` | mutation | Re-fire the dispatch webhook for a stalled run without changing assignment or `controlState`. Eligibility: run is `ACTIVE` and quiet 5+ minutes (`STALE_RUN_MS` from `src/lib/agent-stale.ts`). Younger runs return `{ ok: true, kicked: false }`; non-active runs throw. Records `AGENT_RUN_KICKED`. |

### `access.*`

Workspace API key management. Admin-gated for all mutations.

| Procedure | Summary |
|---|---|
| `list` | List non-plugin keys for the workspace. |
| `create` | Create a key with explicit `kind` (or infer from `linkedAgentId`). |
| `createPersonal` | Shorthand for `kind: PERSONAL`. No agent link. Permanent until revoked. |
| `createSession` | Shorthand for `kind: SESSION`. Requires `ttlHours` (1–168, default 24). Auto-expires. |
| `update` | Edit name or narrowing arrays. Scopes and hash are immutable. |
| `revoke` | Set `revokedAt`; immediately rejects all further calls. |
| `delete` | Hard-delete a non-plugin key. |
| `rotate` | Revoke and re-issue with the same name, scopes, and narrowing. Returns `rawKey` once. |

### `integration.*`

Read-only adapter manifest queries plus one mutation for tagging legacy agents.

| Procedure | Summary |
|---|---|
| `list` | Return all adapter manifests merged with matching agents in this workspace. |
| `byKind({ kind, presence? })` | Return one adapter manifest + its installed agents. `presence` disambiguates the two `CLAUDE` adapters. |
| `applyToAgent({ agentId, kind, presence? })` | Stamp an existing agent with the adapter's `provider` and `defaultRuntimeMode`. |

### `runtime.*`

CRUD for the `Runtime` primitive — the compute environment that hosts one
or more agents. See [/agents/runtimes.html](/agents/runtimes.html) for the
broader concept.

| Procedure | Summary |
|---|---|
| `list` | All non-archived runtimes for the workspace, with `_count: { agents }` and `owner` summary. |
| `byId({ id })` | Single runtime + its agents (id, name, profileKey, status, runtimeMode). |
| `register` | Create a runtime. `{ name, kind, endpoint?, providersAvailable }`. Sets `ownerId` from session. Used by the `forge` daemon and by admins manually wiring a REMOTE_HTTP runtime. |
| `heartbeat({ id })` | Bump `heartbeatAt`. The local daemon calls every 60s. |
| `update({ id, name?, providersAvailable? })` | Edit metadata. Endpoint and secret are not editable post-creation (rotate by archive + re-register). |
| `archive({ id })` | Soft-delete. Agents on the runtime keep their `runtimeId` but the runtime is hidden from the index. |

### `agent.unifiedTimeline`

Cursor-paginated merged timeline for a single agent — combines
`Comment` rows authored by the agent, `ActivityEvent` rows about the
agent, and `AgentRunEvent` rows for the agent's runs.

```ts
const page = await trpc.agent.unifiedTimeline.query({
  profileKey: "victor",
  before: undefined,
  limit: 50,
});
// page.rows: Array<{ kind: "comment" | "event" | "run-event", timestamp: Date, payload: ... }>
// page.nextBefore: Date | null
```

Cursor is `before` (lt on `createdAt`). Each source is fetched
independently with `take: limit` and merged client-side; a returned
page can be smaller than `limit` after the merge cuts off the trailing
rows from the longest source. The `AgentTimeline` component handles
this by gating "load more" on either `nextBefore == null` or zero new
rows.

### `note.*`

Per-(workspace, user) markdown scratchpad. The dashboard
`<QuickNotesWidget />` is the sole human consumer; the MCP namespace
`notes.*` mirrors a narrower agent-facing subset (no `unarchive`, no
`delete`, no `convertToIssue` — those are human-only).

| Procedure | Summary |
|---|---|
| `list({ archived?, kind?, limit? })` | Caller's notes ordered by `(pinned desc, updatedAt desc)`. Default `kind = NOTE`, unarchived. |
| `create({ title?, body, pinned?, kind?, journalDate? })` | Create a note for the calling user. `kind = JOURNAL` requires `journalDate` (or defaults to now). |
| `update({ id, title?, body?, pinned? })` | Patch a note the caller owns. `title: null` clears the title. Empty body allowed (for journal entries that are still being filled in). |
| `archive({ id })` | Soft-archive. |
| `unarchive({ id })` | Reverse archive. |
| `delete({ id })` | Hard-delete. Prefer `archive` — this is the cleanup path. |
| `convertToIssue({ id, projectId? })` | Spawn an Issue with `title = note.title \|\| first line of body` and `description = body`. The note is left in place. Returns `{ issueId, issueKey, number }`. |
| `todayJournal()` | Get-or-create today's `JOURNAL` entry for the caller, anchored to UTC midnight on the user's wall-clock date (driven by `User.timezone`). Idempotent across calls in the same day. |
| `listJournal({ from?, to?, limit? = 30 })` | List recent journal entries for the caller, ordered by `journalDate desc`. |

### `issue.watch / unwatch / watchers / watching`

Per-(issue, user OR agent) subscriptions. See
[Watching](/guide/watching.html) for the full breakdown.

| Procedure | Summary |
|---|---|
| `watch({ issueId })` | Add caller as watcher. Idempotent. Identity inferred from API key (`linkedAgentId` → agent-watch, otherwise user-watch). |
| `unwatch({ issueId })` | Remove caller's watch. No-op if not watching. |
| `watchers({ issueId })` | List watchers with hydrated `user` / `agent` identity fields. |
| `watching({ limit? = 50 })` | Issues the caller currently watches, ordered by issue `updatedAt desc`. Powers the inbox **Watching** section. |

### `issue.applyCommands`

Apply a list of slash commands to an existing issue (or create one
through `issue.create({ applyCommands })`). Each command is
best-effort; failures log a skip with reason but don't fail the call.
See [Slash commands](/guide/slash-commands.html) for the seven
recognised forms.

```ts
issue.applyCommands.mutate({
  issueId,
  commands: [
    { kind: "priority", level: "urgent" },
    { kind: "label", name: "deploy" },
    { kind: "watch" },
  ],
})
// → { results: [{ kind, status: "applied" | "skipped", reason? }] }
```

### `attachment.attachLink`

Records an external URL as an `Attachment` with `kind = LINK`. Same
input shape as the MCP `attachments.attachLink` tool: `{ targetType,
targetId, externalUrl, linkTitle? }`. When `linkTitle` is omitted,
Forge attempts a best-effort scrape of the page's `<title>` (5s
timeout, follows redirects, reads up to 64 KB) before falling back to
the URL hostname.

### `pin.*` (polymorphic)

The legacy issue-only procs (`list`, `set`, `toggle`) are preserved
verbatim for backward compat with existing Hermes/agent runtimes. New
consumers use the polymorphic surface:

| Procedure | Summary |
|---|---|
| `listAll({ workspaceId? })` | All pins for the caller, hydrated to small "card" objects. Dead targets are silently dropped. |
| `add({ targetType, targetId, workspaceId? })` | Add a pin. |
| `remove({ id })` | Remove by Pin id. |
| `toggleEntity({ targetType, targetId, workspaceId? })` | Convenience: add if absent, remove if present. |
| `reorder({ ids })` | Set `orderIndex` based on the array position. |

`targetType` is `PinTargetType` (`ISSUE` / `PROJECT` / `INITIATIVE` /
`SAVED_VIEW` / `CYCLE` / `AGENT`). `workspaceId` may be null for
cross-workspace pins (the legacy topbar-strip semantic).

### `recentItem.*`

| Procedure | Summary |
|---|---|
| `list({ limit? })` | Most-recently-visited entities for the caller in this workspace, hydrated. |
| `track({ targetType, targetId })` | Upsert a row. Server-side debounced 5s — fast nav doesn't spam writes. |

## Cross-references

- [/reference/mcp.html](/reference/mcp.html) — the agent-facing subset.
- [/reference/events.html](/reference/events.html) — event kinds and
  payloads consumed by `event.*`, `agent.timeline`, and `chat.*`.
- [/automation/api-keys.html](/automation/api-keys.html) — scopes that
  gate the MCP equivalents of these procedures.
- [/agents/chat.html](/agents/chat.html) — chat surface documentation.
- [/agents/integrations.html](/agents/integrations.html) — adapter manifest structure.
