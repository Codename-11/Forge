# MCP Tools

Forge exposes a workspace-scoped tool catalog across multiple namespaces. Two transports — JSON-RPC 2.0 at
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

- `initialize` — returns protocol capabilities and `serverInfo`. Forge includes
  `version`, `gitSha`, and `buildTime` in `serverInfo` so clients and operators
  can tell which deployed Forge build an MCP connection is talking to.
- `tools/list` — returns the compact default tool catalog, with standard MCP
  cursor pagination for larger catalogs. Narrowable via `?profile=` / `?tools=`
  on the endpoint URL, and pruned to the calling key's scopes (see
  [Limiting the advertised tool surface](#limiting-the-advertised-tool-surface)).
- `tools/call` — invokes a tool by `{ name, arguments }`. **Not** affected by the
  list selectors — any tool the key is authorized for stays callable.

### REST aliases

Every tool also responds at `POST /api/mcp/<namespace>.<tool>` — for example
`POST /api/mcp/issues.create`. The body is the tool's input directly (no
JSON-RPC envelope), and the response is the tool's output directly.
`GET /api/mcp/describe` returns the REST catalog plus the same `serverInfo`
build identity for curl-based diagnostics.

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

## Limiting the advertised tool surface

Forge registers 200+ tools internally. Some providers cap the number of tools an LLM
request may advertise (xAI/Grok rejects requests over **200**), and a client
usually stacks several MCP servers under one provider, so advertising the whole
Forge surface can blow the cap. The default `tools/list` response is therefore
a compact runtime profile plus catalog helper tools, not the whole registry.
Larger lists use standard MCP `nextCursor` pagination. You can change the
advertised direct-tool set two ways, set as query params on the MCP endpoint URL:

- **`?profile=<name>`** — a curated namespace bundle:
  - `runtime` — default. Agent runtime essentials: issues, comments, chat,
    runs, action requests, and workspace lookup. This is the safest default for
    Hermes, Grok, and other capped providers.
  - `core` — everyday issue tracking (issues, comments, projects, statuses,
    labels, relations, attachments, agents, notes, …).
  - `planning` — `core` + sprints, initiatives, goals, plans, review gates.
  - `agents` — `core` + runs, crews, runtimes, action requests, chat.
  - `canvas` — the visual canvas tools (the largest single namespace).
  - `full` — the entire direct catalog. Use only for clients that can handle
    the count, or when the client handles MCP pagination and does not forward
    every listed tool into one model request.
- **`?tools=<ns1,ns2,…>`** — an explicit comma-separated namespace allowlist
  (e.g. `?tools=issues,comments,statuses`). Wins over `profile`.

Both compose with **scope pruning**: whenever a key is presented, `tools/list`
drops any tool the key couldn't call anyway (same check as `tools/call`). A
FULL-scope key sees everything within the selected profile; a narrowly-scoped
key sees less. `tools/call` is never restricted by these selectors — they only
shape what's *advertised*, so full capability stays reachable for any tool the
caller names and is authorized for.

```
# Hermes / capped providers: the plain URL now advertises the compact default
https://forge.example/api/mcp/rpc
# explicit full direct catalog, with MCP pagination
https://forge.example/api/mcp/rpc?profile=full
# or hand-pick namespaces
https://forge.example/api/mcp/rpc?tools=issues,comments,statuses,projects
```

::: tip
If a provider rejects a session with a "maximum tools" error even with the
default Forge MCP URL, another MCP server or the host runtime's native tools are
also contributing to the count. Keep Forge on the compact default and reduce
the other advertised surfaces.
:::

### Catalog helper tools

The compact default includes three normal MCP tools that preserve access to the
long tail without advertising every direct tool:

- `catalog.search` — search the full authorized Forge MCP catalog.
- `catalog.describe` — fetch full descriptors and input schemas by tool name.
- `catalog.call` — invoke any authorized Forge MCP tool by name. The target
  tool's scopes and runtime policies are still enforced.

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

Agent-linked keys are mode-gated for issue state. When the calling agent has an
active/waiting `AgentRun` on the issue in **RESEARCH**, **REVIEW**, or
**DISCUSS**, Forge rejects issue-state mutation tools such as `issues.update`,
`issues.transition`, `issues.assign`, label changes, issue-linked artifact
writes, and action-request acceptance. The agent can still comment, upsert
status, set the run waiting, and complete the run with its report/verdict.

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
| `create`         | Post a comment on an issue. Optional `confidence: "LOW" \| "MEDIUM" \| "HIGH"` annotates how much to scrutinize the claim (only rendered for agent-authored rows). Optional `actionRequest` bundles a recommendation card in the same call; pass `actionRequest.options[]` to make that card a multi-vote poll. |
| `update`         | Edit an issue comment body. Input `{ id, body }`; authors can edit their own comments, while workspace OWNER/ADMIN or ADMIN-scoped MCP keys can override. Preserves prior bodies in `revisions`, sets `editedAt`, and emits normal comment audit/activity. |
| `delete`         | Soft-delete/archive an issue comment. Input `{ id }`; same author/admin authorization as `update`. Sets `deletedAt`, keeps the row for audit/history, and removes it from agent-facing comment lists/context bundles. |
| `upsertStatus`   | Idempotent rolling STATUS comment for the calling agent's run.         |
| `list`           | Paginated history. `{ issueId, before?, limit? = 50 (max 200) }` — newest first, hides soft-deleted, includes `author` + `authoringAgent`. Scope: `READ_ISSUES`. |

**`confidence`** is persisted regardless of caller, but the UI only
renders the chip for agent-authored comments. Use it from agents to
flag "tentative" findings the operator should double-check vs
"verified" claims you actually executed:

```json
{
  "issueId": "iss_...",
  "body": "I think this is a CSP bug, but I haven't reproduced it locally.",
  "confidence": "LOW"
}
```

Comment edits via `comment.update` (tRPC; no MCP equivalent today)
push the old body onto `Comment.revisions` (`[{ body, editedAt }]`,
capped at 20 entries — oldest dropped first). Read history via
`comment.history` (tRPC).

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

### `github`

GitHub App-backed issue/PR context. These tools read from GitHub through the
workspace's active `ConnectionMapping(kind="repo")` and only mutate Forge
state. They do not comment on GitHub, close GitHub issues, edit PRs, or apply
GitHub labels.

| Tool | Summary |
|---|---|
| `parseUrl` | Parse a GitHub issue/PR URL into `{ owner, repo, repoFullName, type, number, url }`. Scope: `READ_ISSUES`. |
| `listLinked` | List GitHub resources linked to a Forge issue. Scope: `READ_ISSUES`. |
| `link` | Link a GitHub issue or PR URL to an existing Forge issue with `kind: SOURCE \| IMPLEMENTS \| REVIEWS \| RELATES_TO`. Scope: `WRITE_ISSUES`. |
| `importIssue` | Create or return the Forge issue sourced from a mapped GitHub issue number. Scope: `WRITE_ISSUES`. |
| `sync` | Refresh a linked GitHub resource snapshot and apply configured Forge status/title rules. Scope: `WRITE_ISSUES`. |
| `search` | Search issues/PRs within a mapped repository. Scope: `READ_ISSUES`. |

`importIssue` input accepts `{ mappingId?, repoFullName?, number, projectId?,
labelIds?, queue? }`; pass either `mappingId` or a repo full name that has an
active mapping. The returned shape includes `{ issueId, created, resource,
link }` so clients can navigate to an existing issue when the GitHub issue was
already imported.

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
| `register` | Create (or restore) a Runtime row. `{ name, kind, endpoint?, providersAvailable, info? }`. `ownerId` is set from the calling key's `userId`; AGENT-kind keys leave it null. |
| `heartbeat` | Bump `Runtime.heartbeatAt`. `{ runtimeId, info? }`. Optional `info` updates sanitized runtime version/environment metadata. |
| `list` | List workspace runtimes. `{ kind?, includeArchived? = false }` → mirror of `trpc.runtime.list` shape, includes `_count: { agents }` + `owner` summary. Secrets are redacted to `hasSecret`. |
| `configure` | Update adapter config. `{ runtimeId, config, merge? = true }`. Hermes accepts `localWorkspaceTools`, `toolCapabilities`, `workspaceRoot`, and `modeToolPolicyEnforced`; Codex app-server also accepts sandbox/approval config. Scope `ADMIN`. |
| `archive` | Deregister (archive) a runtime — `{ runtimeId }` sets `archivedAt`, so it drops out of `list` (unless `includeArchived`). The teardown counterpart of `register`; exposed as `forge runtimes archive <id>`. Scope `ADMIN`. |
| `reportInfo` | Agent-linked runtime metadata report. `{ runtimeId?, info }`; omitted `runtimeId` resolves to the calling agent's attached Runtime. Stores a sanitized whitelist such as `runtimeVersion`, `bridgeVersion`, `codexVersion`, `containerImage`, `hostname`, `os`, `arch`, and `workspaceRoot`. |

**`register`** is intentionally not deduping server-side — the CLI caches
its `runtimeId` in `~/.config/forge/daemon.json` and only re-registers if
heartbeat returns a missing-row error.

### `runs`

`recordUsage` requires `WRITE_ISSUES` and an agent-linked key whose
`linkedAgentId` matches the run's `agentId`. `list` requires `READ_ISSUES`.

| Tool | Summary |
|---|---|
| `open` | Open (or resume) a tracked run on an issue **you** are working — `{ issueId, summary?, mode? }`. Requires an agent-linked key; the run belongs to the key's `linkedAgentId`. Resumes an existing ACTIVE/WAITING run for the `(issue, agent)` pair instead of stacking a duplicate, and stamps a STARTED event so it shows in Mission Control. Lets an agent (e.g. a local CLI session) proactively self-report work rather than only getting a run as a dispatch side-effect. Issue-anchored; drive it afterward with `recordUsage` / `setWaiting` / `complete`. Scope `WRITE_ISSUES`. |
| `recordUsage` | Update token + cost columns on an `AgentRun`. `{ runId, tokensIn?, tokensOut?, tokensCached?, costUsd? }`. Idempotent — latest call replaces (cumulative as reported by the agent). |
| `complete` | Close an active/waiting run. `{ runId, summary, producedArtifactIds?, verificationResult?, followUps?, confidence?, verdict? }`. Requires an agent-linked key matching the run. Execute enforces issue artifact/checklist gates; Research requires `confidence`; Review requires `verdict`; Discuss is reply-only. Stores `completionMeta` with the Forge run contract version. |
| `setWaiting` / `resumeWork` | Mark a run blocked on the operator, or resume it. Requires an agent-linked key matching the run. |
| `list` | List `AgentRun` rows for "my recent history" introspection. `{ agentId?, issueId?, status?, limit? = 50, before? }` → newest-first by `startedAt`. Each row includes scalars (status, currentStep, startedAt, finishedAt, lastEventAt, tokensIn, tokensOut, tokensCached, costUsd) plus `issue { id, number, title, workspace: { key } }` and `agent { id, profileKey }`. |
| `kick` | Operator-driven nudge for a stalled run. `{ runId }`. Re-fires the dispatch webhook for the underlying issue without changing assignment or `controlState`. Only kicks an `ACTIVE` run that's been quiet 5+ minutes; younger runs return `{ ok: true, kicked: false }`. Records `AGENT_RUN_KICKED`. Scope: `WRITE_ISSUES`. |

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

### `actionRequests`

Precise, resolvable asks. An agent surfaces a blocker ("I need a
decision before continuing") or a recommendation ("I think we should
transition this to In Progress — Accept?"); the operator clicks
Accept / Decline. Created by `comments.create` (inline via the
`actionRequest` bundle) or standalone via `actionRequests.create`.

Scope: `WRITE_ISSUES` for mutations, `READ_ISSUES` for queries.

| Tool | Summary |
|---|---|
| `list` | `{ status?, assignedAgentId?, assignedUserId?, issueId?, limit? = 50 }`. Newest first. |
| `create` | Create a request. See "Polls" below for multi-vote variant. |
| `transition` | Flip status (RESOLVED / DISMISSED / SNOOZED / REJECTED). |
| `accept` | Run the bound dispatch (transition / setLabels / etc.) and resolve. Permission-gated to assignee / watcher / OWNER / ADMIN. |
| `decline` | Reject without dispatching. Same permission gate as Accept. |
| `vote` | Cast or update the caller's vote on a poll-style request. `{ id, optionKey }`. |
| `results` | Live vote tallies for a poll. `{ id }` → `{ options[], total, myVote, winningOptionKey, votingClosedAt }`. |
| `closeVoting` | Close voting on a poll. Only the requester can call this. `{ id }` → `{ id, winningOptionKey }`. |

**`create`** accepts the usual fields (`title, body, severity, kind,
payload, assignedUserId, assignedAgentId, issueId, dueAt, sourceType,
sourceId`) plus an optional `options[]` for poll-style requests:

```json
{
  "title": "I see three ways to fix this — pick one",
  "body": "We can retry, isolate, or rewrite. Each has tradeoffs.",
  "kind": "FREE_FORM",
  "issueId": "iss_...",
  "options": [
    { "key": "retry",    "label": "Add retry-on-failure", "description": "Cheapest, masks the underlying race." },
    { "key": "isolate",  "label": "Isolate the test in its own worker" },
    { "key": "rewrite",  "label": "Rewrite against a deterministic fixture" }
  ]
}
```

**Polls — voting flow.** When `options[]` is set, the renderer treats
the request as a multi-vote poll. Operators (and other agents with
session-bound keys) cast votes; the requester closes voting to pick
the winner. Each user gets one vote per request — re-calling `vote`
overwrites the previous pick until `closeVoting` is called.

```json
// actionRequests.vote
{ "id": "ar_...", "optionKey": "isolate" }
// → { "id": "ar_...", "optionKey": "isolate", "changed": false }

// actionRequests.results
{ "id": "ar_..." }
// → {
//   "options": [{ "optionKey": "retry", "label": "...", "count": 0, "firstVoteAt": null }, ...],
//   "total": 3,
//   "myVote": "isolate",
//   "votingClosedAt": null,
//   "winningOptionKey": null
// }

// actionRequests.closeVoting  (only the requester may call this)
{ "id": "ar_..." }
// → { "id": "ar_...", "winningOptionKey": "isolate" }
```

Ties are broken by earliest first-vote timestamp; on equal counts AND
no votes at all, the option that appears first in `options[]` wins.
After `closeVoting`, additional `vote` calls return `400`. Closing
voting does NOT resolve the request — the requester typically posts a
follow-up comment ("going with X") then calls `accept` or `resolve`.

The killer flow: Victor posts "I see three ways — which one?" with
`kind: FREE_FORM` + `options`; three watchers vote; Victor calls
`closeVoting`; the winning option drives his next comment.

### `orchestration` (goals / plans / crews)

The multi-agent orchestrator-judge loop. See
[concepts/orchestration.md](../concepts/orchestration.md) for the full
sequence diagram. A **Goal** owns `ExecutionPlan` attempts; a PLANNER
decomposes a goal into steps; an operator approves; WORKERs execute
step-by-step; a REVIEWER judges with retries + budget caps.

Scope: `READ_ISSUES` for reads, `WRITE_ISSUES` for the loop mutations,
`ADMIN` for crew CRUD.

#### Goals

| Tool | Summary |
|---|---|
| `goals.list` | `{ status?, includeArchived?, limit? }` → goal rows with plan counts. |
| `goals.get` | `{ id }` → goal + its plans + an `aggregate` block (`activePlanId`, `totalSteps`, `doneSteps`, `blockedSteps`). |
| `goals.create` | `{ title, description?, issueId?, crewId?, maxTotalCostUsd?, maxWallTimeMinutes? }` → `{ id }`. Emits `GOAL_CREATED`. |
| `goals.abandon` | `{ id, reason? }` → terminal `ABANDONED`; cancels any active plan attempt. |

```json
// goals.create
{ "title": "Ship the importer", "crewId": "crew_…", "maxTotalCostUsd": 5 }
// → { "id": "goal_…" }
```

#### Plans (loop)

| Tool | Summary |
|---|---|
| `plans.decompose` | `{ goalId, plannerAgentId?, contextSetId? }` → `{ planId, status: "PLANNING", plannerAgentId }`. Creates a DRAFT plan (`isActiveAttempt=true`, prior attempts flipped false), flips goal → PLANNING, dispatches the PLANNER (override > crew PLANNER > caller's agent). |
| `plans.addSteps` | `{ planId, steps: [{ title, body?, expectedOutput?, verification?, dependsOnStepIndexes?, assignedAgentId?, assignedRole? }] }` → `{ stepIds }`. Bulk-adds to a DRAFT plan; `dependsOnStepIndexes` are 0-based positions within the batch, resolved to real ids. |
| `plans.requestApproval` | `{ planId, assignedUserId? }` → `{ actionRequestId }`. Raises a FREE_FORM ActionRequest (`sourceType="execution-plan"`). Accepting it activates the plan. |
| `plans.activate` | `{ planId }` → `{ ok }`. DRAFT/APPROVED → RUNNING, goal → ACTIVE + `startedAt`, root steps cascade READY. Usually fired by accepting the approval ActionRequest. |
| `plans.judge` | `{ stepId, judgeAgentId? }` → `{ judgeAgentId }`. Dispatches a REVIEWER (override > crew REVIEWER) to evaluate a step in REVIEW. |
| `plans.recordVerdict` | `{ stepId, verdict: "PASS"\|"FAIL", feedback, score? }` → `{ outcome: "DONE"\|"RETRY"\|"BLOCKED", retryCount }`. PASS → DONE + cascade. FAIL → READY+retry (feedback stored) or BLOCKED + ReviewGate when retries exhausted. Emits `EXECUTION_STEP_JUDGED`. |

```json
// plans.addSteps  — index-based deps
{ "planId": "plan_…", "steps": [
  { "title": "Design schema", "expectedOutput": "schema.sql" },
  { "title": "Write migration", "dependsOnStepIndexes": [0] }
] }
// → { "stepIds": ["step_a", "step_b"] }

// plans.recordVerdict
{ "stepId": "step_a", "verdict": "PASS", "feedback": "meets the contract", "score": 0.95 }
// → { "outcome": "DONE", "retryCount": 0 }
```

`judgeVerdict` (stored on the step) shape:
`{ verdict, feedback, score?, judgedByAgentId?, judgedAt }`.

#### Plan substrate (existing)

| Tool | Summary |
|---|---|
| `executionPlans.list` / `.get` / `.create` / `.transition` | Plan CRUD + status transitions. |
| `executionPlans.transitionStep` | `{ stepId, status, sourceRunId? }`. Marking a step DONE cascades downstream readiness; marking REVIEW triggers auto-judge when the plan opts in. |

#### Crews

| Tool | Summary |
|---|---|
| `agentCrews.list` | Existing read. Crews + member/plan counts. |
| `agentCrews.create` | `{ name, description?, maxParallel?, members?: [{ agentId, role }] }` → `{ id }`. Roles: `PLANNER`/`WORKER`/`REVIEWER`/`OBSERVER`/`OPERATOR_PROXY`. |
| `agentCrews.update` | `{ id, name?, description?, maxParallel? }`. |
| `agentCrews.addMember` | `{ crewId, agentId, role }` → `{ id }`. |
| `agentCrews.removeMember` | `{ memberId }`. |
| `agentCrews.setMemberRole` | `{ memberId, role }` → `{ id }`. |
| `agentCrews.archive` | `{ id }`. Soft-archive. |

#### Review gates

| Tool | Summary |
|---|---|
| `reviewGates.list` / `.open` / `.resolve` | Approval checkpoints. The loop auto-opens gates on a step BLOCKED (retries exhausted) and on a plan budget breach. |

### `notification`

Per-user notification preferences. No row exists by default — every
alertable EventKind is enabled. Use this to let a user say "stop
paging me about ISSUE_STALLED in this workspace" without disabling
the whole notification feed.

Scope: `READ_USERS` for the query, `WRITE_USERS` for the mutation.

| Tool | Summary |
|---|---|
| `setPreference` | Upsert a preference row. `{ eventKind, enabled, delivery?, scope? = "workspace" }`. Pass `scope: "global"` to set the cross-workspace default. |

```json
// notification.setPreference  — disable stalled alerts for this workspace
{ "eventKind": "ISSUE_STALLED", "enabled": false, "scope": "workspace" }
// → { "id": "...", "userId": "...", "workspaceId": "...", "eventKind": "ISSUE_STALLED", "enabled": false, "delivery": "INBOX_ONLY" }
```

A workspace-scoped row wins over a global row for the same kind. Set
`delivery: "INBOX_AND_DIGEST"` to flag a kind for the future email /
Discord digest path (today, both delivery modes behave identically —
the field exists so we don't need a second migration when digest
ships).

### `agent` (composite context)

Scope: `READ_ISSUES`. The single composite tool that saves agents 4–5
round-trips on dispatch — bundles workspace + issue (or thread) + comments
+ attachments + relations + currentRun in one call.

| Tool | Summary |
|---|---|
| `context.bundle` | `{ issueId? }` xor `{ threadId? }`. For `issueId`: returns `{ workspace, issue (full row), description, comments (last 50), attachments, relations, currentRun, artifacts, completionContract, runProtocol, externalResources }`. `externalResources` contains linked GitHub issues/PRs with their link kind and latest local snapshot. `runProtocol` includes `{ contractVersion, runId, engagementMode, modeInstruction, protocolInstruction, mayMutateIssue }` so agents can ack/output-start/complete the correct run and know whether issue mutations are allowed. For `threadId`: returns `{ workspace, thread, messages (last 50), agent (peer summary), linkedIssues (any issues mentioned in messages' contextSnapshots) }`. Addressee gating mirrors `chat.getThread` for the threadId branch; issue-narrowing applies for the issueId branch. |

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
