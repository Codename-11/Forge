# Webhooks

Forge POSTs signed envelopes when ActivityEvents fire. Delivery is durable and
retried; receivers verify HMAC and acknowledge with `2xx`. Subscriptions are
scoped to a workspace, and every delivery is recorded so admins can replay or
dead-letter from the UI.

## The model

A `Webhook` row on a workspace declares where Forge should POST and which
events you want.

```prisma
model Webhook {
  id          String      @id @default(cuid())
  workspaceId String
  url         String
  secret      String
  events      EventKind[]
  active      Boolean     @default(true)
  createdAt   DateTime    @default(now())

  @@unique([workspaceId, url])
}
```

There is one row per `(workspaceId, url)` pair — re-registering the same URL
updates the existing subscription rather than creating a duplicate. `events`
is a subset of [`EventKind`](/reference/events.html); an empty array means
"all kinds the workspace emits". `active = false` pauses delivery without
losing the row.

::: tip
The `secret` is generated server-side at registration. Treat it as a
credential — it is the only thing standing between your endpoint and a
spoofed payload.
:::

## Outbound envelope

Every delivery is a single `POST` with a JSON body and three headers:

```http
POST <url>
Content-Type: application/json
x-forge-timestamp: 1745683200
x-forge-signature: 9f3a1c2d4e5b6a7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e
x-webhook-signature: 6e7f8091a2b3c4d5e9f3a1c2d4e5b6a7c8d9e0f1a2b3c4d5e6f708192a3b4c5d

{
  "id": "cle9k4z2j0001qg9k7m4n8p2x",
  "kind": "ISSUE_CREATED",
  "subjectType": "issue",
  "subjectId": "cle9k4z2j0002qg9k4f7r2x1d",
  "payload": {
    "issue": {
      "id": "cle9k4z2j0002qg9k4f7r2x1d",
      "key": "AXI-42",
      "title": "Investigate flaky e2e",
      "priority": "HIGH",
      "statusId": "cle9k4z2j0003qg9k7n4p2x"
    }
  },
  "createdAt": "2026-04-26T18:00:00.000Z"
}
```

### Why two signatures

`x-forge-signature` is replay-protected: it covers the timestamp prefix, so an
attacker cannot capture an envelope and re-deliver it later (you should reject
timestamps older than 300 seconds). `x-webhook-signature` is body-only and
works with generic validators — Hermes' inbound adapter, GitHub-style
verifiers, and most off-the-shelf middleware accept this shape directly.

Both are HMAC-SHA256 over the same per-subscription `secret`. Verify whichever
is convenient for your stack — if you can verify both, do.

```
x-forge-signature   = hex(hmac_sha256(secret, `${ts}.${rawBody}`))
x-webhook-signature = hex(hmac_sha256(secret, rawBody))
```

::: warning
Verify against the **raw** request body. Re-serializing the parsed JSON will
re-order keys and your HMAC will not match. Most frameworks expose this as
`req.rawBody` or via a buffer middleware before JSON parsing.
:::

## Verifying in TypeScript

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const MAX_SKEW_SECONDS = 300;

export function verifyForgeWebhook(
  secret: string,
  rawBody: Buffer,
  headers: IncomingMessage["headers"],
): { ok: true } | { ok: false; reason: string } {
  const ts = Number(headers["x-forge-timestamp"]);
  const sigTs = String(headers["x-forge-signature"] ?? "");
  const sigBody = String(headers["x-webhook-signature"] ?? "");

  if (!Number.isFinite(ts)) return { ok: false, reason: "missing timestamp" };
  if (Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: "stale timestamp" };
  }

  const expectedTs = createHmac("sha256", secret)
    .update(`${ts}.${rawBody.toString("utf8")}`)
    .digest("hex");
  const expectedBody = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const tsOk =
    sigTs.length === expectedTs.length &&
    timingSafeEqual(Buffer.from(sigTs, "hex"), Buffer.from(expectedTs, "hex"));
  const bodyOk =
    sigBody.length === expectedBody.length &&
    timingSafeEqual(
      Buffer.from(sigBody, "hex"),
      Buffer.from(expectedBody, "hex"),
    );

  if (!tsOk && !bodyOk) return { ok: false, reason: "bad signature" };
  return { ok: true };
}
```

::: details Why timingSafeEqual?
String `===` short-circuits on the first mismatched byte. An attacker
measuring response latency can recover a valid HMAC byte-by-byte. Constant-time
comparison closes that side channel.
:::

## Delivery durability

Every fired event creates a `WebhookDelivery` row before the network call:

| Field            | Purpose                                                         |
|------------------|-----------------------------------------------------------------|
| `status`         | `PENDING` / `SUCCESS` / `FAILED` / `DEAD_LETTER`                |
| `attempt`        | Increments on each retry                                        |
| `responseStatus` | Last HTTP status we saw                                         |
| `responseBody`   | First N bytes of the response (truncated)                       |
| `nextAttemptAt`  | When the worker will pick it up next                            |

The BullMQ worker (`src/server/worker.ts`) drains the queue with exponential
backoff. Non-2xx responses, network errors, and timeouts all schedule a retry.
After retries are exhausted the row flips to `DEAD_LETTER` and stops moving on
its own.

::: info
The publish step on the mutation path is best-effort and never blocks the
write. Durability lives entirely in `WebhookDelivery` rows — if Redis is down
the row is still created and the worker picks it up when Redis recovers.
:::

## Dead-letter admin

`/w/<slug>/settings/admin` lists failed deliveries with an audit table —
timestamp, kind, target URL, last response, attempt count. Admins can:

- **Retry one** — re-queues a single row immediately.
- **Bulk retry** — re-queues all `DEAD_LETTER` rows in the current filter.
- **Inspect** — expand a row to see request/response bodies for debugging.

Bulk retries write an `AuditLog` entry naming the operator and the row count.

## The agent-dispatch shim

Webhook URLs that begin with `agent:dispatch` or `agent:dispatch:{agentId}`
are not real URLs. They are synthetic markers that the worker resolves to the
target agent's real `webhookUrl` at delivery time:

- `agent:dispatch:{agentId}` — deliver to that specific agent.
- `agent:dispatch` — workspace-shared shim; the worker reads the event
  payload's `agentId` and looks up the row at send time.

This is what powers push-dispatch. The synthetic row decouples the event from
agent-row mutations: changing an agent's `webhookUrl` does not require
rewriting old `WebhookDelivery` rows or pending jobs. See
[/agents/hermes.html](/agents/hermes.html) for the integration story end to
end.

::: tip
`agent.webhookHealth` (tRPC) reads the synthetic shims by URL prefix — that
is how the agent ops dashboard surfaces per-agent delivery health.
:::

## Receiver guidance

A correct receiver does five things:

1. **Read the raw body** before any JSON parsing middleware mutates it.
2. **Verify HMAC** using `timingSafeEqual`. Reject mismatches with `401`.
3. **Reject stale timestamps** older than 300 seconds when verifying
   `x-forge-signature`.
4. **Respond fast.** Acknowledge with `200` (or `202`) and process async.
   Forge's HTTP timeout is short; a slow handler will be retried even if it
   eventually succeeds.
5. **Idempotency by `id`.** Retries can deliver the same event twice — keep a
   short-lived seen-id cache (Redis SETEX, `WHERE NOT EXISTS`, etc.) and
   no-op duplicates.

::: warning
Returning `2xx` from a handler that has not yet committed its work is a
common bug — Forge will mark the delivery `SUCCESS` and you will silently
drop events on a crash. Either commit before responding, or write to a
durable inbox table and ack.
:::

## Cross-references

- [/reference/events.html](/reference/events.html) — every `EventKind` and
  the payload shapes.
- [/agents/hermes.html](/agents/hermes.html) — how Hermes consumes the
  `agent:dispatch` shim.
- [/concepts/activity-and-audit.html](/concepts/activity-and-audit.html) —
  the audit + event flow that emits these envelopes.
- [/automation/api-keys.html](/automation/api-keys.html) — keys for the SSE
  alternative to webhooks.
