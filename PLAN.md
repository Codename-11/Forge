# Plan — Multica-inspired Forge upgrades (single-run handoff)

> Created 2026-04-28. Designed to be picked up cold in a fresh session.
> Read this top-to-bottom before dispatching agent team. No prior
> context required beyond `~/forge/CLAUDE.md` + `~/forge/DEVLOG.md`.

## Goal

Forge currently models agents as remote webhook receivers. That works
for Hermes (a daemon you run yourself) but assumes "where the agent
runs" is just a URL on someone else's machine. Multica's architecture
treats the **runtime** (the compute environment that hosts agents) as
a first-class primitive distinct from the agent itself, and ships a
local daemon that auto-detects available CLIs (Claude Code, Codex,
Hermes, etc.) on the user's PATH.

This plan brings four of those ideas to Forge:

1. **Runtime as a primitive** — separate from `Agent`. A runtime hosts
   one or more agents.
2. **Token usage tracking** on `AgentRun` (tokens in/out/cached, cost).
3. **Unified agent activity timeline** — interleaved view of comments,
   activity events, and run events with the agent's `currentStep` /
   reasoning surfaced inline.
4. **`forge` CLI + local daemon** — auto-detects local agent CLIs,
   registers a `Runtime`, subscribes to dispatch events via SSE,
   spawns the appropriate CLI (initially Claude Code), streams output
   back via the existing `chat.startDraft / appendDraftChunk /
   finalizeDraft` MCP tools.

Out of scope (explicitly):
- Skills library as a Forge concept (Hermes already does skills well;
  duplicating would be confusing).
- Cloud-first deployment model (Forge stays self-hosted).

## High-level architecture

### Runtime model

```prisma
enum RuntimeKind {
  LOCAL_DAEMON      // `forge daemon` running on a user's machine
  REMOTE_HTTP       // existing Hermes-style webhook receiver
  CLOUD             // reserved for a future cloud-hosted runtime
}

model Runtime {
  id                 String          @id @default(cuid())
  workspaceId        String
  name               String          // "Bailey's MacBook", "Hermes (docker-server)"
  kind               RuntimeKind
  /// Webhook URL for REMOTE_HTTP. For LOCAL_DAEMON the daemon polls
  /// Forge via SSE; this field stays null.
  endpoint           String?
  /// HMAC secret for outbound webhook signing (REMOTE_HTTP only).
  secret             String?
  /// Providers this runtime can host. For REMOTE_HTTP it's whatever
  /// the operator declares; for LOCAL_DAEMON the daemon reports it
  /// from PATH detection on registration + reconnect.
  providersAvailable AgentProvider[]
  /// Last successful heartbeat from the runtime itself. Distinct from
  /// per-agent heartbeat: an idle runtime can still be alive while no
  /// agent on it has done anything recently.
  heartbeatAt        DateTime?
  /// Last connect time for LOCAL_DAEMON (when the SSE subscription
  /// opened). Null for REMOTE_HTTP.
  connectedAt        DateTime?
  /// Optional auth-token-prefix for the daemon's `forge login` token.
  /// Stored only for ops display; the underlying ApiKey row is the
  /// source of truth.
  ownerKeyPrefix     String?
  /// User who registered this runtime.
  ownerId            String?
  archivedAt         DateTime?
  createdAt          DateTime        @default(now())
  updatedAt          DateTime        @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  owner     User?     @relation(fields: [ownerId], references: [id], onDelete: SetNull)
  agents    Agent[]   @relation("AgentRuntime")

  @@index([workspaceId, archivedAt])
  @@index([ownerId])
}
```

Add to `Agent`:
```prisma
runtimeId String?
runtime   Runtime? @relation("AgentRuntime", fields: [runtimeId], references: [id], onDelete: SetNull)
```

Don't drop `Agent.webhookUrl` / `webhookSecret` in this round — keep
them as the canonical source for REMOTE_HTTP agents and let
`runtime.endpoint` be a derived/synced view. Add a brief comment in
schema: future cleanup is to make Runtime authoritative and drop the
columns. Leaving both works for backfill + zero-downtime.

### Token usage on AgentRun

```prisma
model AgentRun {
  // existing fields...
  tokensIn       Int?
  tokensOut      Int?
  tokensCached   Int?
  costUsd        Decimal? @db.Decimal(10, 4)
}
```

New MCP tool `runs.recordUsage({ runId, tokensIn?, tokensOut?,
tokensCached?, costUsd? })` — agents call once per finished step or
once at run completion. Idempotent: latest call wins (replaces, not
adds — the run-level fields are cumulative *as reported by the agent*).

### Unified agent activity timeline

No schema changes. New tRPC query
`agent.unifiedTimeline({ profileKey, before?: Date, limit: 50 })`
that:
1. Queries `Comment` where `authoringAgentId = agent.id`.
2. Queries `ActivityEvent` where `actorId IS NULL AND subjectType
   = 'agent-run' AND payload->>'agentId' = agent.id` (the
   AGENT_RUN_* family) PLUS where the event was originated by an
   ApiKey with `linkedAgentId = agent.id`.
3. Queries `AgentRunEvent` for all runs of this agent.
4. Merges client-rendered timeline rows with type discriminators
   (`comment | event | run-event`), sorts by timestamp descending,
   paginates with a cursor.

UI: replace the "Recent activity" feed on `/agents/[profileKey]` with
the unified timeline. Each row renders type-appropriate detail:
- Comment → markdown body, target issue link.
- AgentRunEvent → kind glyph + currentStep + payload preview.
- ActivityEvent → kind glyph + subject link.

Also wire it into the Mission Control Live tab — the `RunRow` already
expands into `RunTimeline`; that timeline can pull the wider
`unifiedTimeline` query when the operator wants more context.

### `forge` CLI + local daemon

**Stack decision:** TypeScript + Node, distributed as
`@axiom-labs/forge-cli` on npm (and via a lightweight install script
later). Starts simple — no compiled binary in v1. Lives in
`packages/forge-cli/` inside the existing Forge monorepo (currently
the repo isn't a monorepo — make it one in this round, with the
existing app moving to `packages/web/`).

Actually, **revise**: changing the repo to a monorepo is a big
disruption mid-stream. Instead, put the CLI in a sibling repo or in
`tools/forge-cli/` inside this repo with its own `package.json`. The
sibling repo route is cleaner for distribution; `tools/forge-cli/` is
faster to ship.

**Decision: `tools/forge-cli/`** with its own `package.json` and
`tsconfig.json`. The cli pubsishes via a separate npm publish flow
(out of scope for this run — for now developers use
`pnpm --filter forge-cli build && node tools/forge-cli/dist/cli.js
...` or a `pnpm forge` script wrapper).

CLI commands (v1):
```
forge login                  # device-code flow → stores at ~/.config/forge/auth.json
forge whoami                 # prints user, workspace, runtime registration
forge daemon start [--fg]    # registers runtime, opens SSE, dispatches events
forge daemon status
forge daemon stop
forge runtimes list
forge agents list
forge issues list [--mine]
forge issue assign <key> <agent-profileKey>
```

**Daemon flow:**
1. On start, reads `~/.config/forge/auth.json`. If missing, prompt
   `forge login` first.
2. Auto-detects available CLIs on PATH:
   `which claude codex hermes gemini cursor-agent` → maps to
   `AgentProvider[]`.
3. Calls Forge MCP `runtimes.register` (NEW) with name (defaults to
   `os.hostname()`), kind=LOCAL_DAEMON, providersAvailable.
4. Subscribes to `/api/realtime` SSE filtered to events targeted at
   this runtime — **NEW server-side filter:** events whose payload
   carries `runtimeId` matching this caller's runtime, OR events for
   agents whose `runtimeId` is this runtime.
5. On each event:
   - `CHAT_MESSAGE_POSTED` (role=USER): look up the agent's provider
     → spawn the corresponding CLI with the prompt → stream stdout
     into `chat.appendDraftChunk` → `chat.finalizeDraft`.
   - `AGENT_ASSIGNED`: spawn CLI with structured prompt for issue
     work; periodically post `comments.create` with progress, call
     `runs.recordUsage` with token counts when the CLI emits them.
6. Heartbeat: every 60s, call MCP `runtimes.heartbeat` (NEW).

**Provider adapter — Claude Code (v1 only, others stub):**
- Spawn `claude --print --output-format stream-json --input-format
  stream-json` (or whatever the current Claude Code streaming flag
  shape is — verify with `claude --help` at implementation time).
- Pipe a JSON message into stdin: the chat body + context bundle.
- Parse stream-json output for content events; forward `delta` to
  `chat.appendDraftChunk`.
- On stream end, finalize.

If `claude` isn't available, the daemon emits a friendly error and
posts a `[OFFLINE]` chat reply via `chat.finalizeDraft`.

## Schema changes (consolidated)

Migration `0018_runtime_and_token_usage`:

```sql
-- Runtime
CREATE TYPE "RuntimeKind" AS ENUM ('LOCAL_DAEMON', 'REMOTE_HTTP', 'CLOUD');

CREATE TABLE "Runtime" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "RuntimeKind" NOT NULL,
  "endpoint" TEXT,
  "secret" TEXT,
  "providersAvailable" "AgentProvider"[] NOT NULL DEFAULT '{}',
  "heartbeatAt" TIMESTAMP(3),
  "connectedAt" TIMESTAMP(3),
  "ownerKeyPrefix" TEXT,
  "ownerId" TEXT,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Runtime_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Runtime_workspaceId_archivedAt_idx" ON "Runtime"("workspaceId", "archivedAt");
CREATE INDEX "Runtime_ownerId_idx" ON "Runtime"("ownerId");
ALTER TABLE "Runtime" ADD CONSTRAINT "Runtime_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Runtime" ADD CONSTRAINT "Runtime_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Agent.runtimeId
ALTER TABLE "Agent" ADD COLUMN "runtimeId" TEXT;
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_runtimeId_fkey"
  FOREIGN KEY ("runtimeId") REFERENCES "Runtime"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Agent_runtimeId_idx" ON "Agent"("runtimeId");

-- Backfill: every existing agent with a webhookUrl gets a REMOTE_HTTP
-- runtime that wraps it. Reuse the agent name; reuse the webhookSecret.
-- Run as a single statement so a fresh deploy is cheap.
INSERT INTO "Runtime" (id, "workspaceId", name, kind, endpoint, secret,
                       "providersAvailable", "heartbeatAt", "ownerId",
                       "createdAt", "updatedAt")
SELECT
  'rt_' || a.id,                       -- deterministic id derived from agent
  a."workspaceId",
  a.name || ' (legacy webhook)',
  'REMOTE_HTTP',
  a."webhookUrl",
  a."webhookSecret",
  ARRAY[a.provider]::"AgentProvider"[],
  a."lastHeartbeatAt",
  NULL,                                 -- no owner attribution for legacy rows
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Agent" a
WHERE a."webhookUrl" IS NOT NULL;

UPDATE "Agent" a
SET "runtimeId" = 'rt_' || a.id
WHERE a."webhookUrl" IS NOT NULL;

-- AgentRun token columns
ALTER TABLE "AgentRun" ADD COLUMN "tokensIn" INTEGER;
ALTER TABLE "AgentRun" ADD COLUMN "tokensOut" INTEGER;
ALTER TABLE "AgentRun" ADD COLUMN "tokensCached" INTEGER;
ALTER TABLE "AgentRun" ADD COLUMN "costUsd" DECIMAL(10, 4);
```

Update `prisma/schema.prisma` to mirror these.

## Stream breakdown (5 streams, fan-out plan below)

### Stream A — Backend foundations (sequential, runs first)

**Owner:** one subagent.

**Files:**
- `prisma/schema.prisma` — add `RuntimeKind` enum, `Runtime` model,
  `Agent.runtimeId`, `AgentRun.tokensIn/Out/Cached/costUsd`.
- NEW: `prisma/migrations/0018_runtime_and_token_usage/migration.sql`
  — exactly the SQL above.
- NEW: `src/server/routers/runtime.ts` — tRPC router with:
  - `runtime.list()` — workspace runtimes.
  - `runtime.byId({ id })`.
  - `runtime.register({ name, kind, endpoint?, providersAvailable })`
    — creates a runtime; for LOCAL_DAEMON sets ownerId from the
    calling user. Returns `{ runtime, daemonToken? }` (daemonToken
    is the existing API key the user used to authenticate; we don't
    issue new ones).
  - `runtime.heartbeat({ id })` — bumps `heartbeatAt`. Used by
    daemon every 60s; mirrors `agent.heartbeat`.
  - `runtime.archive({ id })`.
  - `runtime.update({ id, name?, providersAvailable? })`.
- `src/server/routers/_app.ts` — register the new router.
- `src/server/services/mcp.ts` — add three MCP tools:
  - `runtimes.register` — wraps the tRPC mutation, reads
    workspace/owner from `ctx.apiKey`.
  - `runtimes.heartbeat` — bumps `heartbeatAt`.
  - `runs.recordUsage({ runId, tokensIn?, tokensOut?, tokensCached?,
    costUsd? })` — updates the AgentRun. Validates the calling key's
    `linkedAgentId` owns the run.
- `src/server/routers/agent.ts` — extend `agent.list` and `agent.byId`
  to include `runtime` (id, name, kind, heartbeatAt) so the UI can
  render runtime info inline.
- `src/server/routers/agent.ts` — add `agent.unifiedTimeline`
  (described in architecture above).

**Acceptance:**
- `pnpm typecheck` clean.
- `pnpm prisma migrate deploy` succeeds against dev DB; existing
  agents get a `legacy webhook` runtime; their `runtimeId` is set.
- `runtime.list` returns the backfilled rows.

### Stream B — Forge UI: runtimes + token surfaces (depends on A)

**Owner:** one subagent.

**Files:**
- NEW: `src/app/(app)/w/[slug]/settings/runtimes/page.tsx` — runtimes
  index. Card per runtime with kind badge, providers, last heartbeat,
  owner avatar, host count of agents. Actions: rename, archive, view
  details.
- NEW: `src/app/(app)/w/[slug]/settings/runtimes/[id]/page.tsx` —
  detail page with the agents on this runtime + a "How to connect a
  new daemon" pane that surfaces a copy-pasteable
  `forge login --workspace <slug>` block and the SSE channel id.
- `src/components/settings/settings-navbar.tsx` — add
  `{ href: w("/runtimes"), label: "Runtimes", Icon: Server }` to the
  Integrations group.
- `src/components/mission-control/agents-tab.tsx` — render runtime
  badge alongside the existing runtime-mode pill.
- `src/components/mission-control/run-row.tsx` — when ETA query
  resolves with usage data (after Stream E lands), show a small
  `42k tok` chip next to the elapsed time.
- `src/app/(app)/w/[slug]/agents/[profileKey]/page.tsx` — add a
  "Runtime" card to the existing dashboard showing
  runtime.{name,kind,heartbeatAt,providersAvailable}.

**Acceptance:**
- Runtimes page lists backfilled rows after `pnpm prisma migrate
  deploy`.
- Settings navbar shows Integrations → Runtimes link active when on
  the page.
- `pnpm typecheck` clean.

### Stream C — Unified agent activity timeline (parallel with A; reads existing tables only)

**Owner:** one subagent.

**Files:**
- The `agent.unifiedTimeline` query is added inside Stream A
  (because it lives next to the existing agent router). Stream C
  consumes it.
- NEW: `src/components/agents/agent-timeline.tsx` — timeline component.
  Renders a chronological list with type-discriminated rows. Includes
  a load-more cursor at the bottom. ~200 lines.
- `src/app/(app)/w/[slug]/agents/[profileKey]/page.tsx` — replace the
  existing "Recent activity" feed with `<AgentTimeline />`.
- `src/components/mission-control/run-timeline.tsx` — extend to
  optionally include surrounding comment + activity event rows when
  the operator expands a run row in MC's Live tab. Use the same
  `agent.unifiedTimeline` query but scoped to the run's time window.

**Acceptance:**
- Agent detail page shows interleaved comments + run events +
  activity events sorted by timestamp.
- Loading more pages works via cursor.
- `pnpm typecheck` clean.

### Stream D — `forge` CLI + local daemon (parallel with A; can stub to backend until A lands)

**Owner:** one subagent.

**Files:**
- NEW: `tools/forge-cli/package.json` — `name: "@axiom-labs/forge-cli",
  "type": "module", "bin": { "forge": "./dist/cli.js" }`. Deps:
  `commander`, `@trpc/client`, `eventsource`, `chalk`, the `@prisma/client`
  types if needed (or hand-rolled types). Avoid `pkg`/`nexe` for v1.
- NEW: `tools/forge-cli/tsconfig.json`.
- NEW: `tools/forge-cli/src/index.ts` — entry, top-level `commander`
  setup.
- NEW: `tools/forge-cli/src/auth.ts` — `~/.config/forge/auth.json`
  read/write with mode 600. Stores `{ url, token, workspaceSlug }`.
- NEW: `tools/forge-cli/src/login.ts` — `forge login` command.
  v1 simplification: takes URL + token via prompt or `--token` flag
  rather than full device-code OAuth. Validate by calling
  `auth.session.useQuery` (or any cheap workspaceProcedure) to
  confirm the token works.
- NEW: `tools/forge-cli/src/daemon.ts` — `forge daemon {start,stop,
  status}`.
  - On start: spawn a child process detached (or run foreground if
    `--fg`). The child:
    1. Detects `claude`, `codex`, `hermes`, `gemini`, `cursor-agent`
       on PATH (`which` shell calls).
    2. Calls MCP `runtimes.register` (creates or updates a runtime
       row keyed by hostname + ownerId).
    3. Opens `/api/realtime` SSE with `Authorization: Bearer
       <token>`. Filter client-side for events whose payload's
       `runtimeId` matches OR whose subjectId is an agent on this
       runtime.
    4. Sends MCP `runtimes.heartbeat` every 60s.
  - PID file at `~/.config/forge/daemon.pid` so `status`/`stop` work.
- NEW: `tools/forge-cli/src/dispatch/claude-code.ts` — adapter for
  `claude` CLI. Takes a chat thread context, spawns claude CLI with
  appropriate flags, parses stream output, calls Forge MCP
  `chat.startDraft`/`appendDraftChunk`/`finalizeDraft`.
- NEW: `tools/forge-cli/src/dispatch/index.ts` — provider switch.
- NEW: `tools/forge-cli/src/commands/{whoami,issues,agents,runtimes}.ts`
  — read-only commands.
- NEW: `tools/forge-cli/README.md` — install + first-run.
- `package.json` (root) — add `"forge": "node tools/forge-cli/dist/cli.js"`
  script for in-repo dev use, and `"build:cli": "tsc -p tools/forge-cli"`.

**Acceptance:**
- `pnpm build:cli` produces `tools/forge-cli/dist/cli.js`.
- `pnpm forge whoami` prints the authenticated user (after `forge
  login`).
- `pnpm forge daemon start --fg` registers a runtime row in the dev
  DB, sends heartbeats, and prints SSE event arrivals to stdout.
- Sending a chat message to an agent on the local runtime via the web
  UI causes Claude Code to spawn (if installed) and stream a reply
  back through the chat draft tools — visible in the chat thread.
- If `claude` isn't on PATH, the daemon posts a friendly fallback
  message instead of crashing.

### Stream E — Token usage surfacing in UI (depends on A and B)

Folded into Stream B's run row + agent detail card, called out
separately so subagents understand the dependency. The actual surfacing
work is small (~3 small render additions) once `tokensIn` / `tokensOut`
are in the agent.list / agentRun.activeAll responses.

## Sequencing / parallelism

Round 1 (parallel — schema MUST land first):
- **A** (backend foundations) — runs first. Subagent posts a "schema
  shipped" signal when migration applies cleanly.

Round 1 (parallel with A, since they only read existing tables):
- **C** (unified timeline) — backend query + UI component. The query
  is added in A's file (`agent.ts`); C provides only the consuming
  UI. C can scaffold the component against a stubbed query shape and
  swap to the real hook once A lands.
- **D** (CLI + daemon) — can scaffold + write provider adapter + SSE
  subscription against the spec. Can't fully test until A's MCP
  tools land, but compile-time work proceeds.

Round 2 (after A):
- **B** (Forge UI: runtimes + token surfaces) — depends on
  `runtime.list` query and the agent select extension.
- **D** (CLI integration tests) — once A lands, daemon can register
  + heartbeat + receive events.

Round 3 (cleanup):
- Verify, lint, commit, deploy. Single subagent.

**Coordination notes:**
- Stream A owns `agent.ts` for the unifiedTimeline addition. Stream B
  also touches `agent.ts` (re: extending list/byId selects). Have
  Stream A finish first; Stream B re-reads the file before editing.
  Or: have A own all `agent.ts` edits and B just consume.
- Stream A and Stream D both touch MCP tools. Have A own the new MCP
  tools (`runtimes.register`, `runtimes.heartbeat`,
  `runs.recordUsage`); D consumes them.

## Acceptance criteria (overall)

After all streams converge:

1. `pnpm typecheck && pnpm lint` clean (only pre-existing warnings).
2. `pnpm prisma migrate deploy` applies 0018 cleanly; existing
   agents have a `legacy webhook` runtime backfilled.
3. `/settings/runtimes` lists at least the legacy backfill rows.
4. `/agents/<profileKey>` shows the unified timeline (interleaved
   comments + run events + activity events) with a load-more cursor
   that works.
5. `pnpm forge whoami` and `pnpm forge daemon start --fg` work
   end-to-end against the dev server.
6. With Claude Code installed locally, sending a chat message to an
   agent assigned to the local runtime triggers a Claude Code
   spawn, streams a reply back via the chat draft tools, and the
   reply renders progressively in the chat UI.
7. `runs.recordUsage` writes token columns; the agent detail page +
   MC RunRow render token chips when present.
8. Mission Control Live tab still works for Hermes-routed runs
   (REMOTE_HTTP path unchanged).

## Out of scope (explicit follow-ups)

- OAuth device-code flow for `forge login` — v1 takes URL + token via
  prompt/flag.
- Compiled binary for the CLI (`pkg`/`nexe`/`bun build --compile`).
- Provider adapters beyond Claude Code (Codex, Gemini, Cursor Agent
  follow the same pattern but each has its own stream-output flag
  shape).
- Cost-source-of-truth: rates per model. v1 takes `costUsd` from
  the agent verbatim; we'll move to a server-side table later.
- Per-runtime token budget caps and alerts.
- Skills library Forge-side surface (deliberately deferred).

## Dependencies / prerequisites for the run

- The Forge dev DB is reachable at `forge-postgres` (already true).
- Hermes daemon is running and the existing forge-presence cron is
  installed (already true). The old REMOTE_HTTP path keeps working
  through the migration.
- For Stream D end-to-end testing: `claude` CLI installed on the
  host. If not installed, the daemon can still register + heartbeat;
  the spawn path will hit the "fallback offline" branch.

## What NOT to do during the run

- Do NOT drop `Agent.webhookUrl` / `webhookSecret` columns. Keep them
  as legacy/source-of-truth for REMOTE_HTTP runtimes; the cleanup is
  a future migration once everything is on the Runtime model.
- Do NOT touch the existing chat streaming MCP tools (`chat.*`) —
  those are stable. The CLI / daemon CONSUME them, not modify.
- Do NOT touch Hermes-side files (`~/.hermes/...`). The Hermes
  integration keeps working through the legacy REMOTE_HTTP runtime
  row; no Hermes changes needed for this round.
- Do NOT bundle the CLI as a binary — that's a packaging follow-up.

## Suggested run procedure

1. Read `~/forge/CLAUDE.md` and `~/forge/DEVLOG.md` for context.
2. Read this PLAN.md end-to-end.
3. Dispatch Stream A. Wait for "schema shipped" signal (migration
   applied cleanly + typecheck clean).
4. Dispatch Streams B, C, D in parallel after A signals done.
5. Stream E folds into B's commits.
6. Run combined typecheck + lint + smoke tests.
7. Commit each stream as a single logical commit. Push.
8. Rebuild + redeploy Forge container.
9. Update `DEVLOG.md` with a session entry. Update CLAUDE.md if any
   primitives changed (Runtime added).
10. Update VitePress docs (`docs/agents/runtimes.md` new,
    `docs/reference/mcp.md` for new tools, `docs/reference/trpc.md`
    for the runtime router).

Total estimated time: 3–5 hours with an agent team running in parallel.

---

**Plan author:** prior session (Claude Opus 4.7, 1M context).
Hand-off: see top of file.
