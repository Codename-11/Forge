# Activity & Audit

Every mutation writes an `AuditLog` *and* an `ActivityEvent` in the same
transaction, then publishes for fan-out.

The two-row pattern is deliberate. Audit is for compliance and
forensics; activity is for product features (event streams, webhook
deliveries, the SSE-backed UI). They're separate tables with overlapping
data because they answer different questions.

## AuditLog: the immutable record

Every mutation records an `AuditLog` row.

```prisma
model AuditLog {
  id          String   @id @default(cuid())
  workspaceId String
  actor       Json     // { kind: "user" | "agent" | "system", id?, profileKey? }
  entity      String   // "issue", "project", "comment", ...
  entityId    String
  action      String   // "create", "update", "delete", "transition", ...
  before      Json?
  after       Json?
  ip          String?
  userAgent   String?
  createdAt   DateTime @default(now())
}
```

Audit rows are append-only. There is no update path; once written, they
are not edited. They include both the `before` and `after` shapes for
update actions, the IP and user-agent for human-driven mutations, and a
structured `actor` JSON that records who did the thing — human, agent,
or system.

::: info
Audit is intentionally over-broad. Anything that mutates a tenant-scoped
row writes one. The volume is high; that's expected. Storage cost is the
trade for reliable forensics.
:::

## ActivityEvent: the product-facing stream

The same mutation also writes an `ActivityEvent`.

```prisma
model ActivityEvent {
  id          String    @id @default(cuid())
  workspaceId String
  kind        EventKind
  actor       Json
  subjectType String
  subjectId   String
  payload     Json
  createdAt   DateTime  @default(now())
}
```

The differences from `AuditLog`:

- `kind` is a typed enum (`EventKind`) — `ISSUE_CREATED`,
  `AGENT_ASSIGNED`, `ISSUE_STALLED`, `AGENT_NOACK`, etc. Audit's
  `action` is a free string; ActivityEvent's kind is a closed set.
- `payload` is a denormalized snapshot of what consumers need —
  shaped for webhook envelopes and SSE messages, not for byte-perfect
  reproduction.
- ActivityEvent rows feed the UI (issue timelines, agent timelines,
  the activity drawer), the webhook delivery queue, and the SSE
  pub/sub channel. AuditLog feeds compliance and admin tooling.

The full `EventKind` enum lives in
[Reference → Events](/reference/events.html).

## The single entry point: recordChange

Both rows are written through one helper:

```ts
// src/server/audit.ts
await recordChange({
  kind: "ISSUE_CREATED",
  actor: { kind: "user", id: ctx.session.user.id },
  workspaceId,
  subjectType: "issue",
  subjectId: issue.id,
  before: null,
  after: serializeIssue(issue),
  payload: { issueKey: issue.key, title: issue.title },
});
```

Inside `recordChange`, three things happen in a single Prisma
transaction:

1. **Write `AuditLog`.** With `before`/`after`, IP, user-agent, full
   actor.
2. **Write `ActivityEvent`.** With the typed `kind`, denormalized
   `payload`, structured `actor`.
3. **Enqueue `WebhookDelivery` rows** for every active webhook
   subscribed to the kind. The rows live on a queue table; the worker
   in `src/server/worker.ts` drains them.

After the transaction commits, `recordChange` makes one more best-effort
call:

4. **Publish to Redis pub/sub.** A small JSON message lands on the
   workspace's SSE channel for live UI updates.

The publish is intentionally non-transactional. If Redis is down, the
mutation still succeeds, the audit and event rows are still written, and
the webhook queue still drains. Only the SSE fan-out is missed, and
clients reconcile on reconnect from the persistent ActivityEvent table.

::: warning
Never write `AuditLog` or `ActivityEvent` rows directly. Always go
through `recordChange()`. Direct writes break the dual-write invariant
and silently miss webhook fan-out.
:::

## Durability vs reach

Two delivery paths, two failure modes:

| Path | Durability | Reach |
| --- | --- | --- |
| `WebhookDelivery` rows | Durable; queued in Postgres, retries with backoff | Plugins and external integrations subscribed via webhook |
| Redis pub/sub | Best-effort; no retry | Live SSE clients (the in-app UI, dev tools) |

If you need a delivery to succeed eventually, subscribe via webhook. If
you need it to arrive within milliseconds for an open browser tab,
subscribe via SSE. Most of the time, the in-app UI uses both — SSE for
the fast path, the ActivityEvent table for the cold-load and the SSE
reconnect path.

## Worker, retries, dead-letter

The worker (`src/server/worker.ts`) does three things related to
delivery:

1. **Drains `WebhookDelivery` rows.** Posts the signed envelope to the
   subscriber's URL. On 2xx, marks delivered and bumps the agent
   heartbeat (if the subscriber is an agent webhook). On 4xx/5xx,
   schedules a retry.
2. **Backs off exponentially.** Retry intervals grow with the attempt
   count, capped at a maximum interval. The worker does not retry
   forever.
3. **Dead-letters after exhaustion.** When the retry budget is spent,
   the row moves to a dead-letter state. It stays in the table for
   inspection but is not re-attempted unless an admin re-queues it.

Webhook delivery success — specifically, a 2xx response from an agent's
`webhookUrl` — also triggers `recordAgentReachable(agentId)`, which
bumps `lastHeartbeatAt` and flips OFFLINE → ONLINE. That's the implicit
heartbeat described in [Agents → Overview](/agents/overview.html).

## The synthetic dispatch shim

There's one piece of indirection worth understanding: **synthetic
webhook URLs.** Two values are recognized:

- `agent:dispatch` — generic dispatch shim. Resolved by the worker at
  delivery time to the routed agent's actual `webhookUrl`.
- `agent:dispatch:{agentId}` — agent-specific shim. Resolved to that
  agent's `webhookUrl`.

The shim exists because ActivityEvents and webhook subscriptions are
written before the agent's webhook URL is necessarily stable. The fan-
out layer subscribes to `AGENT_ASSIGNED` with the synthetic URL; the
worker resolves it on every delivery, picking up the agent's current
`webhookUrl` and `webhookSecret` at fire time.

This decouples the ActivityEvent fan-out from agent-row mutations. You
can change an agent's `webhookUrl` and pending deliveries pick up the
new URL automatically; you don't have to walk the queue and rewrite it.

```ts
// At fire time, the worker resolves the synthetic URL:
if (delivery.url.startsWith("agent:dispatch")) {
  const agentId =
    delivery.url === "agent:dispatch"
      ? delivery.payload.agent.id
      : delivery.url.split(":")[2];
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  delivery.url = agent.webhookUrl;
  delivery.secret = agent.webhookSecret ?? workspace.syntheticSecret;
}
```

## What gets recorded

Every mutation that touches a tenant-scoped row goes through
`recordChange`. The list, abbreviated:

- Issue create / update / transition / claim / release / assign /
  reassign.
- Comment create / update / delete.
- Project, initiative, sprint create / update / archive / delete.
- Label, status create / update / delete.
- Agent create / update / archive / status-change.
- Watchdog firings (`ISSUE_STALLED`, `AGENT_NOACK`, `ISSUE_SLA_BREACH`).
- Dispatcher decisions (`AGENT_ASSIGNED` with full `dispatch` provenance).
- Workspace settings changes.

The full enumeration is in
[Reference → Events](/reference/events.html).

## Cross-references

- [Reference → Events](/reference/events.html) — the full `EventKind`
  list.
- [Automation → Webhooks](/automation/webhooks.html) — the outbound
  contract, delivery semantics, and signature scheme.
- [Agents → SLAs & Watchdogs](/agents/slas-and-watchdogs.html) — the
  watchdog-emitted events.
- [Concepts → Scopes & Tenancy](/concepts/scopes-and-tenancy.html) —
  how the actor is resolved on each mutation.
