# MCP Tools

Forge exposes 46 tools across 11 namespaces. Two transports — JSON-RPC 2.0 at
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
| `get`        | Fetch by `id` or workspace key (e.g. `WRK-42`).                              |
| `create`     | `{ title, description?, projectId?, priority?, statusId?, labelIds? }` → full issue. |
| `queue`      | Set `queued: true`. Dispatcher only sees queued + unassigned issues.         |
| `transition` | Change status by `statusId`.                                                 |
| `claim`      | Set human `claimedById = caller`. Sets soft expiry `claimExpiresAt`.         |
| `release`    | Clear human claim.                                                           |
| `assign`     | Assign agent. Identify by `agentId` or `profileKey`.                         |
| `reassign`   | Atomic handoff — see below.                                                  |
| `assigned`   | List issues assigned to an agent.                                            |

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

### `comments`

| Tool     | Summary                                                |
|----------|--------------------------------------------------------|
| `create` | Post a comment on an issue. Other comment ops are tRPC-only. |

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
| `list`           | List attachments for a `(targetType, targetId)` pair.                |
| `getDownloadUrl` | Get a presigned GET URL for browser/agent download.                  |
| `delete`         | Delete attachment + remove blob.                                     |

### `pins`

| Tool   | Summary                                                       |
|--------|---------------------------------------------------------------|
| `list` | List the caller's pinned issues.                              |
| `set`  | Set the full pinned set (idempotent — pass the desired list). |

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

**`me`** rejects keys without `linkedAgentId` set. The intended pattern is
that agent runtimes carry a key linked to their own `Agent` row — the tool
becomes a zero-arg "who am I".

**`heartbeat`** defaults to `ONLINE` when `status` is omitted. Bumps
`lastHeartbeatAt` atomically and emits `AGENT_STATUS_CHANGED` only when the
status actually changes. Rejects archived or cross-tenant linked agents with
`403`.

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
