# Plugins

A plugin is a packaged unit of extension that reacts to events, exposes
skills, and reads/writes Forge data through scope-gated MCP. The contract is
a JSON manifest plus either an in-process handler module or an external HTTP
service — Forge does not care which, as long as the manifest validates and
the scopes line up.

## The manifest

```json
{
  "schemaVersion": 1,
  "slug": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "Reacts to issues and suggests labels.",
  "author": { "name": "Axiom Labs", "email": "ops@axiom-labs.dev" },
  "scopes": ["READ_ISSUES", "WRITE_ISSUES"],
  "events": ["ISSUE_CREATED"],
  "skills": [
    {
      "name": "my-skill",
      "description": "Suggest labels for a new issue.",
      "runtime": "local",
      "inputSchema": {
        "type": "object",
        "required": ["issueId"],
        "properties": { "issueId": { "type": "string" } }
      },
      "outputSchema": {
        "type": "object",
        "properties": { "labels": { "type": "array", "items": { "type": "string" } } }
      }
    }
  ],
  "rateLimit": { "perMinute": 120 }
}
```

The manifest is validated by `manifestSchema` in
`src/server/services/plugin-manifest.ts`. Required keys: `schemaVersion`,
`slug`, `name`, `version`, `scopes`. Everything else is optional but most
plugins set at least `events` (to receive webhooks) and `skills` (to be
callable).

::: info
`scopes` is the **ceiling** for any API key minted under this plugin. You
cannot issue a key with `WRITE_PROJECTS` against a plugin whose manifest
only lists `READ_ISSUES` — the call fails before the key is created.
:::

## Skill runtimes

A plugin's skills run in one of two places.

### `runtime: "local"` — in-process handler

Forge dispatches to a handler module at `plugins/<slug>/handler.ts`:

```ts
// plugins/my-plugin/handler.ts
import type { SkillContext } from "@/server/services/plugin-runtime";

export const skills = {
  "my-skill": async (
    input: { issueId: string },
    ctx: SkillContext,
  ): Promise<{ labels: string[] }> => {
    // ctx: { workspaceId, invokerUserId, prisma, logger }
    const issue = await ctx.prisma.issue.findFirstOrThrow({
      where: { id: input.issueId, workspaceId: ctx.workspaceId },
    });
    const labels = issue.title.toLowerCase().includes("bug")
      ? ["bug", "triage"]
      : ["triage"];
    return { labels };
  },
};
```

Local handlers run inside the Next.js Node process. They are fast — no HTTP
hop — and have direct Prisma access scoped to the workspace, but they share
the app's process and trust boundary. Treat them as first-party code.

### `runtime: "plugin"` — external HTTP service

Forge POSTs to the plugin's registered `webhookUrl` with the path
`/skills/<skill-name>` and a short-lived JWT:

```http
POST <webhookUrl>/skills/my-skill
Authorization: Bearer <hs256-jwt>
Content-Type: application/json

{ "input": { "issueId": "cle9k4z2j0002qg9k4f7r2x1d" }, "ctx": { "workspaceId": "..." } }
```

The JWT is signed with `PLUGIN_JWT_SECRET` and carries:

```json
{
  "iss": "forge",
  "aud": "forge-plugins",
  "sub": "<plugin-slug>",
  "scopes": ["READ_ISSUES", "WRITE_ISSUES"],
  "workspaceId": "...",
  "exp": 1745683800,
  "iat": 1745683200
}
```

The plugin verifies the JWT, performs the work, and responds with the
`outputSchema` shape. Use this runtime for untrusted code, code that needs a
language other than TypeScript, or anything that needs its own deployment
lifecycle.

## Lifecycle

```
register → PENDING → APPROVED → (SUSPENDED?) → REVOKED
```

1. **Register.** Paste the manifest JSON at `/w/<slug>/settings/plugins`. The
   plugin row is created with `status = PENDING`.
2. **Approve.** A workspace admin reviews scopes and clicks Approve. Status
   flips to `APPROVED`. Webhooks now fire and skills become invokable.
3. **Suspend.** Admins can suspend (status `SUSPENDED`) — webhooks stop, keys
   401 — without losing the row or its config. Un-suspend reverses it.
4. **Revoke.** Permanent stop. Status `REVOKED`. Keys are revoked, webhooks
   removed.

::: tip
Pending plugins receive no events and can mint no keys. Approval is a one-way
gate the workspace admin owns — there is no auto-approve.
:::

## Issuing API keys

After approval, mint a scoped key:

```ts
const result = await trpc.plugin.issueApiKey.mutate({
  pluginId: "cle9k4z2j0001qg9k7m4n8p2x",
  name: "production",
  scopes: ["READ_ISSUES", "WRITE_ISSUES"], // must be a subset of manifest.scopes
  projectIds: ["cle9k4z2j0010qg9k4f7r2x1d"], // optional narrowing
});

console.log(result.plaintext); // "forge_sk_..." — shown ONCE
console.log(result.prefix);    // "forge_sk_abc123" — kept for display
```

The plaintext key is shown **once** and never returned again — Forge stores
only its SHA-256 hash. The prefix is retained so the UI can show "forge_sk_…"
in the keys list. See [/automation/api-keys.html](/automation/api-keys.html)
for full key semantics.

## Subscribing to events

Two ways:

### Push (webhooks)

Declare event kinds in the manifest and register a `webhookUrl` on the
plugin. Forge will POST signed envelopes per
[/automation/webhooks.html](/automation/webhooks.html). Best for plugins that
need durable delivery and run their own service.

### Pull (SSE)

Open a server-sent-events stream with an API key:

```bash
curl -N https://forge.example/api/plugins/events \
  -H "Authorization: Bearer $FORGE_KEY" \
  -H "Accept: text/event-stream"
```

Every `recordChange()` flushes a `RealtimeEvent` to all subscribers whose
key has matching scopes for the workspace. Best for ephemeral observers
(dashboards, dev tools).

::: warning
SSE requires the `SUBSCRIBE_EVENTS` scope on the API key. Without it the
endpoint returns `403`. SSE is best-effort — durability still lives in
`WebhookDelivery`, so for guaranteed delivery use webhooks.
:::

## Sample plugins

Two plugins ship in-tree as references:

- **`plugins/issue-triage/`** — `runtime: "local"`, subscribes to
  `ISSUE_CREATED`, suggests priority and labels via a small heuristic. Good
  starting point for in-process automation.
- **`plugins/notification-bridge/`** — bridges Forge events to Slack and
  Discord channels. Demonstrates external-service pattern (it shells out to
  `runtime: "plugin"` HTTP for delivery) and per-channel routing rules.

## Sandboxing

`runtime: "local"` handlers share the Next.js process and have direct DB
access. There is no sandbox — they run with the same privileges as the rest
of the app. Use them only for code you control.

For untrusted code, anything that needs aggressive resource limits, or
anything you want to deploy independently, use `runtime: "plugin"`. The
HTTP boundary plus the JWT scoping gives you a clean trust boundary.

## Rate limits

`manifest.rateLimit.perMinute` is enforced across all invocations of the
plugin (sum of skill calls + MCP requests via plugin keys). The limiter is
keyed by plugin id, not per-key. Per-key MCP rate limits also exist as a
second layer — the stricter of the two wins.

When a limit is exceeded:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 17
Content-Type: application/json

{ "error": "rate_limited", "limit": 120, "windowSec": 60 }
```

## Cross-references

- [/automation/api-keys.html](/automation/api-keys.html) — minting and
  narrowing keys for plugin-issued credentials.
- [/reference/events.html](/reference/events.html) — `EventKind` values to
  put in `manifest.events`.
- [/reference/mcp.html](/reference/mcp.html) — the tools your plugin can
  call with its key.
- [/automation/webhooks.html](/automation/webhooks.html) — the wire format
  push subscriptions use.
