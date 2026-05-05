# Email-to-issue ingest

Forge ships a thin **inbound webhook** that turns a signed email-shaped
payload into a new issue. It's the contract — your deployment owns
the upstream provider wiring (Postmark, SendGrid, Mailgun, etc.).
Off by default; admins enable it per-workspace and rotate a shared
HMAC secret in `Settings → Integrations`.

Today this is a stub: there's no UI inbox, no thread stitching, no
scrape-from-IMAP loop. The endpoint is the door — when you wire a
provider's inbound parse webhook to it, signed payloads flow in and
issues come out.

## The endpoint

```
POST /api/ingest/email
```

Headers:

| Header                       | Value                                     |
| ---------------------------- | ----------------------------------------- |
| `content-type`               | `application/json`                        |
| `x-forge-email-signature`    | hex-encoded HMAC-SHA256 of the raw body   |

Body (JSON):

```json
{
  "workspaceKey": "AXI",
  "from":         "alice@example.com",
  "subject":      "Bug: dashboard crashes on load",
  "body":         "Steps to reproduce…",
  "replyTo":      "alice@example.com",
  "headers":      { "Message-ID": "<…>" },
  "attachments": [
    {
      "filename": "console.log",
      "mimeType": "text/plain",
      "base64":   "PHN0YWNrIHRyYWNlPg=="
    }
  ]
}
```

Response (200):

```json
{
  "ok": true,
  "issueId": "cl…",
  "number": 142,
  "attachmentsLinked": 1,
  "attachmentsFailed": 0
}
```

## Auth flow

1. Resolve workspace by `workspaceKey`. Returns 404 on miss.
2. Reject if `Workspace.emailIngestEnabled = false` → 403.
3. Compute the HMAC of the raw body using the workspace's
   `emailIngestSecret` and timing-safe-compare against the
   `x-forge-email-signature` header. Mismatch → 401.
4. Try to resolve the `from` address against a workspace member's
   email. When matched, the resulting issue's `claimedById` is set
   to that user. Otherwise the issue lands unassigned (queueable).
5. Create the issue in the workspace's default status with
   `title = subject` and `body = "From: <from>\n\n<body>"`. Records
   `ISSUE_CREATED` in audit + activity, with the `source:
   "email-ingest"` tag in the event payload.
6. Stream attachments (if any) directly to MinIO using the workspace
   bucket. Allowlist mismatches and oversize files are skipped (logged,
   not failed). Each successful upload links a row through
   `Attachment` with `targetType = "issue"`.

## Generating the signature

Pseudocode:

```js
import { createHmac } from "node:crypto";

const body = JSON.stringify(payload);          // raw bytes you POST
const sig  = createHmac("sha256", secret)      // workspace's secret
  .update(body)
  .digest("hex");

await fetch("https://forge.example.com/api/ingest/email", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-forge-email-signature": sig,
  },
  body,
});
```

## A `curl` example

```bash
SECRET="feis_…"
BODY='{"workspaceKey":"AXI","from":"alice@example.com","subject":"Hi","body":"Hello"}'
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -sS https://forge.example.com/api/ingest/email \
  -H "content-type: application/json" \
  -H "x-forge-email-signature: $SIG" \
  -d "$BODY"
```

## Operating notes

- **Off by default**. Flipping `emailIngestEnabled` on without a
  generated secret is harmless — every signed call returns 401
  (no secret = empty expected hash).
- **Rotate freely**. The settings page exposes a "Rotate secret"
  button; rotating invalidates outstanding integrations until they
  pick up the new value. The secret is shown once after rotation.
- **No replay protection**. Unlike the plugin webhook contract,
  there's no timestamp + tolerance window — providers vary too much
  in what timestamps they emit. If you need stricter replay defense,
  put it in your provider's edge worker.

## What's not covered yet

- **Threading**: replies don't append to existing issues. Future
  iter will parse `In-Reply-To` / `References` and append a comment
  when a matching issue is found.
- **HTML body parsing**: the `body` field is treated as plain text /
  markdown verbatim. HTML-only senders need to convert before POST.
- **Provider integration UX**: there's no first-class Postmark or
  SendGrid setup wizard. You wire the provider's inbound parse
  webhook to `/api/ingest/email` yourself.

## Where to next

- [Webhooks](/automation/webhooks.html) — the outbound side of
  Forge's webhook system.
- [API Keys](/automation/api-keys.html) — for everything else
  agents and scripts use to talk to Forge.
