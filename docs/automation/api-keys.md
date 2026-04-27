# API Keys

API keys carry coarse scope plus optional narrowing — and optionally a
`linkedAgentId` for MCP tools that need agent context. They are the primary
credential for everything outside the browser session: scripts, plugins,
external services, and agent runtimes.

## Two key types

Forge issues two kinds of keys, both with the same wire format and
verification path:

- **Personal keys** — minted by a logged-in user from
  `/w/<slug>/settings/api-keys`. Owned by that user, scoped to that user's
  workspace membership. Use for one-off scripts, local dev, terminal access.
- **Plugin keys** — minted under an approved plugin row via
  `plugin.issueApiKey`. The requested scopes must be a subset of the
  plugin's `manifest.scopes`. Use for production integrations.

Both kinds expose the same surface to consumers — the type matters only for
ownership and display.

## Format

Keys are opaque, prefix-tagged tokens:

```
forge_sk_kRA9xH4nQ2pV7sL1mY8oF3bD6gT0cZ5eW
```

Stored as a SHA-256 hash. The plaintext is shown **once** at creation and
never again — copy it, pass it to a secret manager, and forget the original
form.

The 14-character prefix (`forge_sk_kRA9xH`) is retained on the row so the UI
can display the key in lists without exposing the secret half.

::: warning
There is no recovery path for a lost key. Revoke and re-issue — that is the
intended workflow.
:::

## Scopes

The `PluginScope` enum defines what a key is allowed to do:

| Scope              | Grants                                                       |
|--------------------|--------------------------------------------------------------|
| `READ_ISSUES`      | List/read issues, relations, comments-on-issues              |
| `WRITE_ISSUES`     | Create/update/transition/assign/queue issues                 |
| `READ_PROJECTS`    | List/read projects, initiatives                              |
| `WRITE_PROJECTS`   | Create/update/archive projects, initiatives                  |
| `READ_COMMENTS`    | List/read comments                                           |
| `WRITE_COMMENTS`   | Create/update/soft-delete comments                           |
| `READ_USERS`       | List/read workspace members                                  |
| `READ_ANALYTICS`   | Run analytics queries (summary, throughput, dispatch, …)     |
| `SUBSCRIBE_EVENTS` | Open SSE stream at `/api/plugins/events`                     |
| `INVOKE_SKILLS`    | Call plugin skills via MCP                                   |
| `ADMIN`            | Workspace admin operations (member mgmt, dispatch rules, …)  |

Scopes are checked on every MCP call. Missing the required scope returns
`403` with `{ "error": "scope_required", "scope": "WRITE_ISSUES" }`.

## Narrowing (optional)

On top of coarse scopes, a key can be restricted to specific entities:

- `projectIds: string[]`
- `labelIds: string[]`
- `initiativeIds: string[]`

Empty array = unrestricted within the declared scopes. Non-empty = key only
sees and acts on rows matching those ids.

::: tip
Narrowing is the right tool for "let this plugin touch only the
`#growth` initiative" or "let this script only work in the `infra`
project". It composes — a key with both `projectIds` and `labelIds` set
matches issues that are in one of the projects **OR** carry one of the
labels.
:::

## Enforcement

Three functions in `src/server/services/api-key-auth.ts` do the work:

### `authenticateApiKey`

Checks validity. Returns the key row + linked agent (if any), or a typed
error. Specifically:

- Hash mismatch → `invalid`
- `revokedAt` set → `revoked`
- `expiresAt` in the past → `expired`

All three resolve to `401` at the route handler.

### `assertKeyScope`

Per-entity check using narrowing arrays. The rules:

- **Issue.** Passes if no narrowing is set, OR `issue.projectId` is in
  `projectIds`, OR any label on the issue is in `labelIds`. (Initiative
  narrowing does not apply to individual issues — they are linked to
  projects, not initiatives.)
- **Project.** Passes if no narrowing OR `project.id` is in `projectIds`.
- **Initiative.** Passes if no narrowing OR `initiative.id` is in
  `initiativeIds`.

A key with `projectIds = ["A"]` and `labelIds = ["urgent"]` can act on issues
in project A, **plus** issues anywhere carrying the `urgent` label.

### `buildKeyScopeWhere`

Returns a Prisma `where` fragment for list queries — so a narrowed key's
`issues.list` returns the narrowed result set, not "all issues then 403". The
shape:

```ts
{
  workspaceId,
  OR: [
    ...(projectIds.length ? [{ projectId: { in: projectIds } }] : []),
    ...(labelIds.length ? [{ labels: { some: { id: { in: labelIds } } } }] : []),
  ],
}
```

If both arrays are empty, the `OR` is dropped entirely and the query is
unrestricted (within the workspace).

## `linkedAgentId`

A key can optionally point at an `Agent` row. When set:

- `agents.me` returns that agent.
- `agents.heartbeat` updates that agent's `lastHeartbeatAt` and `status`.
- `issues.assigned` (with no `agentId`/`profileKey` argument) returns issues
  assigned to that agent.

This is the right shape for per-agent keys. Hermes' Victor and Mizu profiles,
Claude sessions, Codex sessions, and custom bridges can each carry a
`linkedAgentId` so their MCP calls automatically resolve "me" without the
caller passing identity on every request.

::: warning
Keys with `linkedAgentId` set to an archived agent are rejected by
`agents.me` and `agents.heartbeat` with `403`. Re-link or revoke when an
agent is archived.
:::

## Lifecycle

```
create → use → (expiresAt) → revoke
```

| Field        | Behavior                                                   |
|--------------|------------------------------------------------------------|
| `createdAt`  | Set at issue                                               |
| `lastUsedAt` | Bumped on every authenticated call (best-effort)           |
| `expiresAt`  | Optional. After this, calls 401 with `expired`             |
| `revokedAt`  | Set on revoke. Calls 401 immediately with `revoked`        |

Revoked keys cannot be un-revoked — issue a new one. This is intentional;
the audit trail should reflect "this key stopped working at this moment"
without ambiguity.

## Sample request

```bash
curl -X POST https://forge.example/api/mcp/issues.create \
  -H "Authorization: Bearer $FORGE_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "title": "auto-filed from CI", "priority": "HIGH", "projectId": "cle9k4z2j0010qg9k4f7r2x1d" }'
```

Successful response:

```json
{
  "id": "cle9k4z2j0033qg9k7m4n8p2x",
  "key": "AXI-127",
  "title": "auto-filed from CI",
  "priority": "HIGH",
  "statusId": "cle9k4z2j0003qg9k7n4p2x",
  "createdAt": "2026-04-26T18:14:02.108Z"
}
```

Or, via JSON-RPC:

```bash
curl -X POST https://forge.example/api/mcp/rpc \
  -H "Authorization: Bearer $FORGE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "issues.create",
      "arguments": { "title": "auto-filed from CI", "priority": "HIGH" }
    }
  }'
```

## Practical advice

- **Per-agent keys should set `linkedAgentId`.** It removes a class of
  identity bugs in MCP code that needs `agents.me`.
- **Plugin keys should narrow** to the `projectIds` / `labelIds` /
  `initiativeIds` the plugin actually touches. A leaked key with broad
  scope is an incident; a leaked key narrowed to one initiative is an
  inconvenience.
- **Rotate by reissue.** Mint the new key, deploy it, then revoke the old.
  There is no "rotate in place" because there is no shared secret to
  rotate — each key is its own credential.
- **Set `expiresAt`** on bot keys you can re-mint cheaply. A 90-day key
  that auto-rotates is dramatically lower-risk than a static one.

## Cross-references

- [/concepts/scopes-and-tenancy.html](/concepts/scopes-and-tenancy.html) —
  how workspace scoping interacts with key narrowing.
- [/reference/mcp.html](/reference/mcp.html) — every tool a key can call.
- [/automation/plugins.html](/automation/plugins.html) — minting plugin keys
  via `plugin.issueApiKey`.
- [/automation/webhooks.html](/automation/webhooks.html) — the push
  alternative to SSE for `SUBSCRIBE_EVENTS`.
