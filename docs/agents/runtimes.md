# Runtimes

A **Runtime** is the compute environment that hosts one or more agents.
Where `Agent` describes _who_ (a profile, a webhook secret, a runtime
mode) and `runtimeMode` describes _how_ the agent stays online, `Runtime`
describes _where the work physically happens_.

::: info Runtime versus MCP client
A Mission Control agent profile selects **zero or one primary execution runtime**.
Codex, Claude, Hermes, and custom MCP clients connect with separate linked
credentials in the workspace's **Agent access** page; a binding can have many
of those clients. Adding an MCP client never changes the profile's runtime.
Both are represented as concrete `AgentConnection` endpoints when they
participate in work, so delivery attribution can say “Codex via Codex Desktop
MCP” or “Victor via Hermes runtime” without changing the Agent identity.
:::

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

| Kind           | Endpoint      | Presence model                                                 |
| -------------- | ------------- | -------------------------------------------------------------- |
| `LOCAL_DAEMON` | no `endpoint` | Daemon subscribes to `/api/plugins/events` SSE and pulls work. |
| `REMOTE_HTTP`  | webhook URL   | Forge pushes events outbound over HTTPS with HMAC.             |
| `CLOUD`        | reserved      | Not yet implemented.                                           |

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
  declares `terminal`, `filesystem`, and `git` access, plus the latest
  sanitized runtime version/environment metadata when the host reports it.
- **Mission Control agent profile detail** — readiness summary plus an editable primary
  Runtime assignment that synchronizes to active workspace bindings.
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
  "workspaceRoot": "/home/bailey/forge",
  "modeToolPolicyEnforced": true
}
```

The local workspace fields do **not** grant tools to Hermes. The Hermes
gateway/profile must actually run with those tools enabled and that repo
mounted or available. `modeToolPolicyEnforced` is a separate truth claim: set it
only when the Hermes host honors Forge's per-run `tool_allowlist` for
Research/Review/Discuss. When false or absent, Forge still blocks Forge MCP
issue mutations, but host tools are prompt-only.
When true, Hermes should disable local terminal/file/code/desktop surfaces for
restricted modes without disabling skills, memory, web/search, Forge context
reads, or delegation; delegated subagents must inherit the same disabled local
toolsets.
Once true, set the declaration in **Settings → Runtimes → Edit** or via:

```bash
forge runtimes configure <runtimeId> \
  --local-workspace-tools \
  --tool terminal \
  --tool filesystem \
  --tool git \
  --workspace-root /home/bailey/forge \
  --mode-tool-policy-enforced
```

Code/repo issue preflight uses this declaration to decide whether Wake/Kick is
likely to help or whether the work should move to a local-tool runtime.

Forge validates stored runtime config against the current adapter schema when it
builds runtime lists and the Mission Control compliance scorecard. Rows written
by older builds, direct SQL, or external tools surface as `config-mismatch`,
`legacy config`, or `unknown adapter` until an operator re-saves the runtime or
fixes the adapter key. This is intentionally diagnostic: valid config stays
quiet, while stale config appears beside the runtime's tool-surface badges and
as a compliance signal for bound agents.

For Codex app-server, the same runtime config also carries the per-turn sandbox
policy. Setting `workspaceRoot` is the important bit: Forge sends it as the
Codex turn `cwd`, and the UI saves `localWorkspaceTools` plus
`toolCapabilities: ["terminal", "filesystem", "git"]` alongside it so runtime
cards and preflight match the actual scoped workspace (for example
`/work/agent-forge` inside the bridge container).

For containerised Codex app-server deployments, use the Docker bridge pattern in
[Codex App-Server Docker Bridge](./codex-app-server-docker.md). The bridge
should call `runtimes.reportInfo` on boot so operators can see the bridge,
Codex, container, and workspace versions from the runtime detail page.

## Diagnostics use the execution worker

**Test connection** and the no-tool **Self-test** enqueue a diagnostic on the
same worker process that dispatches managed Runs. The runtime detail page keeps
the most recent diagnostic history and labels each result with its worker
executor plus its manual or scheduled trigger. This prevents a web-container
network pass from being presented as proof that the worker can dispatch work.
If an operator-requested diagnostic times out, inspect the worker queue and its
outbound DNS/network policy; Forge does not fall back to probing from the web
process.

## MCP tools (for runtimes that auto-register)

`runtimes.register`, `runtimes.heartbeat`, `runtimes.configure`, and
`runtimes.archive` are `ADMIN`-scoped. The `forge` CLI's `daemon start` calls
register/heartbeat; operators can call configure to set runtime config, or
`runtimes.archive` (`forge runtimes archive <id>`) to deregister a runtime,
without direct DB access.
`runtimes.reportInfo` is agent-linked rather than admin-scoped so a runtime
bootstrap key can report its own sanitized metadata without broad operator
permissions.

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
- If `Workspace.startedStatusId` is not configured, agents or daemons
  should use `statuses.list({ category: "IN_PROGRESS" })` and transition
  explicitly when Execute-mode work actually starts.
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
