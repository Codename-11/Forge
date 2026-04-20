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

Base: `POST /api/mcp/:tool`, JSON body, `Authorization: Bearer <key>`.

| Tool                 | Required scope       | Input (zod)                        |
|----------------------|----------------------|------------------------------------|
| `describe`           | (public)             | —                                  |
| `issues.list`        | READ_ISSUES          | `{ query?, limit?, includeDone? }` |
| `issues.get`         | READ_ISSUES          | `{ id }`                           |
| `issues.create`      | WRITE_ISSUES         | `{ title, description?, priority?, projectId? }` |
| `issues.transition`  | WRITE_ISSUES         | `{ id, statusId }`                 |
| `comments.create`    | WRITE_COMMENTS       | `{ issueId, body }`                |
| `projects.list`      | READ_PROJECTS        | `{ includeArchived? }`             |
| `analytics.summary`  | READ_ANALYTICS       | `{}`                               |

## Events (plugin SSE)

`GET /api/plugins/events`, `Authorization: Bearer <key>` with
`SUBSCRIBE_EVENTS` scope. Streams JSON `RealtimeEvent`s scoped to the
key's workspace.

`EventKind` values: `ISSUE_CREATED | ISSUE_UPDATED | ISSUE_DELETED |
ISSUE_STATUS_CHANGED | ISSUE_ASSIGNED | ISSUE_PRIORITY_CHANGED |
COMMENT_CREATED | COMMENT_UPDATED | PROJECT_CREATED | PROJECT_UPDATED |
SKILL_INVOKED | PLUGIN_ERROR`.

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
