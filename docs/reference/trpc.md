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
| `issue`           | `list`, `byId`, `create`, `update`, `assign`, `softDelete`, `bulkStatus`, `bulkSetLabels`, `bulkAssign`, `bulkAssignAgent` |
| `comment`         | `create`, `update`, `softDelete`                                                                                 |
| `analytics`       | `summary`, `statusDistribution`, `throughput`, `cycleTime`, `slaBreaches`, `dispatch.summary`, `dispatch.timeseries` |
| `plugin`          | `list`, `register`, `approve`, `suspend`, `issueApiKey`, `revokeApiKey`                                          |
| `status`          | `list`, `create`, `reorder`                                                                                      |
| `template`        | `list`, `byId`, `create`, `update`, `delete` (issue templates)                                                   |
| `projectTemplate` | `list`, `create`, `update`, `delete`                                                                             |
| `agent`           | `list`, `byId`, `byProfileKey`, `create`, `update`, `archive`, `delete`, `testWebhook`, `heartbeat`, `pipeline`, `timeline`, `uptime`, `webhookHealth` |
| `agentRun`        | `activeForIssue`, `events`, `activeAll`, `recentTerminal`, `heatmap`, `eventsInRange`, `recentEventCounts`, `coachDiagnosis`, `runsInRange`, `eta`, `abandon`, `redispatch`, `nudge` |
| `chat`            | `threads`, `thread`, `send`, `appendAgentMessage`, `history`                                                     |
| `event`           | `recent`, `unreadCount`                                                                                          |
| `dispatchRule`    | `list`, `create`, `update`, `reorder`, `toggle`, `delete` (admin)                                                |
| `admin`           | `webhookDeliveries.list`, `webhookDeliveries.retry` (admin)                                                      |
| `user`            | `me`, `updateAppearance`                                                                                         |
| `cycle`           | `list`, `byId`, `current`, `create`, `update`, `plan`, `rollover`, `addIssue`, `removeIssue`                     |
| `initiative`      | `list`, `byId`, `create`, `update`, `linkProject`, `unlinkProject`                                               |
| `relation`        | `add`, `remove`, `listForIssue`                                                                                  |
| `time`            | `start`, `stop`, `log`, `list`, `summary`, `running`                                                             |
| `attachment`      | `initUpload`, `finalize`, `list`, `getDownloadUrl`, `delete`                                                     |
| `access`          | `list`, `create`, `update`, `revoke`, `delete`, `rotate`, `createPersonal`, `createSession`                      |
| `integration`     | `list`, `byKind`, `applyToAgent`                                                                                 |

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
| `threads` | query | List the caller's threads with all agents. Returns up to 50, newest last-message first. |
| `thread({ agentId })` | mutation | Upsert and open a thread. Returns `{ thread, agent, messages }` (last 50 messages). |
| `send({ agentId, body, context? })` | mutation | Persist a USER message and trigger agent dispatch. `context` is the optional context snapshot (see [Chat](/agents/chat.html)). Returns `{ threadId, messageId }`. |
| `appendAgentMessage({ threadId, body, sourceRunId? })` | mutation | Agent-only path. Requires the calling API key's `linkedAgentId` to match the thread's agent. Returns `{ messageId }`. |
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

## Cross-references

- [/reference/mcp.html](/reference/mcp.html) — the agent-facing subset.
- [/reference/events.html](/reference/events.html) — event kinds and
  payloads consumed by `event.*`, `agent.timeline`, and `chat.*`.
- [/automation/api-keys.html](/automation/api-keys.html) — scopes that
  gate the MCP equivalents of these procedures.
- [/agents/chat.html](/agents/chat.html) — chat surface documentation.
- [/agents/integrations.html](/agents/integrations.html) — adapter manifest structure.
