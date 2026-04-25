# Forge API

Two surfaces:

1. **tRPC** — in-app use (browser, server components). Type-safe RPC.
2. **MCP REST** — external agents (Claude Code, Hermes, OpenAI). Scope-gated
   API keys or short-lived JWTs.

## tRPC contract

The canonical contract is the `AppRouter` type exported from
`src/server/routers/_app.ts`. For non-TS clients, we publish an OpenAPI
mirror of the REST surface (below) — the tRPC surface itself should only
be consumed via the typed client.

### Routers

| Namespace         | Procedures                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `workspace`       | `list`, `current`, `create`, `listMembers`, `addMember`, `setMemberRole`, `removeMember` (admin)                           |
| `project`         | `list`, `byId`, `create`, `update`, `archive`                                                                              |
| `issue`           | `list`, `byId`, `create`, `update`, `assign`, `softDelete`, `bulkStatus`, `bulkSetLabels`, `bulkAssign`, `bulkAssignAgent` |
| `comment`         | `create`, `update`, `softDelete`                                                                                           |
| `analytics`       | `summary`, `statusDistribution`, `throughput`, `cycleTime`, `slaBreaches`, `dispatch.summary`, `dispatch.timeseries`       |
| `plugin`          | `list`, `register`, `approve`, `suspend`, `issueApiKey`, `revokeApiKey`                                                    |
| `status`          | `list`, `create`, `reorder`                                                                                                |
| `template`        | `list`, `byId`, `create`, `update`, `delete` — issue templates                                                             |
| `projectTemplate` | `list`, `create`, `update`, `delete` — project starter templates                                                           |
| `agent`           | `list`, `byId`, `create`, `update`, `archive`, `delete`, `heartbeat`                                                       |
| `dispatchRule`    | `list`, `create`, `update`, `reorder`, `toggle`, `delete` (admin)                                                          |
| `admin`           | `webhookDeliveries.list`, `webhookDeliveries.retry` (admin)                                                                |
| `user`            | `me`, `updateAppearance` — current user + per-user prefs (theme, density, textSize)                                        |

Self-service email invite is **disabled**. `workspace.invite` is a stub
that throws `PRECONDITION_FAILED`; use `workspace.addMember` (admin-gated).

All write procedures:

- Validate input with Zod.
- Run inside a Prisma `$transaction`.
- Call `recordChange()` which writes to `AuditLog` + `ActivityEvent` and
  publishes to Redis for SSE fan-out.

Product language is **Sprint**. The database model, tRPC router, route path,
and MCP tools still use `cycle` / `cycles.*` for compatibility.

`template.list` seeds generic issue templates on first use: dev task,
agent-ready task, home/personal task, finance follow-up, side quest, and
review item. These are generic intake helpers; Forge does not auto-promote
captured ideas into an active sprint, and no household/couple-specific workflow
is implemented.

### Rate limits

`withRateLimit(limit, windowSec)` middleware applies per-`(userId, procedure)`
fixed-window limits. Default is none — add explicitly on hot paths.

## MCP REST

Two transports, same tool surface (46 tools):

- **JSON-RPC 2.0** — `POST /api/mcp/rpc` with standard MCP envelopes
  (`tools/list`, `tools/call`). Preferred for agent clients.
- **REST alias** — `POST /api/mcp/:tool` with a plain JSON body.

Both accept `Authorization: Bearer <key>` (ApiKey) or a short-lived JWT.

### Tool catalog (by namespace)

| Namespace     | Tools                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issues`      | `list`, `get`, `create`, `queue`, `transition`, `claim`, `release`, `assign`, `reassign`, `assigned`                                                              |
| `comments`    | `create`                                                                                                                                                          |
| `projects`    | `list`                                                                                                                                                            |
| `cycles`      | `list`, `get`, `current`, `create`, `update`, `plan`, `rollover`, `addIssue`, `removeIssue` (product label: "Sprints"; data model + tool namespace stay `cycle*`) |
| `initiatives` | `list`, `get`, `create`, `update`, `linkProject`, `unlinkProject`                                                                                                 |
| `relations`   | `add`, `remove`, `listForIssue`                                                                                                                                   |
| `time`        | `start`, `stop`, `log`, `list`, `summary`, `running`                                                                                                              |
| `attachments` | `initUpload`, `finalize`, `list`, `getDownloadUrl`, `delete`                                                                                                      |
| `pins`        | `list`, `set`                                                                                                                                                     |
| `analytics`   | `summary`                                                                                                                                                         |
| `agents`      | `me`, `heartbeat`                                                                                                                                                 |

`agents.me` and `agents.heartbeat` infer the caller's Agent row from
`ApiKey.linkedAgentId`. Keys without a linked agent are rejected.
`heartbeat` accepts `{ status?: ONLINE | BUSY | OFFLINE }` (defaults to
ONLINE) and bumps `lastHeartbeatAt` atomically. Archived and
cross-tenant linked agents are rejected.

**Not currently on the MCP surface** (tRPC-only, admin/UI path):
agent CRUD (`agent.create`, `.update`, `.archive`, `.delete`),
dispatch rules (`dispatchRule.*`), member management
(`workspace.addMember` etc.), webhook DLQ retry
(`admin.webhookDeliveries.retry`), dispatch analytics
(`analytics.dispatch.*`). All of these are admin/workspace-owner
surfaces — agents don't need them. Candidates for MCP promotion
if use cases materialize.

`issues.assign` / `issues.assigned` identify agents by `agentId` or
`profileKey`. `issues.assigned` falls back to the calling key's
`linkedAgentId` when neither is supplied, so a key linked to Victor
returns Victor's queue automatically.

`issues.reassign` is the atomic handoff flow: given `{ issueId,
toProfileKey, rationale }` (rationale ≥10 chars), it posts a
`"Handoff → @{toProfileKey}: {rationale}"` comment, swaps
`assignedAgentId`, and emits `AGENT_ASSIGNED` with
`{ auto: false, from, to, reason: "handoff", rationale, commentId }`.
Rejects archived agents and same-agent "handoffs" — use
`comments.create` for plain notes.

### Scopes

Keys carry a coarse `PluginScope[]` ceiling — a subset of the owning
plugin manifest — plus optional narrowing arrays `projectIds` /
`labelIds` / `initiativeIds`. Non-empty means "this key can only see
these ids". A key with `projectIds: ["X"]` is invisible to every tool
called against an issue outside project X.

## Events (plugin SSE)

`GET /api/plugins/events`, `Authorization: Bearer <key>` with
`SUBSCRIBE_EVENTS` scope. Streams JSON `RealtimeEvent`s scoped to the
key's workspace.

`EventKind` values: `ISSUE_CREATED | ISSUE_UPDATED | ISSUE_DELETED |
ISSUE_STATUS_CHANGED | ISSUE_ASSIGNED | ISSUE_PRIORITY_CHANGED |
ISSUE_QUEUED | COMMENT_CREATED | COMMENT_UPDATED | PROJECT_CREATED |
PROJECT_UPDATED | SKILL_INVOKED | PLUGIN_ERROR | AGENT_CREATED |
AGENT_UPDATED | AGENT_DELETED | AGENT_ASSIGNED | AGENT_STATUS_CHANGED |
MEMBERSHIP_CREATED | MEMBERSHIP_ROLE_CHANGED | MEMBERSHIP_REMOVED`.

`AGENT_ASSIGNED.payload.dispatch` carries decision provenance:
`{ mode, candidates[], chosen, reason }`. Rule-fired dispatches set
`mode: "RULE"` and include `ruleId`. Rule targets that were ineligible
at decision time prefix the mode reason as
`"rule:{id}:target-ineligible,{mode}-slug pick"`.

## Webhooks (outbound)

For plugins with a `webhookUrl`, Forge POSTs event envelopes:

```
POST <webhookUrl>
x-forge-timestamp: <unix seconds>
x-forge-signature: <hex hmac-sha256 of `${ts}.${body}` with plugin secret>

{ "id": "...", "kind": "ISSUE_CREATED", "subjectType": "issue", "subjectId": "...", "payload": {...}, "createdAt": "..." }
```

Plugins should verify the signature before acting, and reject timestamps
older than 300 seconds.

## Errors

tRPC errors follow the standard `TRPCClientError` shape. REST errors are
JSON `{ error: string, issues?: object }` with HTTP status.

429 responses include `Retry-After` in seconds.

## Auth

- Browser: NextAuth session (DB-backed).
- Plugin / agent: scoped API key (`forge_sk_*`) passed as `Bearer`.
- Delegated plugin calls (Forge → plugin): short-lived HS256 JWT with
  `iss=forge`, `aud=forge-plugins`.
