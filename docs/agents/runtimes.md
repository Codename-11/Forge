# Runtimes

A **Runtime** is the compute environment that hosts one or more agents.
Where `Agent` describes *who* (a profile, a webhook secret, a runtime
mode) and `runtimeMode` describes *how* the agent stays online, `Runtime`
describes *where the work physically happens*.

::: tip Distinct from `runtimeMode`
`Agent.runtimeMode` is `PERSISTENT | EPHEMERAL` and lives on the agent
row — it tells the chat composer whether to expect immediate delivery.
`Runtime` is a separate primitive — the host. One Runtime can carry
multiple agents; one agent points at one Runtime via nullable
`runtimeId`.
:::

## Runtime kinds

```prisma
enum RuntimeKind {
  LOCAL_DAEMON      // `forge daemon` running on a user's machine
  REMOTE_HTTP       // existing Hermes-style webhook receiver
  CLOUD             // reserved for future cloud-hosted runtime
}
```

| Kind          | Endpoint        | Presence model                                       |
|---------------|-----------------|------------------------------------------------------|
| `LOCAL_DAEMON`| no `endpoint`   | Daemon subscribes to `/api/plugins/events` SSE and pulls work. |
| `REMOTE_HTTP` | webhook URL     | Forge pushes events outbound over HTTPS with HMAC.   |
| `CLOUD`       | reserved        | Not yet implemented.                                 |

`Runtime.heartbeatAt` is bumped by the runtime itself (not its agents) —
an idle runtime can still be alive while none of its agents have done
anything recently.

## Backfill from legacy webhook agents

Migration `0018_runtime_and_token_usage` creates a
`<agent name> (legacy webhook)` Runtime per existing Agent that has a
`webhookUrl`, copies the URL + secret + provider, and points the agent's
new `runtimeId` at it. `Agent.webhookUrl` and `Agent.webhookSecret`
remain in place as the source of truth for `REMOTE_HTTP` runtimes — a
future cleanup migration will make Runtime authoritative and drop those
columns.

## Where Runtimes show up

- **`/settings/runtimes`** — index page, one card per Runtime with kind
  badge, providers, last heartbeat, owner, agent count, adapter capabilities,
  and declared local tool surface.
- **`/settings/runtimes/[id]`** — detail. Lists agents on this runtime
  and surfaces a copy-pasteable `forge daemon start` recipe for empty
  `LOCAL_DAEMON` rows. The detail page also shows whether the runtime
  declares `terminal`, `filesystem`, and `git` access.
- **Agent detail page** — small Runtime card that click-throughs to the
  runtime detail.
- **Mission Control agents tab** — compact `RuntimeChip` next to the
  runtime-mode pill.

## tRPC

```ts
trpc.runtime.list.useQuery()
trpc.runtime.byId.useQuery({ id })
trpc.runtime.register.mutate({
  name, kind, endpoint?, providersAvailable
})
trpc.runtime.heartbeat.mutate({ id })
trpc.runtime.archive.mutate({ id })
trpc.runtime.update.mutate({
  id, name?, providersAvailable?, config?
})
```

All `workspaceProcedure`-gated.

## Runtime config and tool surface

`Runtime.config` is adapter-specific. For Hermes, Forge stores only
non-secret declarations used for operator visibility and preflight checks:

```json
{
  "localWorkspaceTools": true,
  "toolCapabilities": ["terminal", "filesystem", "git"],
  "workspaceRoot": "/home/bailey/forge"
}
```

This does **not** grant tools to Hermes. The Hermes gateway/profile must
actually run with those tools enabled and that repo mounted or available.
Once true, set the declaration in **Settings → Runtimes → Edit** or via:

```bash
forge runtimes configure <runtimeId> \
  --local-workspace-tools \
  --tool terminal \
  --tool filesystem \
  --tool git \
  --workspace-root /home/bailey/forge
```

Code/repo issue preflight uses this declaration to decide whether Wake/Kick is
likely to help or whether the work should move to a local-tool runtime.

## MCP tools (for runtimes that auto-register)

`runtimes.register`, `runtimes.heartbeat`, and `runtimes.configure` are
`ADMIN`-scoped. The `forge` CLI's `daemon start` calls register/heartbeat;
operators can call configure to set runtime config without direct DB access.

See [/reference/mcp.html#runtimes](/reference/mcp.html#runtimes) for
exact shapes.

## The `forge` CLI + local daemon

`tools/forge-cli/` ships a local CLI that registers a `LOCAL_DAEMON`
Runtime, subscribes to the SSE event stream, and dispatches incoming
chat messages to a configured provider adapter (Claude Code at v1).

```bash
pnpm build:cli
pnpm forge login --url http://localhost:3000 \
                 --workspace <slug> \
                 --token forge_sk_...
pnpm forge whoami
pnpm forge daemon start --fg
```

The daemon:

1. Auto-detects `claude`, `codex`, `hermes`, `gemini`, `cursor-agent`
   on PATH and reports them as `providersAvailable`.
2. Calls MCP `runtimes.register` (or restores a cached `runtimeId` from
   `~/.config/forge/daemon.json`).
3. Opens `${url}/api/plugins/events` SSE with the bearer token.
4. On `CHAT_MESSAGE_POSTED` for an agent on this runtime, spawns
   `claude` and streams the reply back through `chat.startDraft` →
   `chat.appendDraftChunk` → `chat.finalizeDraft`.
5. Heartbeats every 60s via `runtimes.heartbeat`.

Missing `claude` binary on PATH falls through to a friendly `[OFFLINE]`
reply via `chat.finalizeDraft` — no daemon crash.

### What the daemon does on dispatch

- **`CHAT_MESSAGE_POSTED` (role=USER)** — reads `body` + `context`
  directly from the SSE payload, calls `agent.context.bundle({
  threadId })` for thread history + linked-issue summary +
  workspace, inlines image / PDF / text attachments via
  `attachments.getInline`, and spawns the provider adapter with the
  bundle as system prompt and the user message as a content-block
  array (image attachments pass as
  `{type:"image",source:{type:"base64",...}}`).
- **`AGENT_ASSIGNED`** — reads `payload.issueSnapshot` for fast
  framing, bundles the full issue context (description / comments /
  attachments / relations / current run / workspace), inlines
  attachments, **calls `statuses.list({ category: "IN_PROGRESS" })`
  and transitions the issue to the first matching status (skipped if
  the issue is already in IN_PROGRESS or IN_REVIEW; no-op when the
  workspace has no IN_PROGRESS-category status, or when the workspace
  already auto-transitioned server-side via `Workspace.startedStatusId`
  — the daemon's check is idempotent)**, posts a starter comment,
  then spawns the provider with the bundle. Posts progress comments
  at assistant message boundaries (capped) and a final summary on
  exit. Calls `runs.recordUsage` with the `usage` block parsed from
  claude's `result` event. Idempotent against delivery retries via an
  in-memory bounded set keyed by event id.

::: tip Server-side auto-transition (Workspace.startedStatusId)
When the workspace has `startedStatusId` set (admin → settings →
workspace → "Auto-transition on assignment"), the AGENT_ASSIGNED
audit fan-out flips the issue to that status atomically with the
event write. Webhook payload gains an `autoTransitionedTo: <statusId>`
field and `issueSnapshot.statusId` reflects the post-transition
state. Agents (local daemon AND Hermes-driven Victor/Mizu) can skip
the client-side `statuses.list` + `issues.transition` round-trip when
they observe `autoTransitionedTo` in the payload.
:::

::: warning v1 limitations
- Login takes URL + token directly (no OAuth device-code flow yet).
- The AGENT_ASSIGNED loop only auto-runs for `CLAUDE` provider
  agents; other providers receive a placeholder comment.
- No automatic `IN_PROGRESS` status transition on dispatch — there's
  no `statuses.list` MCP tool yet to discover the workspace's
  category-mapped started status.
:::

## Token usage on AgentRun

`AgentRun` gained `tokensIn`, `tokensOut`, `tokensCached`, `costUsd` in
the same migration. Agents call MCP `runs.recordUsage({ runId,
tokensIn?, tokensOut?, tokensCached?, costUsd? })` once per finished
step or once at run completion. The call is idempotent — latest call
replaces, doesn't add — so report the cumulative count for the run.

Mission Control's RunRow surfaces an `Xk tok` chip next to elapsed time
when token columns are populated.

## Cross-references

- [/agents/runtime-modes.html](/agents/runtime-modes.html) — agent
  presence model (PERSISTENT vs EPHEMERAL).
- [/agents/integrations.html](/agents/integrations.html) — runtime
  adapter manifest (Hermes, Claude, Codex, Custom).
- [/reference/mcp.html#runtimes](/reference/mcp.html#runtimes) —
  `runtimes.register`, `runtimes.heartbeat`, `runs.recordUsage`.
- [/reference/trpc.html#runtime](/reference/trpc.html#runtime) — full
  router catalog.
