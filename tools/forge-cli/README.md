# `@axiom-labs/forge-cli`

Local CLI + daemon for [Forge](https://github.com/axiom-labs/forge). The
daemon auto-detects agent CLIs on PATH (`claude`, `codex`, `hermes`,
`gemini`, `cursor-agent`), registers a `Runtime` row in Forge, opens an
SSE subscription to the workspace event stream, and bridges chat replies
into the matching provider — currently **Claude Code only**.

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
and `runs.recordUsage` can infer the agent.

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
   filters for `CHAT_MESSAGE_POSTED` (USER role) targeting your linked
   agent → spawns Claude Code with stream-json I/O → forwards deltas to
   `chat.appendDraftChunk` → calls `chat.finalizeDraft` on stream end.
5. On `AGENT_ASSIGNED` for your linked agent, posts a placeholder
   comment via `comments.create`. Full agent loop is **not yet
   implemented**.

## Read-only commands

```bash
forge runtimes list           # local view (no runtimes.list MCP tool yet)
forge agents list             # the linked agent only
forge issues list             # most recent 25 issues
forge issues list --mine      # issues assigned to your linked agent
forge issue assign AXI-42 victor
```

## Provider matrix

| Provider | Adapter | Status |
|----------|---------|--------|
| `CLAUDE` | spawn `claude --print --input-format stream-json --output-format stream-json --include-partial-messages --verbose --permission-mode bypassPermissions` | working |
| `CODEX`  | — | stub (finalizes a placeholder reply) |
| `HERMES` | — | stub (Hermes runs as REMOTE_HTTP, not via this daemon) |
| `CUSTOM` | — | stub |

Override the binary path with `FORGE_CLAUDE_BIN=/abs/path/to/claude`.

## Manual smoke test

If you don't have a token handy, the easiest path is:

1. Spin up Forge dev: `pnpm dev` in repo root.
2. Sign in, open Settings → API Keys, mint a `kind=AGENT` key linked to
   yourself (e.g. `victor`), copy the `forge_sk_...` value.
3. `forge login --url http://localhost:3000 --workspace <slug> --token <token>`.
4. `forge whoami` — should print URL, workspace, and the linked agent.
5. `forge daemon start --fg` — should print "runtime ... registered",
   "linked agent: ...", "SSE connected".
6. From the web UI, send a chat message to the same agent. The daemon
   should log the dispatch and a streamed reply should appear in the
   chat thread.

## Limitations (v1 scope)

- No OAuth device-code flow — token is required upfront.
- No `runtimes.list` / `agents.list` MCP tools yet, so those CLI
  commands only show the local view. The web UI has the full list.
- Chat dispatch sends a placeholder prompt — the SSE event payload
  doesn't carry the message body, and there's no `chat.getThread` MCP
  tool yet. Claude is told this and instructed to acknowledge briefly.
- `AGENT_ASSIGNED` only posts a comment; no actual agent work loop.
- `gemini` and `cursor-agent` are detected and reported as `CUSTOM`
  providers (the schema's `AgentProvider` enum has no slot for them).
