# Forge — Claude Code Context

> Read before working on this repo. Project-specific; inherits from `~/CLAUDE.md`.

## What Forge is

A Linear-style project management platform. Fast, minimalist, keyboard-driven.
Extensible via a plugin/skill/MCP system. Built for humans and agents equally.

## Stack

Next.js 15 · TypeScript · Prisma 6 / Postgres · tRPC 11 / Zod · NextAuth v5 ·
Redis (pub/sub + rate limit + BullMQ) · Tailwind (warm-earthy tokens) ·
Vitest + Playwright.

## Where things live

| What                        | Where                                    |
|-----------------------------|------------------------------------------|
| DB schema                   | `prisma/schema.prisma`                   |
| tRPC routers                | `src/server/routers/`                    |
| Plugin runtime + MCP        | `src/server/services/`                   |
| API route handlers          | `src/app/api/`                           |
| App pages (RSC + client)    | `src/app/(app)/`                         |
| Design tokens               | `src/app/globals.css`, `tailwind.config.ts` |
| Sample plugin               | `plugins/issue-triage/`                  |
| DevLog                      | `DEVLOG.md` — update at session end      |

## Primitives

All tenant-scoped on `workspaceId`.

- **Workspace** — tenant. Short `key` (e.g. `AXI`, `PER`, `WRK`) is the
  issue-id prefix (`AXI-42`) and is **immutable after create** — changing
  it means a data migration (see Phase 1 of 2026-04-20 in `DEVLOG.md`
  for the pattern). Slug/name can change freely.
- **Project** — groups issues. Optionally belongs to an Initiative.
- **Issue** — the unit of work. Optional `projectId`, optional `cycleId`.
- **Cycle** — time-boxed iteration (default length from
  `Workspace.cycleLengthDays`). Issues move in/out of cycles. **Surfaced as
  "Sprint" in the UI** (since 2026-04-24); the data model, tRPC router
  (`cycle.*`), routes (`/cycles`), folder names, and MCP namespace
  (`cycles.*`) all stay `cycle*`. Only display strings were renamed. If
  you need to rename Cycle in copy you've added, write "Sprint" in the UI.
- **Initiative** — higher-level bucket above projects (quarterly bets,
  themes). Projects nest under initiatives via nullable `initiativeId`.
- **IssueRelation** — directed, typed link between issues
  (blocks / duplicates / related / …). Cascade-deleted from either end.
- **TimeEntry** — per-user duration rows against issues. Only active when
  `Workspace.timeTrackingEnabled`.
- **Attachment** — polymorphic via `targetType` + `targetId`. Can hang
  off any entity (issue/comment/project/initiative/…). Backed by MinIO.
- **Agent** — first-class non-human actor. `profileKey` is the stable
  cross-system handle (e.g. `victor`, `mizu`) and matches the Hermes
  profile directory name. Has `capabilities[]`, `webhookUrl` +
  `webhookSecret` for push dispatch, `status` (ONLINE/OFFLINE/BUSY),
  `lastHeartbeatAt`, `maxConcurrent`, `runtimeMode` (PERSISTENT |
  EPHEMERAL), `provider` (HERMES | CLAUDE | CODEX | CUSTOM), optional
  `runtimeId` pointing at the host **Runtime**. Issues point at an
  assigned agent via `assignedAgentId` (independent of the human
  `claimedById`). ApiKeys can point at an agent via `linkedAgentId` —
  so `issues.assigned` can infer "my work" without the caller passing
  `profileKey`.
- **Runtime** — the compute environment that hosts one or more agents
  (added 2026-04-28, migration 0018). Distinct from `Agent.runtimeMode`
  (which describes the agent's presence model). `kind` is
  `LOCAL_DAEMON | REMOTE_HTTP | CLOUD`. `LOCAL_DAEMON` rows are
  registered by the `forge` CLI's daemon via MCP `runtimes.register`;
  `REMOTE_HTTP` wraps a webhook endpoint (Hermes-style). `heartbeatAt`
  is bumped by the runtime itself (`runtimes.heartbeat` every 60s).
  Existing webhook-bearing agents got a backfilled "(legacy webhook)"
  REMOTE_HTTP runtime; `Agent.webhookUrl` / `webhookSecret` stay as
  the source of truth for those rows until a future cleanup migration
  makes Runtime authoritative.
- **AgentRun** — execution record for an agent on an issue. Tracks
  `currentStep`, status, and (since 2026-04-28) optional token usage
  columns: `tokensIn`, `tokensOut`, `tokensCached`, `costUsd`. Agents
  call `runs.recordUsage` once per finished step or at run completion;
  the call is idempotent (replace, not add). Mission Control's RunRow
  surfaces token counts as an `Xk tok` chip when populated.
- **ChatThread / ChatMessage** — per-(workspace, user, agent)
  persistent chat surface. ChatMessages have `role` (USER | AGENT |
  SYSTEM) and an optional `contextSnapshot` (route, slug, issueId,
  pinnedRunIds, liveRunIds at send time). The Mission Control Chat
  tab (chord 5) is the only consumer. See "Agent chat" below.

## Auto-dispatch

`Workspace.autoDispatch` + `autoDispatchMode` drive automatic agent
selection when an issue hits the queue unassigned. Modes:
- `MANUAL_ONLY` — dispatcher is a no-op; assignment is human-only.
- `ROUND_ROBIN` — pick the least-recently-dispatched eligible agent.
- `PRIORITY_MATCH` — prefer agents whose `capabilities` contain the
  lowercase priority name (`urgent`, `high`, …); round-robin tie-break.
- `CAPABILITY_MATCH` — intersect the issue's label names with agent
  capabilities; most matches wins; round-robin tie-break; zero-match
  falls through to round-robin rather than stalling dispatch.
`maxConcurrent` caps active assignments per agent (0 = unlimited).
`requireApprovalBeforeStart` gates push until a human approves.
`autoStartOnAssign` determines whether AGENT_ASSIGNED fires a webhook on
assignment (vs just filling the agent's queue).

## Configurability

Bailey's system-wide value: **prefer settings-driven values over
hardcoded defaults.** Every workspace-level knob should surface as a
column on `Workspace` (or a row in a settings table) — no magic numbers
baked into handlers. Current knobs: `cycleLengthDays` (7),
`cycleCooldownDays` (0), `timeTrackingEnabled` (false),
`attachmentQuotaMb` (1024).

## Granular ApiKey scopes

`ApiKey` has the usual coarse `PluginScope[]` ceiling *plus* three
narrowing arrays: `projectIds`, `labelIds`, `initiativeIds`, plus an
optional `linkedAgentId` pointing at the `Agent` row the key belongs
to. Empty arrays = unrestricted within the declared scopes. Non-empty =
key only sees/acts on rows matching those ids. Currently Victor and
Mizu hold FULL scope and no narrowing; future sub-agents should be
narrowed where possible (e.g., a per-initiative bot gets only that
`initiativeId`). Set `linkedAgentId` on the key so `issues.assigned`
can infer the agent without the caller supplying `profileKey`.

`ApiKey.kind` (added 2026-04-27) splits keys by intent:
- **AGENT** — linked via `linkedAgentId`, permanent until revoked.
  Used by Hermes/runtime daemons.
- **PERSONAL** — no agent link, permanent until revoked. For local
  Claude Code, scripts, human personal access.
- **SESSION** — TTL-bounded via `expiresAt`. Auto-purged when
  expired. Created via `access.createSession({ ttlHours })`. For
  ephemeral Claude Code sessions, one-off integrations.

## Agent chat

Per-(user, agent) chat threads accessible from Mission Control's
Chat tab (chord 5). The send/reply path:

1. Operator sends → `chat.send` mutation persists `ChatMessage` (role:
   USER, includes `contextSnapshot`) and emits `CHAT_MESSAGE_POSTED`
   (subjectType `chat-thread`).
2. `audit.ts` fan-out branch (d) routes the event to the addressed
   agent's `webhookUrl` via the per-agent dispatch shim — same
   plumbing as comment @-mentions.
3. The agent processes and replies via one of two MCP paths:
   - **Single-shot:** `chat.appendMessage({ threadId, body })` — full
     body in one call. Use when streaming isn't wired up.
   - **Streaming:** `chat.startDraft({ threadId }) → { draftId }`,
     then N × `chat.appendDraftChunk({ threadId, draftId, delta })`,
     then `chat.finalizeDraft({ threadId, draftId, body })`. The
     interim chunks publish on the `chat-thread-stream` Redis
     channel (subjectType `chat-thread-stream`, payload.phase =
     started | delta | finalized). Client renders progressive
     deltas. Final body is persisted via the same flow as
     single-shot, with `finalizedDraftId` in the payload so the
     client swaps the draft bubble for the persisted message
     without flicker.

Slash commands in the composer (`src/lib/chat-slash-commands.ts`) are
client-only: `/help`, `/clear`, `/info`, `/agents`, `/issue <KEY>`,
`/status`. Local commands push a SYSTEM-role bubble to a transient
`localMessages` array (cosmetic only, never persisted); prompt-dispatch
commands transform input and call `sendM.mutate`.

## Integrations / runtime adapters

Static manifest at `src/server/integrations/adapters.ts` (NOT a Prisma
table) keyed off the existing `AgentProvider` enum: HERMES, CLAUDE
(twice — Code session and Desktop persistent), CODEX, CUSTOM. Each
declares `defaultRuntimeMode`, `defaultKeyKind`, `presence` (daemon |
session | remote-webhook), `setupMarkdown`, optional `mcpSnippet`.
Powers `/settings/integrations` index page.

The Hermes integration has a runtime-side companion skill at
`~/.hermes/skills/forge-presence/` that calls Forge's MCP
`agents.heartbeat` every minute via system cron. The new Forge
platform adapter (also in `~/.hermes/hermes-agent/gateway/platforms/
forge.py`, in Bailey's fork of NousResearch/hermes-agent) handles
chat reply streaming via `chat.startDraft / appendDraftChunk /
finalizeDraft`. Note: the platform adapter required a few core
patches to Hermes (`Platform.FORGE` enum addition, `run.py` adapter
creation, a `webhook.py` re-stamp block); these are clean inside our
fork but are NOT yet upstream-mergeable.

## `forge` CLI + local daemon

`tools/forge-cli/` (own `package.json`, listed in `pnpm-workspace.yaml`
which is gitignored — `pnpm install` from root populates both) ships a
TypeScript ESM CLI:

- `forge login --url --workspace --token` — writes
  `~/.config/forge/auth.json` (mode 600). No OAuth device-code yet.
- `forge whoami` — auth + linked agent + local runtime registration.
- `forge daemon start [--fg] | stop | status` — auto-detects
  `claude/codex/hermes/gemini/cursor-agent` on PATH, registers a
  `LOCAL_DAEMON` Runtime via MCP `runtimes.register` (or restores a
  cached id from `~/.config/forge/daemon.json`), opens
  `/api/plugins/events` SSE, dispatches `CHAT_MESSAGE_POSTED` events
  to `dispatch/claude-code.ts` (the only real adapter at v1), and
  heartbeats every 60s.
- `forge runtimes / agents / issues` — read-only, plus
  `forge issue assign <key> <agent>`. The `runtimes` and `agents`
  list commands fall back to local-only views since `runtimes.list`
  / `agents.list` MCP tools aren't shipped.

Build with `pnpm build:cli`. Run with `pnpm forge ...`. SSE endpoint is
`/api/plugins/events` (NOT `/api/realtime` — that's session-cookie auth).
MCP endpoint is `/api/mcp/rpc`.

Claude adapter spawn:
`claude --print --input-format stream-json --output-format stream-json
--include-partial-messages --verbose --permission-mode bypassPermissions
--append-system-prompt <chat-mode prompt>`. Override binary path with
`FORGE_CLAUDE_BIN`. Missing binary → `[OFFLINE]` reply via
`chat.finalizeDraft`, no crash.

Known v1 gaps: chat dispatch sees only `{threadId, messageId, agentId,
role}` from SSE; there's no `chat.getThread` MCP yet, so the prompt to
the local CLI is a placeholder. AGENT_ASSIGNED handler stubs a
placeholder comment.

## Attachments

Polymorphic via `targetType` + `targetId`. Two kinds: **FILE** (bytes
in MinIO) and **LINK** (external URL — Google Doc, GitHub PR, web
page). Always pick the right kind:

- **Bytes → `attachments.initUpload`** (3-step):
  1. `attachments.initUpload({ targetType, targetId, filename, mimeType, size })`
     → `{ uploadUrl, attachmentId }`.
  2. `PUT` the bytes to `uploadUrl` with header `Content-Type: <mimeType>`.
  3. `attachments.finalize({ attachmentId })` flips the row ready and
     emits `ISSUE_UPDATED`.
- **External URL → `attachments.attachLink({ targetType, targetId, url, title? })`**
  in one call. No upload, no MinIO object. `mimeType` becomes
  `"text/url"`; `externalUrl` is the canonical pointer; `linkTitle`
  defaults to the URL hostname.

Allowed `targetType`: `issue`, `comment`, `project`, `initiative`,
`cycle`, `chat-message`.

Allowed FILE MIME types (rejected at `initUpload` if not in this list):
`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/svg+xml`,
`application/pdf`, `text/plain`, `text/markdown`, `text/html`,
`text/csv`, `text/xml`, `application/xml`, `application/json`,
`application/x-yaml`, `text/yaml`, `application/msword`,
`application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
`application/vnd.ms-excel`,
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
`audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/webm`, `video/mp4`,
`video/webm`, `video/quicktime`, `application/zip`. **Don't** rename
files to `.html.txt` etc. to bypass the list — `text/html` is
allowed natively. The server defensively strips `.txt` workaround
suffixes anyway.

Reading: `attachments.list({ targetType, targetId })` returns FILE +
LINK rows together. For FILE bytes inline (base64) use
`attachments.getInline` (image/pdf/text family — html/csv/xml/json
included; max 25 MB per call, default 1 MB). For everything else,
`attachments.getDownloadUrl` returns a 15-minute presigned GET.
LINK rows: read `externalUrl` directly from the `attachments.list`
response.

Size cap: **25 MB** per upload.

## Conventions

- **Every tenant-scoped row** includes `workspaceId`. Access gated by
  `workspaceProcedure` / `adminProcedure` in `src/server/trpc.ts`.
- **Write audit + event together.** Use `recordChange()` from
  `src/server/audit.ts` — it creates an `AuditLog` and `ActivityEvent` in
  the same transaction and publishes to Redis for SSE fan-out.
- **Scope-gated plugin access.** Manifest `scopes` is the ceiling for any
  API key issued. Enforce in `api-key-auth.ts`.
- **No mocks in integration tests.** Use the Postgres + Redis service
  containers from `docker/docker-compose.yml`.
- **Keep client components small.** Data comes from tRPC queries; RSC is
  used for session resolution and the shell layouts.

## Design style

Nothing-inspired minimalism + Anthropic warm earthy. Tokens in
`globals.css` — do not hardcode colors. Prefer `bg-card/40` and
`text-muted-foreground` over ad-hoc tailwind classes. Mono for identifiers
(issue IDs, keys), sans for everything else.

### Density-aware text utilities

Per-user **Appearance** prefs (`User.density`, `User.textSize`) cascade
onto `<html data-density="…" data-textsize="…">` via `AppearanceProvider`.
Use these utility classes from `globals.css` instead of hardcoded
`text-[10px]`/`text-[11px]` when you're rendering primary content (the
ones the Appearance setting should actually move):

- `.text-id` — issue IDs / keys / mono identifiers (includes `font-mono`)
- `.text-meta` — timestamps, secondary metadata (sans)
- `.text-filename` — filename overlays on attachment thumbs
- `.text-subtitle` — topbar subtitles

Leave true labels (badges, kbd hints, count bubbles, uppercase eyebrows)
hardcoded — those should stay small regardless of Appearance.

## What NOT to do

- No pure white or pure black — always warm paper or graphite (see tokens).
- No blocking pub/sub on mutation path. Publish is best-effort; durability
  is in `WebhookDelivery` rows, processed by `src/server/worker.ts`.
- No global `PrismaClient` re-instantiation in dev (already guarded; don't
  add bypass).
- No giant feature commits — DEVLOG each session, then commit.

## Before shipping

1. `pnpm lint && pnpm typecheck && pnpm test`
2. `pnpm test:e2e` (needs Postgres + Redis)
3. Append to `DEVLOG.md`
4. Commit; optional push.
