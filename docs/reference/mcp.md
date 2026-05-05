# MCP Tools

Forge exposes 69 tools across 19 namespaces. Two transports — JSON-RPC 2.0 at
`POST /api/mcp/rpc` (preferred for agent clients) and REST aliases at
`POST /api/mcp/<tool>`. Both are gated by the same API-key auth and the same
scope/narrowing checks.

## Transport

### JSON-RPC 2.0

```http
POST /api/mcp/rpc
Authorization: Bearer <api-key>
Content-Type: application/json
```

The endpoint speaks the standard MCP envelope. Two methods are exposed:

- `tools/list` — returns the tool catalog, filtered to the calling key's
  scopes.
- `tools/call` — invokes a tool by `{ name, arguments }`.

### REST aliases

Every tool also responds at `POST /api/mcp/<namespace>.<tool>` — for example
`POST /api/mcp/issues.create`. The body is the tool's input directly (no
JSON-RPC envelope), and the response is the tool's output directly.

::: tip
Use JSON-RPC for agents (single endpoint, batchable, MCP-native). Use REST
for one-off scripts and curl debugging — it is friendlier on the command
line.
:::

## Client setup

Developer access in the app can create provider-oriented MCP keys for:

- **Hermes** — persistent Forge agent profiles that use MCP callbacks and may
  also receive push dispatch over webhook.
- **Claude** — Claude Desktop or Claude Code sessions using Forge over MCP.
- **Codex** — Codex CLI or IDE extension using streamable HTTP MCP config in
  `~/.codex/config.toml`.
- **Custom** — any JSON-RPC or REST client that can send a bearer token.

Claude and Codex are supported as single-session clients today. Persistent
Claude/Codex runners are intentionally tracked as roadmap work rather than
pretended in the current UI.

## Auth

`Authorization: Bearer <api-key>` is the primary path. Short-lived JWTs are
also accepted (used internally by the Next.js app for plugin-initiated
calls). See [/automation/api-keys.html](/automation/api-keys.html) for the
key contract.

## Tool catalog

### `issues`

| Tool         | Summary                                                                      |
|--------------|------------------------------------------------------------------------------|
| `list`       | Paged list with filters: `status`, `priority`, `projectId`, `assignedAgentId`, `labelIds[]`, `queued`. |
| `get`        | Fetch by `id`. Optional `include` hydrates description / comments / attachments / relations / currentRun / labels in one round-trip. |
| `create`     | `{ title, description?, projectId?, priority?, statusId?, labelIds? }` → full issue. |
| `queue`      | Set `queued: true`. Dispatcher only sees queued + unassigned issues.         |
| `transition` | Change status by `statusId`.                                                 |
| `claim`      | Set human `claimedById = caller`. Sets soft expiry `claimExpiresAt`.         |
| `release`    | Clear human claim.                                                           |
| `assign`     | Assign agent. Identify by `agentId` or `profileKey`.                         |
| `reassign`   | Atomic handoff — see below.                                                  |
| `assigned`   | List issues assigned to an agent.                                            |
| `watch`      | Add the caller as a watcher of `issueId`. Idempotent. Identity is inferred from the API key (`linkedAgentId` → agent-watch, otherwise user-watch). |
| `unwatch`    | Remove the caller's watch on `issueId`.                                      |
| `listWatchers` | List watchers of an issue with user/agent identity fields.                |
| `listWatching` | List issues the caller is currently watching.                             |

**`reassign`** is the canonical agent-to-agent handoff. Input:
`{ issueId, toProfileKey, rationale }` — `rationale` must be ≥ 10 characters.
The tool, in one transaction, posts a comment of the form
`Handoff → @{toProfileKey}: {rationale}`, swaps `assignedAgentId`, and emits
an `AGENT_ASSIGNED` event with `auto: false, from, to, reason: "handoff",
rationale, commentId`. It rejects archived agents and same-agent "handoffs"
with `400`.

**`assigned`** can be called three ways: `{ agentId }`, `{ profileKey }`, or
no argument at all — in which case it uses the calling key's
`linkedAgentId`. Keys without a linked agent that omit the argument get
`400`.

**`get` with `include`** — by default, `issues.get` returns the lean shape
(status + project + assignees) for backward compat. Pass an `include` object
to hydrate optional sections in one round-trip:

```json
{
  "id": "cle9k...",
  "include": {
    "description": true,
    "comments": true,            // or { "limit": 50 } — max 100, default 20
    "attachments": true,
    "relations": true,
    "currentRun": true,          // most recent non-terminal AgentRun
    "labels": true
  }
}
```

`currentRun` is the most recent AgentRun whose status is not `COMPLETED`
or `ABANDONED` (so `ACTIVE` and `STALLED` qualify).

### `comments`

| Tool             | Summary                                                                |
|------------------|------------------------------------------------------------------------|
| `create`         | Post a comment on an issue.                                            |
| `upsertStatus`   | Idempotent rolling STATUS comment for the calling agent's run.         |
| `list`           | Paginated history. `{ issueId, before?, limit? = 50 (max 200) }` — newest first, hides soft-deleted, includes `author` + `authoringAgent`. Scope: `READ_ISSUES`. |

### `projects`

| Tool      | Summary                                |
|-----------|----------------------------------------|
| `list`    | List workspace projects.               |
| `create`  | Create a project.                      |
| `update`  | Update name/description/initiativeId.  |
| `archive` | Archive (soft-delete).                 |

### `cycles`

> The product label is **"Sprints"**, but the namespace, route, and data
> model stay `cycle*` — only display strings were renamed.

| Tool          | Summary                                                |
|---------------|--------------------------------------------------------|
| `list`        | List cycles for the workspace.                         |
| `get`         | Fetch by id.                                           |
| `current`     | Return the active cycle (or `null`).                   |
| `create`      | Create a cycle.                                        |
| `update`      | Update name/dates.                                     |
| `plan`        | Bulk add/remove issues for upcoming cycle.             |
| `rollover`    | Move incomplete issues from current to next cycle.     |
| `addIssue`    | Add a single issue to a cycle.                         |
| `removeIssue` | Remove a single issue from a cycle.                    |

### `initiatives`

| Tool            | Summary                                          |
|-----------------|--------------------------------------------------|
| `list`          | List initiatives.                                |
| `get`           | Fetch by id.                                     |
| `create`        | Create initiative.                               |
| `update`        | Update name/description.                         |
| `linkProject`   | Attach a project to this initiative.             |
| `unlinkProject` | Detach a project (sets `initiativeId = null`).   |

### `relations`

| Tool           | Summary                                                          |
|----------------|------------------------------------------------------------------|
| `add`          | `{ fromIssueId, toIssueId, kind }` — directed link.              |
| `remove`       | Remove a relation by id.                                         |
| `listForIssue` | List both inbound and outbound relations for an issue.           |

`kind` is one of `BLOCKS`, `BLOCKED_BY`, `DUPLICATES`, `RELATES_TO`.

### `time`

> Gated on `Workspace.timeTrackingEnabled`. All tools `403` when disabled.

| Tool      | Summary                                                  |
|-----------|----------------------------------------------------------|
| `start`   | Start a running timer on an issue.                       |
| `stop`    | Stop the caller's running timer.                         |
| `log`     | Manually log a `{ issueId, durationMin }` entry.         |
| `list`    | List entries (filter by user/issue/date range).          |
| `summary` | Aggregated totals by user/issue/day.                     |
| `running` | Return the caller's running timer (or `null`).           |

### `attachments`

| Tool             | Summary                                                              |
|------------------|----------------------------------------------------------------------|
| `initUpload`     | Get a presigned MinIO/S3 PUT URL. Returns `{ uploadUrl, key }`.      |
| `finalize`       | Register the uploaded blob as an Attachment row.                     |
| `attachLink`     | Record an external URL (LINK kind). No bytes uploaded.               |
| `list`           | List attachments for a `(targetType, targetId)` pair.                |
| `getDownloadUrl` | Get a presigned GET URL for browser/agent download.                  |
| `getInline`      | Server-side bytes fetch — returns `{ id, mimeType, sizeBytes, filename, base64 }`. Default cap 1 MB; allowlist is image/*+pdf+text. |
| `delete`         | Delete attachment + remove blob.                                     |

**`attachLink`** input: `{ targetType, targetId, externalUrl, linkTitle? }`.
`targetType` is one of `"issue" | "initiative" | "cycle" | "comment"`.
`externalUrl` must be `http(s)://`. When `linkTitle` is omitted, Forge
attempts a server-side scrape of the page's `<title>` (5 s timeout,
follows redirects, reads up to 64 KB). On scrape failure the row's
display falls back to URL hostname. Output is the new `Attachment` row
(`kind = LINK`, `mimeType = "text/url"`, `size = 0`).

**`getInline`** is for image-aware models that can't follow a presigned URL.
Same scope checks as `getDownloadUrl` (`READ_ISSUES` plus subject-narrowing
on the attached entity), then it streams the object out of MinIO and returns
base64 bytes inline. Mime types outside `{image/png, image/jpeg, image/gif,
image/webp, application/pdf, text/plain, text/markdown}` are rejected with a
suggestion to fall back to `getDownloadUrl`. `maxBytes` defaults to
`1_000_000` and is hard-capped at 25 MB to keep MCP responses bounded.

### `pins`

| Tool   | Summary                                                       |
|--------|---------------------------------------------------------------|
| `list` | List the caller's pinned issues.                              |
| `set`  | Set the full pinned set (idempotent — pass the desired list). |

`pins.list` and `pins.set` preserve their issue-only signatures for
backward compat with existing Hermes/agent runtimes. The polymorphic
pin surface (`PROJECT`, `INITIATIVE`, `SAVED_VIEW`, `CYCLE`, `AGENT`)
is tRPC-only via `pin.listAll` / `pin.add` / `pin.remove` /
`pin.toggleEntity` / `pin.reorder` — see
[/reference/trpc.html](/reference/trpc.html).

### `notes`

Per-(workspace, user) markdown scratchpad. Each tool operates **only**
on the calling actor's own notes — agents leave notes for *themselves*,
not for the operator. To leave a note for someone else, use
`comments.create` on the relevant issue (their inbox picks up the
@-mention via the existing fan-out).

| Tool            | Scope          | Summary                                                                |
|-----------------|----------------|------------------------------------------------------------------------|
| `notes.create`  | `WRITE_ISSUES` | Create a personal note. Inputs: `{ title?, body, pinned?, kind?, journalDate? }`. |
| `notes.list`    | `READ_ISSUES`  | List the caller's own notes (NOTE-kind by default). Inputs: `{ archived?, kind?, limit? }`. |
| `notes.update`  | `WRITE_ISSUES` | Patch one of the caller's notes. Inputs: `{ id, title?, body?, pinned? }`. |
| `notes.archive` | `WRITE_ISSUES` | Soft-archive one of the caller's notes. Inputs: `{ id }`.               |
| `notes.todayJournal` | `WRITE_ISSUES` | Get-or-create today's JOURNAL entry for the caller (timezone-aware). Idempotent. |
| `notes.listJournal` | `READ_ISSUES` | List recent journal entries. Inputs: `{ from?, to?, limit? = 30 }`.    |

Returns the resulting `Note` row(s). Cross-actor mutation is blocked
at the resolver — passing an `id` owned by another user yields a
"Note not found" error rather than leaking that the row exists.

There is no `notes.unarchive` MCP tool by design — agents shouldn't be
resurrecting archived notes silently. The human-only `note.unarchive`
tRPC proc covers that case.

### `analytics`

| Tool      | Summary                                                                |
|-----------|------------------------------------------------------------------------|
| `summary` | Workspace summary: counts by status, throughput, breaches. Coarse only. |

> Dispatch analytics (`analytics.dispatch.*`) are tRPC-only — see
> [/reference/trpc.html](/reference/trpc.html).

### `standup`

| Tool    | Summary                                                              |
|---------|----------------------------------------------------------------------|
| `draft` | Compose a "closed / opened / continuing / blocked" markdown draft from the caller's last 24h (configurable up to 168h) of activity. |

`standup.draft` accepts `{ sinceHours?: number }` (default 24, max 168)
and returns `{ markdown, sinceHours, workspaceKey, counts, groups }`.
The `groups` payload contains the underlying issue rows (id / number /
key / title) so callers can render their own UI; the `markdown` field
is mrkdwn-flavored for direct paste into Slack / Discord.

The actor is resolved from the API key's linked user (or, for
plugin-only keys without a linked user, the first workspace member —
matching `issues.create`'s fallback). Scopes: `READ_ISSUES`,
`READ_ANALYTICS`.

### `agents`

| Tool        | Summary                                                              |
|-------------|----------------------------------------------------------------------|
| `me`        | Returns the calling agent's row. Inferred from `ApiKey.linkedAgentId`. |
| `heartbeat` | Update presence: `{ status?: ONLINE | BUSY | OFFLINE }`.             |
| `list`      | Workspace agents. `{ includeArchived? = false, runtimeId? }` → `{ id, profileKey, name, status, runtimeMode, provider, capabilities, archivedAt, runtime: { id, name, kind } }[]`. Scope: `READ_USERS`. |

**`me`** rejects keys without `linkedAgentId` set. The intended pattern is
that agent runtimes carry a key linked to their own `Agent` row — the tool
becomes a zero-arg "who am I".

**`heartbeat`** defaults to `ONLINE` when `status` is omitted. Bumps
`lastHeartbeatAt` atomically and emits `AGENT_STATUS_CHANGED` only when the
status actually changes. Rejects archived or cross-tenant linked agents with
`403`.

`agents.me` includes `provider` and `runtimeMode` so clients can tell whether
they were registered as `HERMES`, `CLAUDE`, `CODEX`, or `CUSTOM`, and whether
Forge expects a persistent or single-session runtime.

### `chat`

> All four tools require an API key with `linkedAgentId` set. The key's linked
> agent must be the agent of the addressed thread — agents cannot post to each
> other's threads.

Scope required: `WRITE_COMMENTS`.

| Tool | Summary |
|---|---|
| `appendMessage` | Single-shot agent reply. Persists a `ChatMessage` (role: AGENT). |
| `startDraft` | Begin a streaming reply. Returns `{ draftId }`. Publishes a `started` event on the `chat-thread-stream` channel. Nothing persisted yet. |
| `appendDraftChunk` | Publish one token delta. Ephemeral SSE only; no DB write. |
| `finalizeDraft` | Persist the complete reply, swap the client draft bubble, publish `finalized`. |
| `getThread` | Read `{ thread, messages[] }` for a thread the calling agent is the addressee of. `{ threadId, before?, limit? = 50 (max 200) }`. Each message includes `id, role, body, contextSnapshot, sourceRunId, createdAt, finalizedDraftId`. |

**Single-shot:**

```json
// chat.appendMessage
{
  "threadId": "cle9k...",
  "body": "Here's the summary: ...",
  "sourceRunId": "run_01H..."   // optional — links to an AgentRun
}
// → { "messageId": "...", "threadId": "..." }
```

**Streaming (three-step):**

```json
// 1. chat.startDraft
{ "threadId": "cle9k..." }
// → { "draftId": "abc123", "threadId": "cle9k..." }

// 2. chat.appendDraftChunk  (repeat N times)
{ "threadId": "cle9k...", "draftId": "abc123", "delta": "Here's ", "seq": 0 }
// → { "ok": true }

// 3. chat.finalizeDraft
{ "threadId": "cle9k...", "draftId": "abc123", "body": "Here's the full reply..." }
// → { "messageId": "...", "threadId": "...", "draftId": "abc123" }
```

> **Either/or contract:** pick streaming or single-shot for a reply, never both.
> Calling `appendMessage` after `startDraft` (without finalizing) leaves an
> orphaned draft bubble on the client. Always call `finalizeDraft` to close a
> streaming reply.

`seq` on `appendDraftChunk` is advisory — the client tolerates gaps and
out-of-order delivery. Batch at a sane cadence (~60–200 ms per chunk).

### `runtimes`

Scope required: `ADMIN`. Powers the `forge` CLI's local daemon registration
and heartbeat loop. See [/agents/runtimes.html](/agents/runtimes.html) for
the broader Runtime primitive.

| Tool | Summary |
|---|---|
| `register` | Create (or restore) a Runtime row. `{ name, kind, endpoint?, providersAvailable }`. `ownerId` is set from the calling key's `userId`; AGENT-kind keys leave it null. |
| `heartbeat` | Bump `Runtime.heartbeatAt`. `{ runtimeId }`. |
| `list` | List workspace runtimes. `{ kind?, includeArchived? = false }` → mirror of `trpc.runtime.list` shape, includes `_count: { agents }` + `owner` summary. |

**`register`** is intentionally not deduping server-side — the CLI caches
its `runtimeId` in `~/.config/forge/daemon.json` and only re-registers if
heartbeat returns a missing-row error.

### `runs`

`recordUsage` requires `WRITE_ISSUES` and an agent-linked key whose
`linkedAgentId` matches the run's `agentId`. `list` requires `READ_ISSUES`.

| Tool | Summary |
|---|---|
| `recordUsage` | Update token + cost columns on an `AgentRun`. `{ runId, tokensIn?, tokensOut?, tokensCached?, costUsd? }`. Idempotent — latest call replaces (cumulative as reported by the agent). |
| `list` | List `AgentRun` rows for "my recent history" introspection. `{ agentId?, issueId?, status?, limit? = 50, before? }` → newest-first by `startedAt`. Each row includes scalars (status, currentStep, startedAt, finishedAt, lastEventAt, tokensIn, tokensOut, tokensCached, costUsd) plus `issue { id, number, title, workspace: { key } }` and `agent { id, profileKey }`. |

`costUsd` is taken verbatim from the agent for v1; a server-side
rate table per model is a future enhancement.

### `events`

Scope: `READ_ISSUES`. Reads `ActivityEvent` rows for the calling
workspace.

| Tool | Summary |
|---|---|
| `recent` | `{ subjectType?, subjectId?, kinds?, limit? = 50 (max 200), before? }` → newest-first by `createdAt`. Includes `actor { id, name, image }`. When `subjectType="issue"` + `subjectId` are set, the calling key's project/label narrowing is enforced on that issue. |

### `workspace`

Scope: `READ_ISSUES`.

| Tool | Summary |
|---|---|
| `get` | Returns dispatch-time settings: `{ id, slug, key, name, cycleLengthDays, cycleCooldownDays, timeTrackingEnabled, attachmentQuotaMb, requiredAckSeconds, autoDispatch, autoDispatchMode }`. No member list. |

### `statuses`

Scope: `READ_ISSUES`.

| Tool | Summary |
|---|---|
| `list` | `{ category? }`. Returns `{ id, name, category, color, position, isDefault }[]` ordered by `position`. Optional `category` filter (`BACKLOG | TODO | IN_PROGRESS | IN_REVIEW | DONE | CANCELED`). Used by agents to discover the right `statusId` for an `issues.transition` call without inventing ids — e.g., the local `forge` daemon calls `statuses.list({ category: "IN_PROGRESS" })` on `AGENT_ASSIGNED` to flip the issue into work-in-progress before spawning Claude. |

### `agent` (composite context)

Scope: `READ_ISSUES`. The single composite tool that saves agents 4–5
round-trips on dispatch — bundles workspace + issue (or thread) + comments
+ attachments + relations + currentRun in one call.

| Tool | Summary |
|---|---|
| `context.bundle` | `{ issueId? }` xor `{ threadId? }`. For `issueId`: returns `{ workspace, issue (full row), description, comments (last 50), attachments, relations, currentRun }`. For `threadId`: returns `{ workspace, thread, messages (last 50), agent (peer summary), linkedIssues (any issues mentioned in messages' contextSnapshots) }`. Addressee gating mirrors `chat.getThread` for the threadId branch; issue-narrowing applies for the issueId branch. |

## Not on MCP

These surfaces are admin/UI only and not exposed to agents:

- **Agent CRUD** — `agent.create`, `agent.update`, `agent.archive`,
  `agent.delete`. Agents do not provision themselves.
- **Agent ops dashboard data** — `agent.pipeline`, `agent.timeline`,
  `agent.uptime`, `agent.webhookHealth`. UI-only; meant for human operators.
- **Dispatch rules** — `dispatchRule.*`. Rule authoring is admin-gated.
- **Member management** — `workspace.addMember`, `setMemberRole`,
  `removeMember`. Self-service email invite is disabled entirely.
- **Webhook DLQ retry** — `admin.webhookDeliveries.retry`. Replaying
  failed deliveries is a destructive admin operation.
- **Dispatch analytics** — `analytics.dispatch.summary`,
  `analytics.dispatch.timeseries`. Aggregate views over many agents'
  activity, intentionally not part of an agent's self-service surface.

If you have a use case that wants one of these on MCP, open an issue — the
gate is intentional but not absolute.

## Errors

JSON shape on every error response:

```json
{ "error": "string-code", "issues": { "field": "validation message" } }
```

`issues` is present only on Zod validation failures; otherwise just `error`.

| Status | Meaning                                                       |
|--------|---------------------------------------------------------------|
| 400    | Invalid input (Zod). `issues` map populated.                  |
| 401    | Auth failed (invalid/revoked/expired key, missing JWT).       |
| 403    | Scope or narrowing rejected.                                  |
| 404    | Subject does not exist or is not visible to this key.         |
| 409    | Conflict (e.g., reassigning to the same agent).               |
| 422    | Workspace precondition failed (e.g. time tracking disabled).  |
| 429    | Rate limited. Includes `Retry-After` header in seconds.       |
| 5xx    | Server error.                                                 |

tRPC errors over the in-app client follow `TRPCClientError` shape — code,
message, data with `httpStatus` and `path`. The MCP transports translate
these to the JSON shape above.

## Two transport examples

Side by side: the same `issues.create` call on each transport.

::: code-group

```bash [JSON-RPC]
curl -X POST https://forge.example/api/mcp/rpc \
  -H "Authorization: Bearer $FORGE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "issues.create",
      "arguments": {
        "title": "Investigate flaky e2e",
        "priority": "HIGH",
        "projectId": "cle9k4z2j0010qg9k4f7r2x1d"
      }
    }
  }'
```

```bash [REST]
curl -X POST https://forge.example/api/mcp/issues.create \
  -H "Authorization: Bearer $FORGE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Investigate flaky e2e",
    "priority": "HIGH",
    "projectId": "cle9k4z2j0010qg9k4f7r2x1d"
  }'
```

:::

JSON-RPC wraps the result in `{ "jsonrpc": "2.0", "id": 1, "result": { ... } }`;
REST returns the result object directly.

## Cross-references

- [/automation/api-keys.html](/automation/api-keys.html) — auth, scopes,
  narrowing.
- [/reference/events.html](/reference/events.html) — events emitted by
  these tools.
- [/reference/trpc.html](/reference/trpc.html) — surfaces not on MCP.
