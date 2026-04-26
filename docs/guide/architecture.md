# Architecture

This page describes the moving parts that make up a running Forge instance:
the stack, the runtime topology, the two API surfaces, and the way changes
propagate from a mutation back out to clients and webhooks.

## Stack

| Layer | Choice |
|---|---|
| Web framework | Next.js 15 (App Router, RSC + client components) |
| Language | TypeScript |
| ORM / DB | Prisma 6 / Postgres |
| In-app API | tRPC 11 with Zod validators |
| Auth | NextAuth v5 |
| Cache / pub-sub / queue broker | Redis |
| Background jobs | BullMQ (in-process via Next instrumentation hook) |
| Object storage | MinIO (S3-compatible) |
| Styling | Tailwind with warm-earthy design tokens |
| Tests | Vitest (unit + integration), Playwright (E2E) |

::: info
The choice of in-process workers (rather than a separate worker container) is
deliberate. It removes a deploy unit and simplifies developer setup. Production
deployments can still run `pnpm worker` as a standalone process if you want
to scale workers independently from the web app.
:::

## Runtime topology

A standard Forge deployment has four runtime services:

```
                 ┌──────────────────────┐
   browser ─────▶│  Next.js (web + API) │◀──── MCP clients (REST + JSON-RPC)
                 │  ─ tRPC routers      │
                 │  ─ MCP route handler │
                 │  ─ instrumentation:  │
                 │      BullMQ workers  │
                 └─────────┬────────────┘
                           │
              ┌────────────┼─────────────┐
              ▼            ▼             ▼
         ┌────────┐   ┌────────┐    ┌────────┐
         │Postgres│   │ Redis  │    │ MinIO  │
         │ data   │   │ pubsub │    │ blobs  │
         │ audit  │   │ queues │    │ quotas │
         └────────┘   └────────┘    └────────┘
                           ▲
                           │ HTTP webhooks
                           ▼
                      external agents
```

- **Next.js** serves the UI and both API surfaces (tRPC at `/api/trpc/*`,
  MCP at `/api/mcp/*`).
- **BullMQ workers** run inside the Next process by default, started by the
  instrumentation hook (`src/instrumentation.ts`). They drive the
  `webhook-delivery`, `agent-watchdog`, `sla-watchdog`, and `ai` queues.
- **Postgres** holds all durable state: workspaces, issues, sprints,
  attachments rows, audit log, activity events, webhook delivery rows.
- **Redis** is the pub/sub bus for SSE fan-out and the BullMQ broker.
- **MinIO** stores attachment binaries; metadata and quota live in Postgres.

::: tip
You can run all four locally with the compose file at
`docker/docker-compose.yml`. That's the same image set the integration tests
spin up.
:::

## The two API surfaces

Forge has two API surfaces, deliberately kept separate.

### In-app tRPC

`/api/trpc/*` is the API the Forge web client uses. Procedures live in
`src/server/routers/`, validated with Zod, gated by `workspaceProcedure` /
`adminProcedure` in `src/server/trpc.ts`. Authentication is the NextAuth
session. The router is the source of truth for in-app behavior.

### External MCP

`/api/mcp/*` is the API external agents and integrations use. It speaks two
dialects of the same surface:

- **REST** — `GET /api/mcp/issues`, `POST /api/mcp/issues`, etc. Convenient
  for curl and scripts.
- **JSON-RPC** — the MCP spec dialect: `tools/list`, `tools/call`. Convenient
  for MCP clients (Claude Desktop, Hermes, custom).

Authentication is an API key (`Authorization: Bearer <key>`), scoped by
`PluginScope[]` and optionally narrowed by `projectIds`, `labelIds`,
`initiativeIds`, and `linkedAgentId`. See [API keys](/automation/api-keys.html)
for the scope model.

The MCP surface is not a wrapper around tRPC — it's a sibling that shares the
same service layer. Both call into the same handlers in
`src/server/services/`. See [Reference → MCP Tools](/reference/mcp.html) for
the full tool list.

## Change propagation

Every mutation that touches a tenant-scoped row goes through `recordChange()`
in `src/server/audit.ts`. That single helper is the entry point for three
things at once:

1. **Audit log** — durable `AuditLog` row written in the same transaction as
   the mutation.
2. **Activity event** — `ActivityEvent` row, also in the same transaction.
   This is what powers the in-app activity feed.
3. **Fan-out** — best-effort publish to Redis pub/sub for SSE clients, and
   enqueue of `WebhookDelivery` rows for any subscriptions matching the event.

```ts
// Inside a mutation handler
await recordChange(tx, {
  workspaceId,
  actorId: ctx.user.id,
  entityType: "issue",
  entityId: issue.id,
  action: "issue.updated",
  before,
  after,
});
```

::: warning
Don't write `AuditLog` or `ActivityEvent` rows directly. Always go through
`recordChange()`. It's the only place that maintains the audit/event/fan-out
invariant atomically.
:::

## Durable webhook delivery vs best-effort SSE

Two fan-out paths exist for a reason.

**SSE fan-out** is best-effort. Mutations publish to a Redis channel; SSE
clients (the Forge UI, the standup view) listen. If Redis is unreachable for
a moment or a client is offline, the event is lost. That's fine — the next
time the client reconnects, it refetches state.

**Webhook delivery** is durable. For each external subscription matching an
event, `recordChange()` writes a `WebhookDelivery` row inside the mutation's
transaction. The webhook worker (`src/server/worker.ts`) picks those rows up,
POSTs to the configured URL, retries on failure with exponential backoff, and
moves rows to a dead-letter state after the retry budget is exhausted. The
admin DLQ inspector (Settings → Admin) lets you replay failed deliveries.

This split — best-effort for in-app live updates, durable for outbound
contracts — is a load-bearing design choice. Don't blur it.

## Where to look in the codebase

| What | Path |
|---|---|
| Schema | `prisma/schema.prisma` |
| tRPC routers | `src/server/routers/` |
| Service layer (shared by tRPC + MCP) | `src/server/services/` |
| MCP REST + JSON-RPC handler | `src/app/api/mcp/` |
| BullMQ workers | `src/server/worker.ts` |
| Audit + event entry point | `src/server/audit.ts` |
| Design tokens | `src/app/globals.css`, `tailwind.config.ts` |

## Where to next

- [Quickstart](/guide/quickstart.html) — get something running.
- [Concepts → Primitives](/concepts/primitives.html) — the data model in
  more depth.
- [Automation → Webhooks](/automation/webhooks.html) — how to subscribe to
  events.
