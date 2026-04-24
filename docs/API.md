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

| Namespace     | Procedures                                                              |
|---------------|-------------------------------------------------------------------------|
| `workspace`   | `list`, `current`, `create`, `members`, `invite`                        |
| `project`     | `list`, `byId`, `create`, `update`, `archive`                           |
| `issue`       | `list`, `byId`, `create`, `update`, `assign`, `softDelete`, `bulkStatus`|
| `comment`     | `create`, `update`, `softDelete`                                        |
| `analytics`   | `summary`, `statusDistribution`, `throughput`, `cycleTime`, `slaBreaches`|
| `plugin`      | `list`, `register`, `approve`, `suspend`, `issueApiKey`, `revokeApiKey` |
| `status`      | `list`, `create`, `reorder`                                             |

All write procedures:
- Validate input with Zod.
- Run inside a Prisma `$transaction`.
- Call `recordChange()` which writes to `AuditLog` + `ActivityEvent` and
  publishes to Redis for SSE fan-out.

### Rate limits

`withRateLimit(limit, windowSec)` middleware applies per-`(userId, procedure)`
fixed-window limits. Default is none — add explicitly on hot paths.

## MCP REST

Two transports, same tool surface (44 tools):

- **JSON-RPC 2.0** — `POST /api/mcp/rpc` with standard MCP envelopes
  (`tools/list`, `tools/call`). Preferred for agent clients.
- **REST alias** — `POST /api/mcp/:tool` with a plain JSON body.

Both accept `Authorization: Bearer <key>` (ApiKey) or a short-lived JWT.

### Tool catalog (by namespace)

| Namespace       | Tools                                                       |
|-----------------|-------------------------------------------------------------|
| `issues`        | `list`, `get`, `create`, `update`, `transition`, `claim`, `assign`, `reassign`, `assigned` |
| `comments`      | `create`                                                    |
| `projects`      | `list`, `get`, `create`                                     |
| `cycles`        | `list`, `get`, `current`, `create`, `plan`, `addIssue`, `removeIssue` |
| `initiatives`   | `list`, `get`                                               |
| `relations`     | `add`, `remove`                                             |
| `time`          | `start`, `stop`, `log`                                      |
| `attachments`   | `initUpload`, `finalize`, `list`                            |
| `pins`          | `list`, `toggle`                                            |
| `analytics`     | `summary`, `statusDistribution`, `throughput`, `slaBreaches` |

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
AGENT_UPDATED | AGENT_DELETED | AGENT_ASSIGNED`.

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
