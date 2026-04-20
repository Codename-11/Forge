# Building a Forge plugin

A plugin is a unit of extension that can:
- React to events (`ActivityEvent` stream — webhook or SSE).
- Expose **skills** that agents can invoke.
- Read/write Forge data via MCP, gated by **scopes**.

## 1. Manifest

`plugins/<slug>/manifest.json`:

```json
{
  "schemaVersion": 1,
  "slug": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "What this plugin does.",
  "author": { "name": "you" },
  "scopes": ["READ_ISSUES", "WRITE_ISSUES"],
  "events": ["ISSUE_CREATED"],
  "skills": [
    {
      "name": "my-skill",
      "description": "Does something useful.",
      "runtime": "local",
      "inputSchema": { "type": "object", "properties": { "issueId": { "type": "string" } } },
      "outputSchema": { "type": "object" }
    }
  ],
  "rateLimit": { "perMinute": 120 }
}
```

Validated by `manifestSchema` in `src/server/services/plugin-manifest.ts`.

## 2. Choose a runtime

- **`runtime: "local"`** — Skill handler runs in-process. Put it at
  `plugins/<slug>/handler.ts`:

  ```ts
  export const skills = {
    "my-skill": async (input, ctx) => {
      // ctx: { workspaceId, invokerUserId }
      return { ok: true };
    },
  };
  ```

- **`runtime: "plugin"`** — Forge HTTP-POSTs the input to your plugin
  service:

  ```
  POST <webhookUrl>/skills/<skill-name>
  Authorization: Bearer <short-lived JWT>
  Content-Type: application/json

  <input>
  ```

  Verify the JWT using `PLUGIN_JWT_SECRET` (HS256, iss=`forge`,
  aud=`forge-plugins`). Return JSON.

## 3. Register

Admin registers via the Plugins page (`/settings/plugins`) — paste the
manifest JSON. Registration is `PENDING` until an admin approves.

Or programmatically via tRPC `plugin.register`.

## 4. Issue an API key

After approval, issue a scoped key:

```ts
trpc.plugin.issueApiKey.mutate({
  pluginId,
  name: "prod-triage",
  scopes: ["READ_ISSUES", "WRITE_ISSUES"],
  expiresInDays: 90,
});
```

Requested scopes must be a subset of the manifest scopes. Plaintext key
is returned **once**.

## 5. Use it

```ts
await fetch("https://forge.example/api/mcp/issues.create", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.FORGE_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ title: "auto-filed", priority: "HIGH" }),
});
```

## 6. Subscribe to events

Either opt in to outbound webhook delivery (manifest `events` list +
`webhookUrl`), or hold open an SSE connection:

```ts
const es = new EventSource("https://forge.example/api/plugins/events", {
  headers: { Authorization: `Bearer ${KEY}` },
});
es.onmessage = (m) => console.log(JSON.parse(m.data));
```

## Sandboxing notes

- Local plugins run in the Next.js Node process. Treat the handler code as
  trusted. For untrusted code, deploy as `runtime: "plugin"` behind a
  separate service (AWS Lambda, Vercel Function, container) so the
  blast radius is contained.
- Rate limits: `manifest.rateLimit.perMinute` is enforced per plugin
  across invocations. Per-key limits are enforced at the MCP edge.
