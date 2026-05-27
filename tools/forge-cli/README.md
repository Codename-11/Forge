# `@axiom-labs/forge-cli`

Local CLI + daemon for [Forge](https://github.com/axiom-labs/forge). The
daemon auto-detects agent CLIs on PATH (`claude`, `codex`, `hermes`,
`gemini`, `cursor-agent`), registers a `Runtime` row in Forge, opens an
SSE subscription to the workspace event stream, and bridges chat replies
+ issue dispatch into the matching provider — currently **Claude Code only**.

## Install

From the Forge repo (workspace install):

```bash
pnpm install                 # picks up tools/forge-cli via the workspace
pnpm build:cli               # compiles tools/forge-cli/dist
pnpm forge --help            # convenience script
# or directly:
node tools/forge-cli/dist/index.js --help
```

For everyday use add an alias:

```bash
alias forge='node /path/to/forge/tools/forge-cli/dist/index.js'
```

## First run

```bash
forge login --url https://forge.axiom-labs.dev \
            --workspace axi \
            --token forge_sk_...
forge whoami
```

`login` writes `~/.config/forge/auth.json` with mode 600. The token must
be a Forge `ApiKey` — mint one in **Settings → API Keys**. For the
daemon you want `kind=AGENT` with `linkedAgentId` set so chat dispatch
and `runs.recordUsage` can infer the agent. ADMIN scope is also
required on the key for the daemon to call `runtimes.register` /
`runtimes.heartbeat` / `runtimes.list`.

## Daemon

```bash
forge daemon start            # backgrounds; logs to ~/.config/forge/daemon.log
forge daemon start --fg       # foreground; prints SSE arrivals to stdout
forge daemon status
forge daemon stop
```

On start the daemon:
1. Detects `claude`/`codex`/`hermes`/`gemini`/`cursor-agent` on PATH.
2. Registers (or reuses) a `LOCAL_DAEMON` Runtime named after
   `os.hostname()`. State is cached at `~/.config/forge/daemon.json`.
3. Heartbeats every 60s via `runtimes.heartbeat`.
4. Subscribes to `/api/plugins/events` (the API-key SSE stream) and
   filters for events targeting the linked agent.

### What the daemon does on dispatch

- **`CHAT_MESSAGE_POSTED` (role=USER) for the linked agent** —
  reads `body` + `context` directly from the SSE payload, calls
  `agent.context.bundle({ threadId })` to grab thread history + linked
  issue + workspace, calls `attachments.getInline` for image / PDF /
  text attachments on the message and the linked issue, then spawns
  Claude Code (`--print --input-format stream-json --output-format
  stream-json --include-partial-messages --verbose --permission-mode
  bypassPermissions`) with the bundle as system context and the
  inbound user message as a content-block array (image attachments go
  as `{type:"image",source:{type:"base64",media_type,data}}`; text
  attachments are decoded utf-8 and inlined as text blocks; PDFs are
  announced by filename only). Streams `content_block_delta` deltas
  through `chat.appendDraftChunk` and the final body via
  `chat.finalizeDraft`.

- **`AGENT_ASSIGNED` for the linked agent** —
  reads `payload.issueSnapshot` for fast initial framing, calls
  `agent.context.bundle({ issueId })` for the full picture, inlines
  attachments under the same allowlist, posts a starter comment via
  `comments.create` (this opens the AgentRun server-side), re-bundles
  to capture `currentRun.id`, then spawns Claude Code with the
  bundle + a "you've been assigned, plan and execute" instruction.
  At each assistant message boundary the daemon posts a progress
  comment (capped at 12 per run). On exit it posts a final summary
  comment and calls `runs.recordUsage` with the `usage` block parsed
  from claude's `result` event (`input_tokens` →
  `tokensIn`, `output_tokens` → `tokensOut`,
  `cache_read_input_tokens` → `tokensCached`,
  `total_cost_usd` → `costUsd`). Idempotent — same SSE event id
  fires once via an in-memory bounded set.

  Auto-transition to `IN_PROGRESS` is intentionally skipped today —
  there's no `statuses.list` MCP tool to discover the workspace's
  category-mapped started status.

## Read-only commands

```bash
forge runtimes list                  # via runtimes.list MCP; --json, --archived
forge agents list                    # workspace bindings via agents.list; --json, --archived, --runtime <id>
forge agents list --global           # global AgentProfile defs via agents.profiles.list; --mine, --json, --archived
forge issues list                    # most recent 25 issues
forge issues list --mine             # issues assigned to your linked agent
forge issue assign AXI-42 victor
```

## Provider matrix

| Provider | Adapter | Status |
|----------|---------|--------|
| `CLAUDE` | spawn `claude --print --input-format stream-json --output-format stream-json --include-partial-messages --verbose --permission-mode bypassPermissions` | working (chat + issue loop) |
| `CODEX`  | — | stub (finalizes a placeholder reply) |
| `HERMES` | — | stub (Hermes runs as REMOTE_HTTP, not via this daemon) |
| `CUSTOM` | — | stub |

Override the binary path with `FORGE_CLAUDE_BIN=/abs/path/to/claude`.

## Manual smoke test

If you don't have a token handy, the easiest path is:

1. Spin up Forge dev: `pnpm dev` in repo root.
2. Sign in, open Settings → API Keys, mint a `kind=AGENT` key with
   ADMIN scope linked to yourself (e.g. `victor`), copy the
   `forge_sk_...` value.
3. `forge login --url http://localhost:3000 --workspace <slug> --token <token>`.
4. `forge whoami` — should print URL, workspace, and the linked agent.
5. `forge daemon start --fg` — should print "runtime ... registered",
   "linked agent: ...", "SSE connected".
6. **Chat smoke:** From the web UI, send a chat message to the same
   agent (Mission Control → Chat tab, chord 5). The daemon should log
   the dispatch and a streamed reply should appear in the chat thread,
   grounded on the message body. Attach an image to the chat message
   and the daemon should pass it as an image content block.
7. **Issue smoke:** Assign an issue to the same agent (web UI or
   `forge issue assign AXI-N <profileKey>`). The daemon should log
   `AGENT_ASSIGNED`, post a starter comment, then progress comments
   from Claude's output, then a final summary, then a
   `runs.recordUsage` call. Re-deliver the same event id (kill +
   restart the daemon while the event is still being retried) — the
   daemon should skip duplicate handling.
8. **List smoke:** `forge runtimes list` and `forge agents list`
   should print the same rows the web UI shows at `/settings/runtimes`
   and `/agents`. `--json` flags emit raw JSON for piping.

## Limitations (v1 scope)

- No OAuth device-code flow — token is required upfront.
- `gemini` and `cursor-agent` are detected and reported as `CUSTOM`
  providers (the schema's `AgentProvider` enum has no slot for them).
- AGENT_ASSIGNED loop only auto-runs for `CLAUDE` provider agents;
  other providers post a placeholder comment.
- No automatic `IN_PROGRESS` status transition on dispatch — the
  daemon doesn't yet have a `statuses.list` MCP tool to discover the
  workspace's "started" status mapping.
