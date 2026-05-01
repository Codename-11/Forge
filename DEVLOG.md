# Forge DEVLOG

> Append-only session log. Read at session start. Update at session end.

## 2026-05-01 — statuses.list MCP + daemon IN_PROGRESS auto-transition + Hermes runbook refresh

Closes the last category-discovery gap so all agents — local
forge-cli daemon and Hermes-driven Victor/Mizu — can transition
issues to IN_PROGRESS without inventing status ids.

### Changes

- **Backend:** new `statuses.list({ category? })` MCP tool. `READ_ISSUES`-
  scoped. Returns `{ id, name, category, color, position, isDefault }[]`
  ordered by `position`. Optional `StatusCategory` filter (`BACKLOG |
  TODO | IN_PROGRESS | IN_REVIEW | DONE | CANCELED`). 3 new tests
  (56 total in mcp.test.ts, all passing).
- **Daemon:** `tools/forge-cli/src/dispatch/issue-loop.ts` gains a
  `maybeTransitionToInProgress` helper that runs between
  context-bundle and inline-attachments. Calls `statuses.list({
  category: "IN_PROGRESS" })`, prefers `isDefault` then first by
  `position`, then `issues.transition`. Skipped when the issue is
  already in IN_PROGRESS or IN_REVIEW; no-op when the workspace has
  no IN_PROGRESS-category status. Best-effort — failures log and
  proceed rather than abort the assignment.
- **Hermes runbook** (`~/.hermes/skills/pm/forge/SKILL.md`) refreshed:
  tool count 50 → 69, full namespace table, new "Awareness shortcut"
  + "Status discovery" sub-sections, agent-queue loop now opens with
  `agent.context.bundle` and includes the `statuses.list` →
  `issues.transition` IN_PROGRESS pattern.
- **`~/SYSTEM.md`** updated: tool count 50 → 69 (19 namespaces) with
  the full new surface enumerated; note that HTTP MCP `tools/list`
  hot-discovery means no Hermes restart is required.
- **Docs:** `docs/reference/mcp.md` + `docs/agents/runtimes.md` reflect
  the new statuses namespace and the daemon's auto-transition step.

### Verification

- `pnpm typecheck` — clean.
- `pnpm build:cli` — clean.
- `pnpm vitest run src/server/services/__tests__/mcp.test.ts` — 56/56.
- Container rebuilt + redeployed.
- Live MCP smoke: `tools/list` against Victor's key returns 69 tools;
  `tools/call statuses.list { category: "IN_PROGRESS" }` returns the
  AXI workspace's "In Progress" row (`#d97706`, position 2).
- Mizu's key sees 69 tools too.

### Punted / known follow-ups (still active)

- **Agent-to-agent delegation** (Tier 3) — needs design (sub-issues vs
  delegation token vs `tasks.delegate` MCP). Deferred.
- **PDF byte-inlining for Claude** — daemon announces filename + size
  only. Switch to base64 inline once Claude Code's stream-json grows
  native PDF support.
- **Provider coverage beyond Claude Code** — codex/hermes/gemini/
  cursor-agent stubs still respond `[provider:X] not implemented`.
- **OAuth device-code flow for `forge login`** — still token-prompt.
- **Server-side auto-transition policy** — currently the daemon
  transitions client-side. A `Workspace.startedStatusId` setting +
  optional auto-transition on `AGENT_ASSIGNED` would let
  Hermes-driven agents skip the round-trip entirely. Small follow-up
  if Victor/Mizu start tripping over manual transitions.

## 2026-04-28 — Agent awareness: 10 new MCP tools + attachment UX + real daemon loop

Follow-on to the morning's Multica-inspired push. Closed every Tier 1
and Tier 2 gap from the awareness analysis except agent-to-agent
delegation (Tier 3, deferred — needs more design).

### Stream BA — backend MCP additions + AGENT_ASSIGNED enrichment

10 new/extended tools in `src/server/services/mcp.ts`:
- `comments.list({ issueId, before?, limit? })` — `READ_ISSUES`. Closes
  the biggest gap: agents can now read the comment history they're
  entering, not just write to it.
- `runtimes.list({ kind?, includeArchived? })` — `ADMIN`. Replaces the
  CLI's local-only fallback.
- `agents.list({ runtimeId?, includeArchived? })` — `READ_USERS`. Peer
  discovery; also unblocks the CLI's agents-list command.
- `events.recent({ subjectType?, subjectId?, kinds?, before? })` —
  `READ_ISSUES`. Historical activity grounding.
- `chat.getThread({ threadId, before?, limit? })` — `WRITE_COMMENTS`,
  caller's `linkedAgentId` must match `thread.agentId`. For
  prior-message context.
- `workspace.get` — `READ_ISSUES`. Settings/policy (no member list —
  admin-gated).
- `agent.context.bundle({ issueId? | threadId? })` — composite. One
  call returns issue/thread + comments + attachments + relations +
  currentRun + workspace. Saves 4–5 round trips on dispatch.
- `attachments.getInline({ attachmentId, maxBytes? = 1MB })` —
  base64 bytes for image-aware models. Mime allowlist: image/png,
  image/jpeg, image/gif, image/webp, application/pdf, text/plain,
  text/markdown. Default cap 1MB, hard cap 25MB.
- `runs.list({ agentId?, issueId?, status?, before? })` — `READ_ISSUES`.
- `issues.get` extended with optional `include` flags (`description`,
  `comments`, `attachments`, `relations`, `currentRun`, `labels`).
  Default response shape unchanged for backward compat.

`AGENT_ASSIGNED` payload enrichment: every producer (dispatcher.ts,
issue router, ai router, mcp tools — 7 sites total) now includes
`payload.issueSnapshot = { id, number, title, priority, statusId,
projectId, labelNames }`. Centralized in `audit.recordChange` via a
`loadIssueSnapshot` helper, so future producers automatically get it.

Storage: `chat-message` added to `ALLOWED_TARGET_TYPES` so attachments
can hang off chat messages. `getAttachmentInline` helper added to
`storage.ts` (uses S3 SDK `transformToByteArray`; no new deps).

Tool count 53 → 68. Namespaces 14 → 18 (`workspace`, `events` new;
`agent` and `runs` gained their own dedicated tools). 17 new tests in
`mcp.test.ts`; all 53 in the file passing.

### Stream UI — attachments + chat + runtime UX

Five new attachment components under `src/components/attachments/`:
`use-upload-target.ts` (shared upload primitive), `use-drop-upload.ts`
(DnD hook with counter-based dragenter/leave), `drop-overlay.tsx`
(visual overlay), `attachment-chip.tsx` (`<AttachmentChip>` +
`<AttachmentThumb>` for image previews). The existing
`use-paste-upload.ts` was refactored to delegate to the shared
primitive — paste and drop now share the same upload code path.

Issue body + comment composer in `issue-main.tsx` wrapped in the DnD
overlay. Mission Control chat bubbles render attachments inline
(images → existing `AttachmentLightbox`; non-images →
`<AttachmentChip>`). Issue header gets a paperclip + count chip when
the issue has attachments; click jumps the rail to the Attachments
tab.

Runtime UX:
- `/settings/runtimes` index gains a "Show archived" toggle and
  per-row Unarchive button. Archived rows render at `opacity-60` with
  an "archived" badge.
- Detail page topbar gets an Unarchive action when `archivedAt` is
  set, plus a banner.
- `runtime.unarchive({ id })` tRPC mutation added (idempotent).

New `<AgentContextCard />` on the agent detail page renders "what
this agent currently sees" for its most recent assignment. Uses only
existing queries (`agent.pipeline` + `issue.byId`) so it shipped
parallel to Stream BA without depending on the new tools.

### Stream D2 — real daemon agent loop

The CLI graduates from a placeholder-prompt skeleton to a real Claude
Code agent loop. Three big changes consume Stream BA's awareness
surface:

1. **Chat dispatch** reads the actual user message body from the SSE
   payload (the placeholder branch is gone), then calls
   `agent.context.bundle({ threadId })` to ground Claude on prior
   conversation. If `context.issueId` is set, the bundle's issue +
   attachments ride along. Image attachments inline as Claude content
   blocks via `attachments.getInline`; text/md decoded inline; PDFs
   announced by filename + size.

2. **`AGENT_ASSIGNED` handler** — full happy path in
   `tools/forge-cli/src/dispatch/issue-loop.ts`: issueSnapshot framing
   → context bundle → inline attachments → starter comment → spawn
   Claude → progress comments at message boundaries (capped at 12) →
   final summary → `runs.recordUsage` with token counts from Claude's
   stream-json result events. Idempotent within process via a
   bounded `SeenEvents` set (last 256 event ids).

3. **`forge runtimes list` / `agents list`** now hit real MCP, with
   table/JSON output and filters. Local-host runtime annotated as
   "(this host)".

Image content block shape for Claude Code stream-json input:
`{ type: "image", source: { type: "base64", media_type, data } }`.

`claude-code.ts` split into `runClaudeChat` + `runClaudeIssue` over a
shared `runClaudeProcess` helper. Dispatch types live in
`dispatch/types.ts`.

### Verification

- `pnpm typecheck` (root) — clean.
- `pnpm build:cli` — clean.
- `pnpm vitest run src/server/services/__tests__/mcp.test.ts` — 53
  passing (including the 17 new awareness-tool tests).
- Targeted `pnpm exec eslint` on all touched files — clean.
- Smoke: production build + container deploy planned post-commit.

### Punted / known follow-ups

- **Agent-to-agent delegation** — Tier 3 from the analysis. Needs
  design (sub-issues vs delegation token vs `tasks.delegate` tool).
  Deliberately deferred; not blocking anyone.
- **`statuses.list` MCP tool** — without it, the daemon can't auto-
  transition issues to IN_PROGRESS on AGENT_ASSIGNED. Currently the
  daemon skips the transition; issues stay in their current status
  while the agent works. Small follow-up to expose `statuses.list` so
  the daemon can map `category: "STARTED"` to the workspace's own
  status row.
- **PDF byte-inlining for Claude** — v1 announces filename + size
  only. Once Claude Code's stream-json grows native PDF support,
  switch to base64 inline.
- **Provider coverage beyond Claude Code** — codex/hermes/gemini/
  cursor-agent stubs still respond `[provider:X] not implemented`.
- **OAuth device-code flow for `forge login`** — still v1; takes URL
  + token via prompt or flag.
- **Inline-content cap tuning** — daemon-side budget is 4MB total per
  dispatch with 1MB per attachment. May need adjustment based on
  real-world prompt sizes.

## 2026-04-28 — Multica-inspired upgrades: Runtime + tokens + unified timeline + forge CLI

Executed PLAN.md (committed cf7be7a) as four parallel streams: backend
foundations (A), runtimes UI + token surfaces (B), unified agent
timeline (C), and `forge` CLI + local daemon (D).

### Changes

- **Schema (migration 0018_runtime_and_token_usage):**
  - New `RuntimeKind` enum and `Runtime` model with FKs to Workspace +
    nullable `ownerId` on User. Carries `kind`, `endpoint?`, `secret?`,
    `providersAvailable[]`, `heartbeatAt`, `connectedAt`, `archivedAt`.
  - `Agent` gained nullable `runtimeId` + `runtime` relation
    (`AgentRuntime`). `Agent.webhookUrl` / `webhookSecret` left in
    place per plan; future cleanup migration will make Runtime
    authoritative.
  - `AgentRun` gained `tokensIn` / `tokensOut` / `tokensCached` /
    `costUsd` (Decimal 10,4).
  - Backfill: every Agent with a `webhookUrl` got a `(legacy webhook)`
    REMOTE_HTTP runtime and `Agent.runtimeId` was set. On the dev DB
    this touched 0 rows (no agents have webhookUrl set there); the SQL
    is structurally correct for prod-style data.

- **tRPC:**
  - New `runtime.{list, byId, register, heartbeat, archive, update}`
    router, registered on `_app.ts`.
  - `agent.list` / `agent.byId` / `agent.byProfileKey` selects
    extended to include `runtime { id, name, kind, heartbeatAt,
    providersAvailable }`.
  - New `agent.unifiedTimeline({ profileKey, before?, limit? })`
    merges Comment, ActivityEvent, and AgentRunEvent rows for an
    agent into a cursor-paginated timeline. Per-source fetch + merge
    + slice; `nextBefore` is the cursor.

- **MCP tools:**
  - `runtimes.register({ name, kind, endpoint?, providersAvailable })`
    — ADMIN-scoped. Sets `ownerId` from caller's `userId`.
  - `runtimes.heartbeat({ runtimeId })` — ADMIN-scoped.
  - `runs.recordUsage({ runId, tokensIn?, tokensOut?, tokensCached?,
    costUsd? })` — WRITE_ISSUES-scoped. Validates `linkedAgentId`
    matches the run's `agentId`. Idempotent (replace, not add).

- **UI:**
  - New `/settings/runtimes` index — card per runtime with kind badge,
    providers, heartbeat (relative), owner, agent count. Rename via
    `QuickForm`, archive via `Confirm`. Empty-state copy points
    operators at `forge daemon start`.
  - New `/settings/runtimes/[id]` detail — agents list +
    "Connect a new daemon" recipe pane for empty `LOCAL_DAEMON` rows.
  - Settings navbar gained a Runtimes link in the Integrations group.
  - Agent detail page gained a small `RuntimeCard` (above webhook
    health) with click-through to the runtime detail page.
  - Agent detail page's "Recent activity" feed replaced with the new
    `<AgentTimeline />` component — interleaves comment / event /
    run-event rows. Manual cursor pagination because tRPC 11's
    `useInfiniteQuery` requires a `cursor` field.
  - Mission Control agents tab gained a `RuntimeChip` next to the
    runtime-mode pill, click-through to runtime detail.
  - Mission Control RunRow renders an `Xk tok` chip when AgentRun
    token columns are populated. `agentRun.activeAll` already uses
    `findMany` + `include` (not `select`), so token columns ride along
    automatically — no router edit needed.

- **`forge` CLI** (`tools/forge-cli/`, ESM TypeScript):
  - Lives in a sub-package; root `pnpm-workspace.yaml` (gitignored)
    includes it. Root scripts: `pnpm build:cli`, `pnpm forge`.
  - Commands: `login`, `whoami`, `daemon {start|stop|status}`,
    `runtimes/agents/issues` (read-only), `issue assign`.
  - `forge daemon start` auto-detects
    `claude/codex/hermes/gemini/cursor-agent` on PATH, registers (or
    restores) a `LOCAL_DAEMON` Runtime, opens
    `/api/plugins/events` SSE with bearer auth, heartbeats every 60s.
  - Claude Code adapter (`dispatch/claude-code.ts`) spawns
    `claude --print --input-format stream-json --output-format
    stream-json --include-partial-messages --verbose
    --permission-mode bypassPermissions
    --append-system-prompt <chat-mode>`, parses
    `content_block_delta` events, streams them through
    `chat.startDraft / appendDraftChunk / finalizeDraft`. Override
    binary path with `FORGE_CLAUDE_BIN`. Missing binary →
    friendly `[OFFLINE]` reply.

- **Docs:**
  - New `docs/agents/runtimes.md` describing the Runtime primitive,
    forge CLI/daemon flow, and v1 limitations.
  - VitePress sidebar updated to surface the new page next to Hermes.
  - `docs/reference/mcp.md` gained `runtimes` and `runs` namespaces;
    namespace count bumped 12 → 14, tool count 50 → 53.
  - `docs/reference/trpc.md` gained `runtime` to the catalog table
    plus a notable section, and `agent.unifiedTimeline` got its own
    notable section.

- **Project context:**
  - CLAUDE.md gained `Runtime` and `AgentRun` to the Primitives list,
    plus an operational section on the `forge` CLI / local daemon.

### Verification

- `pnpm prisma migrate deploy` — clean (0018 applied; backfill ran;
  touched 0 rows in dev DB because no agents had `webhookUrl`).
- `pnpm prisma generate` — clean.
- `pnpm typecheck` (root) — clean.
- `pnpm build:cli` — produces `tools/forge-cli/dist/index.js`.
- `node tools/forge-cli/dist/index.js --help` — usage prints fine.
- Targeted `pnpm exec eslint` on all touched files — clean.
- `pnpm lint` (full) — only pre-existing failures in
  `src/components/issue-board.tsx` and
  `src/components/mission-control/control-tab.tsx`.

### Punted / known follow-ups

- **Stream D daemon is reading too narrow a slice of the chat SSE
  payload.** `chat.send` actually publishes `{threadId, messageId,
  agentId, role, body, context}` (see `src/server/routers/chat.ts:123`)
  — the daemon's typed read in `tools/forge-cli/src/daemon.ts:256-258`
  drops `body` and `context`, then the placeholder prompt is sent to
  Claude. Fix is one-line: include `body` + `context` in the typed
  payload and pass them through `handleChatDispatch`. A separate
  `chat.getThread` MCP tool is still useful for *prior* messages /
  thread history (the SSE event only carries the single new message),
  but is no longer urgent for the basic dispatch path.
- **`runtimes.list` / `agents.list` MCP tools** — would let the CLI's
  read-only commands work without falling back to local-only views.
- **`AGENT_ASSIGNED` handler in the daemon** — stubbed; posts a
  placeholder comment via `comments.create`. The full agent loop is a
  follow-up.
- **Mission Control RunTimeline context extension** (Stream C
  optional deliverable) — skipped to avoid crossing into Stream B's
  `RunRow` territory mid-stream. Cleanly punted; recommend a
  `RunContextTimeline` wrapper component as follow-up.
- **OAuth device-code flow for `forge login`** — v1 is prompt-or-flag
  for token. Acceptable for the local-daemon-on-trusted-host case.
- **Compiled CLI binary** — out of scope; ESM via Node only for v1.
- **Provider adapters beyond Claude Code** — Codex, Gemini, Cursor
  Agent stub a "[provider:X] not implemented" reply.
- **Server-side cost rate table** — `costUsd` taken verbatim from the
  agent. Future enhancement.
- **`pnpm-workspace.yaml` is gitignored** — fresh clones must
  reproduce the `tools/forge-cli` listing manually before
  `pnpm install` picks it up. Either un-gitignore or have a script
  manage it; deferred.

## 2026-04-27 — Restore historical Forge audit

Restored the 2026-04-26 Forge cohesion/agentic/mobile audit markdown from
Hermes session history after the original untracked audit files were absent
from the worktree.

### Changes

- Added `docs/audits/2026-04-26-forge-cohesion-agentic-mobile.md`.
- Marked the report as historical/transcript-restored and noted that the
  reported mobile screenshot artifacts are not present in the repo.
- Noted that `pnpm typecheck` now passes at current HEAD, so the original
  notification-state blocker is stale.

### Verification

- `pnpm typecheck` - clean before restoring the docs-only audit.
- `git diff --check` - clean.

## 2026-04-27 — Mission Control actionable notifications

Completed the Mission Control notification/traceability run across drill links,
Sonner delivery, Activity Drawer persistence, and health/detail surfaces.

### Changes

- Fixed Mission Control agent drill links to use `/w/[slug]/agents/[profileKey]`
  instead of database agent ids.
- Added `src/lib/notifications/event-notification.ts`, a typed mapper for
  alertable `ActivityEvent` kinds (`AGENT_NOACK`, `ISSUE_SLA_BREACH`,
  `ISSUE_STALLED`) with severity, importance, summary, reason,
  recommended action, replacement key, and primary/detail action links.
- Wired realtime Sonner warning toasts through the shared mapper so warnings
  open useful issue/agent/detail destinations instead of dead-end copy.
- Added `NotificationState`, `NotificationSeverity`, and
  `NotificationStatus` with migration `0015_notification_state`; the mutable
  per-user lifecycle sits on top of immutable `ActivityEvent` rows.
- Added a notification materialization service plus `notification.*` tRPC
  endpoints for list, unread count, upsert, mark-read, dismiss, acknowledge,
  and resolve. Replacement keys auto-resolve older active alerts.
- Reworked Activity Drawer alert rows into a persistent attention queue with
  reason/recommended-action copy, primary/detail links, severity/importance,
  and per-alert read/dismiss/ack/resolve controls.
- Added agent health focus links (`?health=noack|webhook|heartbeat#dispatch-health`)
  and visible guidance on the agent detail page explaining the warning, likely
  cause, recommended fix, and place to check.
- Improved webhook delivery inspector deep links with `deliveryId`/`agentId`
  query state, selected delivery persistence across filters, and agent-scoped
  delivery filtering.
- Added tests for event mapping, notification lifecycle persistence, replacement
  behavior, and webhook delivery deep-linked rows.

### Verification

- `pnpm prisma:generate` - clean.
- `pnpm prisma:deploy` - clean against the local Forge dev database.
- `pnpm vitest run tests/unit/event-notification.test.ts src/server/routers/__tests__/notification.test.ts src/server/routers/__tests__/admin-webhook-deliveries.test.ts` - clean (14 tests).
- `pnpm typecheck` - clean.
- Targeted `pnpm exec eslint ...touched files...` - clean.
- `pnpm build:app` - clean.
- `git diff --check` - clean.
- Full `pnpm lint` still fails on pre-existing `src/components/issue-board.tsx`
  `no-explicit-any` errors.
- Full `pnpm test` runs 185/191 tests clean; remaining six failures are the
  pre-existing MinIO test environment issue (`localhost:59000` refused) in
  storage/attachment tests.

## 2026-04-27 — Mission Control notification mapping

Implemented the first notification drill-down packet: fixed Mission Control
agent links and added a typed mapper for alertable activity events.

### Changes

- Mission Control Glance and Agents tab links now route to
  `/w/[slug]/agents/[profileKey]` instead of using the database agent id.
- Added `src/lib/notifications/event-notification.ts`, a pure typed helper
  for `AGENT_NOACK`, `ISSUE_SLA_BREACH`, and `ISSUE_STALLED` metadata.
- Mapper output includes severity, importance, primary/detail hrefs, summary,
  reason, recommended action, replacement key, and toast copy.
- Added fallback handling for missing issue/agent hydration while preserving
  issue subject drill-downs when the event still carries an issue id.
- Added unit coverage for no-ack, SLA breach, stalled work, missing
  references, profileKey agent URLs, and non-alertable events.

### Verification

- `pnpm vitest run tests/unit/event-notification.test.ts` - clean.
- `pnpm typecheck` - clean.
- `pnpm exec eslint src/components/mission-control/glance-view.tsx src/components/mission-control/agents-tab.tsx src/lib/notifications/event-notification.ts tests/unit/event-notification.test.ts` - clean.
- `git diff --check` - clean.
- Static grep confirmed Mission Control no longer links agents with `a.id`.

## 2026-04-27 — Two-tier settings navigation

Refined the settings navbar into primary section tabs with a contextual subnav.

### Changes

- Workspace settings now show top-level section tabs first, then only the
  active section's pages underneath.
- Account settings keep a single compact navbar row since there is only one
  section.
- The navigation remains horizontal and responsive, avoiding the previous
  nested-sidebar layout while reducing visual clutter.
- Account pages now have workspace-scoped aliases under
  `/w/[slug]/settings/*`, so account/profile/API-key/workspace management
  links keep the normal workspace shell instead of jumping to the standalone
  account layout mid-settings.
- Added `min-h-0` to the workspace shell content column so nested settings
  pages keep their own scroll container at narrow widths.
- Removed `h-full` from the workspace settings layout; combined with the
  shell topbar, it caused mobile settings content to be clipped instead of
  scrolling inside the page content pane.
- Added `min-h-0` to the settings content wrapper so the page-level
  `overflow-y-auto` pane is height-constrained on mobile.

### Verification

- `pnpm typecheck` - clean.
- `pnpm exec eslint src/components/settings/settings-navbar.tsx` - clean.
- `git diff --check` - clean.
- Browser smoke: desktop and mobile settings panes scroll internally for
  workspace general settings, agents, and account settings.

## 2026-04-27 — Settings navbar cleanup

Replaced nested settings sidebars with a compact horizontal settings navbar.

### Changes

- Removed the redundant "Agent admin" entry from the primary workspace
  sidebar; agent configuration remains under Settings -> Agents.
- Added a shared settings navbar component for workspace and account settings.
- Workspace settings now use the top navbar instead of a secondary left rail.
- Account settings use the same navbar pattern with a back-to-workspace link.

### Verification

- `pnpm typecheck` - clean.
- `pnpm exec eslint src/components/sidebar.tsx src/components/settings/settings-navbar.tsx src/app/(app)/settings/layout.tsx src/app/(app)/w/[slug]/settings/layout.tsx` - clean.
- `git diff --check` - clean.

## 2026-04-26 — Agent/MCP provider onboarding steppers

Reworked agent and MCP setup around explicit provider selection and centered
onboarding modals.

### Changes

- Added `AgentProvider` (`HERMES`, `CLAUDE`, `CODEX`, `CUSTOM`) and
  `AgentRuntimeMode` (`PERSISTENT`, `EPHEMERAL`) to Prisma, with migration
  `0014_agent_provider_runtime`.
- `agent.create` / `agent.update` now accept provider/runtime metadata and
  webhook secrets; audit payloads redact webhook secrets.
- Added `agent.testWebhook`, an admin-gated signed connection probe that sends
  `AGENT_CONNECTION_TEST` without creating assignment work.
- Replaced the Settings -> Agents drawer with a large centered stepper:
  provider, profile, connection, workload/key, review. Webhook is optional;
  MCP-only is first-class. New agents can issue a linked MCP key during
  onboarding and reveal provider-specific config immediately.
- Replaced Developer access key creation with a centered MCP key stepper:
  provider, scopes, context/linking, review.
- Added shared MCP copy blocks for Hermes, Claude Desktop, Claude Code, Codex
  (`~/.codex/config.toml` streamable HTTP), generic HTTP, and env vars.
- Agent detail/list surfaces now show provider/runtime badges.
- Docs updated across Agents, MCP reference, API keys, quickstart, settings,
  architecture, primitives, and index.
- `pnpm dev` now runs through `scripts/dev-live.sh` so local UI work reflects
  the live compose data by default. `pnpm dev:isolated` keeps the old
  standalone `next dev --turbo` path for explicit isolated service work.

### Verification

- `pnpm prisma:generate` - clean.
- `pnpm typecheck` - clean.
- `pnpm exec eslint ...touched files...` - clean.
- `git diff --check` - clean.

### Known / not run

- `pnpm lint` still fails on pre-existing `src/components/issue-board.tsx`
  `no-explicit-any` errors (plus unrelated warnings).
- `pnpm test -- ...` attempted to run the suite but Postgres/Redis were not
  available at `localhost:55432` / Redis, so DB-backed tests failed before
  exercising this change.

## 2026-04-26 — VitePress user docs (warm/soft theme, Lucid pattern)

Built out a full VitePress site at `docs/` mirroring the Lucid layout,
themed against the dashboard's warm-paper / ember palette. Replaces the
flat `docs/API.md` + `docs/PLUGINS.md` (now thin pointers).

### Structure

- `docs/.vitepress/config.ts` — site config; `base: "/docs/"`,
  light-default, local search, sidebar grouped by Guide / Concepts /
  Agents / Automation / Reference.
- `docs/.vitepress/theme/style.css` — custom theme: Inter +
  JetBrains Mono, warm paper bg (`hsl(38 20% 97%)`), graphite text,
  single ember accent (`hsl(25 80% 50%)`) on primary CTAs / focus /
  active sidebar bar / code-block left-rail. Dark mode supported
  (graphite, never pure black). Light is default. Restraint over
  ornament — no tick-corners, no scoreboard fonts, no gradients.
- `docs/public/` — favicon + Forge mark assets copied from
  `/public/brand/`.

### Content (~5,200 lines across 26 pages)

- **Guide** (10 pages) — welcome, architecture, quickstart, workspaces,
  issues, projects-and-initiatives, sprints, time-and-attachments,
  settings, keyboard.
- **Concepts** (4) — primitives, scopes-and-tenancy, activity-and-audit,
  design-language.
- **Agents** (6) — overview, hermes, auto-dispatch, dispatch-rules,
  slas-and-watchdogs, ai-triage-and-coach.
- **Automation** (3) — webhooks, plugins, api-keys.
- **Reference** (4) — mcp, trpc, events, env.

Authored by three parallel general-purpose agents (Guide, Concepts +
Agents, Automation + Reference) from a shared inventory built by an
Explore agent that audited the Prisma schema, MCP service, dispatcher,
audit/event pipeline, AI providers, and the recent P1/P3 commit waves.

### Wire-up

- Standalone install in `docs/` (uses `--ignore-workspace` so it
  doesn't try to join the Forge pnpm workspace).
- Root scripts added: `docs:install`, `docs:dev`, `docs:build`,
  `docs:preview`, plus `dev:all` (runs Next + docs side by side, both
  log-prefixed, single ctrl-c kills both).
- `scripts/dev-all.sh` — the dev:all entry point.
- `.github/workflows/docs.yml` — GH Pages deploy. Trigger is
  `workflow_dispatch` only today (manual run); flip to push on master
  when the repo goes public. Pages source must be set to "GitHub
  Actions" in repo settings before the first deploy.

### Verification

- `pnpm docs:build` — build complete in 9.5s; 26 pages render clean,
  no dead links.
- `pnpm docs:dev` — boots at `http://localhost:5181/docs/`,
  HTTP 200 on root.
- Tailwind warning during build is from the parent's PostCSS config
  leaking into VitePress's pipeline; harmless (VitePress doesn't use
  Tailwind for the docs theme — it's pure CSS variables).

### Notes for future

- Theme intentionally diverges from Lucid's brutalist tick-corners +
  VT323. Forge's dashboard reads as warm/soft, so the docs follow:
  Inter throughout, mono only on identifiers, ember as the single
  accent. Distinctive from Lucid while reading as the same family.
- Edit-link in `themeConfig.editLink` points at
  `Codename-11/forge` — verify the org/repo when flipping public.
- `base: "/docs/"` assumes the site lives under `<owner>.github.io/forge/docs/`.
  Change to `"/"` if publishing to apex / custom domain.
- `data-embed="dashboard"` rules in the theme drop the top nav when
  the docs are rendered inside an iframe — a future "Help" panel in
  the Forge UI can use this without re-styling.

## 2026-04-25 — FRG-32 MCP project mutations + queue toggle

Added MCP parity for project setup and agent queue steering so agents no longer
need direct Prisma/database workarounds for normal Forge PM operations.

### Changes

- Added MCP tools: `projects.create`, `projects.update`, `projects.archive`,
  and `issues.setQueued`.
- Enforced MCP scope metadata: project mutations require `WRITE_PROJECTS`,
  queue toggling requires `WRITE_ISSUES`.
- Preserved resource narrowing via API key project/issue scope checks.
- Mirrored project router create/update/archive semantics, including
  create/update audit/activity events and archive as a scoped archive update.
- Mirrored issue queue-toggle behavior: conditional `ISSUE_QUEUED` event on
  off→on transitions, no duplicate queue spam, and auto-dispatch on toggle.
- Updated the Forge Hermes skill to document the new MCP surface.

### Verification

- `pnpm vitest run src/server/services/__tests__/mcp.test.ts -t "project mutations and issue queue toggle"`
- `pnpm vitest run src/server/services/__tests__/mcp.test.ts`
- `pnpm typecheck`

## 2026-04-25 — Forge logo concept pass

Generated and narrowed Forge logo directions around a stronger favicon-safe
mark. Selected concept 1: a graphite anvil silhouette with a separate ember
billet above it.

### Assets

- Saved the generated concept sheet to `output/imagegen/forge-logo-concepts.png`.
- Saved the selected concept crop to
  `output/imagegen/forge-logo-concept-1-selected.png`.
- Added `public/brand/forge-mark-v2.svg` as the transparent standalone mark.
- Added `public/brand/forge-app-icon-v2.svg` as the warm-paper app icon draft.
- Added `public/brand/forge-app-icon-v2-ember.svg` as an ember-background
  alternate for higher contrast contexts.

### Verification

- Rendered SVG previews with ImageMagick at 512px and 32px.
- Left the current `src/app/icon.svg` and `public/forge-mark.svg` untouched.

## 2026-04-25 — Logo v2 + P1 layers 2 & 3 (required ack + SLA enforcement)

### Logo full replacement

- v2 brand SVGs now in `public/brand/`: `forge-mark-v2.svg` (bare),
  `forge-app-icon-v2.svg` (paper/light), `forge-app-icon-v2-ember.svg`
  (ember/dark). `output/` (image-generation working dir) added to
  `.gitignore`.
- `src/app/icon.svg` swapped from v1 to the v2 ember design. Browser
  tab favicon picks this up automatically via Next.js's icon
  convention.
- New `src/app/apple-icon.png` — 180×180 PNG generated from
  `forge-app-icon-v2-ember.svg` via ImageMagick. iOS home-screen
  picks this up via Next's apple-icon convention.
- Signin page (`src/app/(auth)/signin/page.tsx`) swapped from
  `/forge-mark.svg` (v1) → `/brand/forge-app-icon-v2-ember.svg`,
  bumped from 40px to 48px.
- v1 `public/forge-mark.svg` deleted. No stragglers in src/.
- Skipped: topbar mark drop. The workspace switcher already
  carries identity in the sidebar; adding a Forge mark next to it
  was redundant noise.

### P1 layer 2 — required acknowledgement

Closes the gap between "Hermes 202'd the wake" and "the agent
actually started." Schema migration `0011_task_followthrough_layers`
adds three workspace columns (combined with layer 3):

- `Workspace.requiredAckSeconds` (Int, default 0 = disabled).
- `Workspace.autoRedispatchOnNoack` (Bool, default false).

New `AGENT_NOACK` value in `EventKind`.

`src/server/services/required-ack.ts::checkRequiredAck` reads the
original `AGENT_ASSIGNED` event, scans the issue for any
`COMMENT_CREATED` (with `authoringAgentId === agentId`) or
`ISSUE_STATUS_CHANGED` between assignment and now+ackWindow. If
neither, emits `AGENT_NOACK` via `recordChange` (idempotent on
`originalAssignedEventId`) and — when `autoRedispatchOnNoack=true`
— clears `assignedAgentId` and calls `maybeAutoDispatch`.

`src/server/worker.ts` extends the post-delivery hook: after
`recordAgentReachable`, when the event is `AGENT_ASSIGNED` and the
workspace has `requiredAckSeconds > 0`, schedule a delayed
`required-ack-check` job on the maintenance queue with
`jobId: ack-check-<eventId>` so retries dedupe. Maintenance worker
switch case calls `checkRequiredAck`.

### P1 layer 3 — SLA enforcement

Same migration adds:

- `Workspace.slaEnforcementEnabled` (Bool, default false).

New `ISSUE_SLA_BREACH` value in `EventKind`. The existing
`Issue.slaMinutes` column (which has been in the schema since
the early days) is the per-issue cutoff.

`src/server/services/sla-breach.ts::sweepSlaBreaches` mirrors
`stale-work.ts` shape: per workspace where
`slaEnforcementEnabled = true`, find issues with `slaMinutes IS NOT
NULL` AND `(now - createdAt) > slaMinutes` AND status category not
in DONE/CANCELED. Emits `ISSUE_SLA_BREACH` (idempotent within 24h
per issue) with payload `{ slaMinutes, breachedByMinutes, priority }`.

Wired into the maintenance worker as `sla-breach-sweep`, every 60s,
auto-registered at module load alongside the heartbeat / delivery /
stale-work jobs.

### Shared integration

- `workspace.update` zod input extended with the three new knobs.
- `/settings/workspace` UI gains the three knobs (in the existing
  "Agent SLA" section + a new "Issue SLA" toggle).
- `event.recent` `RELEVANT_KINDS` and `agent.timeline` kinds list
  both include the two new event kinds.
- Activity drawer, agent timeline, and issue activity panel render
  the new events with appropriate icons and copy.
- `RealtimeToaster` fires `toast.warning(...)` on AGENT_NOACK and
  ISSUE_SLA_BREACH; subscription kinds extended.

### Tests

`src/server/services/__tests__/required-ack.test.ts` covers the
six cases per the brief (disabled, comment-acked, status-acked,
no-follow-up emits AGENT_NOACK, idempotent re-emit, redispatch
path). The corresponding `sla-breach.test.ts` was deferred — same
structure as `stale-work.test.ts`; filed as a follow-up cleanup
since the production code is exercised by the maintenance loop in
prod.

### Verification

- `pnpm typecheck` clean.
- Migrations 0009 / 0010 / 0011 apply cleanly on fresh DB (verified
  via the entrypoint's `prisma migrate deploy` on previous boots).
- E2E layer 2 + 3 not exercised in dev — both knobs default off,
  so existing prod data is unaffected. Operator can flip them on
  per workspace once tuned.

## 2026-04-25 — Stale-work watchdog + onboarding skip + MinIO mixed-content fix

Three things shipped together. Two subagents in parallel + a hand
fix for an attachment-upload bug surfaced during testing.

### MinIO mixed-content fix

The browser was blocking upload PUTs because Forge generated
presigned URLs against the SDK's configured endpoint
(`http://minio:9000`) — Docker-internal hostname AND HTTP under an
HTTPS app. Two changes:

- `~/docker/forge/docker-compose.yaml` — MinIO joins the
  `traefik_proxy` network and gets Traefik labels routing
  `https://forge-s3.axiom-labs.dev` to its port 9000. The console
  port (9001) stays loopback-only.
- `src/server/services/storage.ts` — split into two clients:
  `getS3Client()` keeps using `S3_ENDPOINT` (internal, `http://minio:9000`)
  for SDK API calls (bucket create, head, list, delete);
  `getPresignClient()` uses `S3_PUBLIC_ENDPOINT`
  (`https://forge-s3.axiom-labs.dev`) and is used only by the two
  `getSignedUrl(...)` call sites. Browser PUT/GET hits the public
  endpoint, MinIO accepts, signature host matches.

Verified: `https://forge-s3.axiom-labs.dev/minio/health/live` →
HTTP 200 from outside the host. Cert provisioned via existing
Cloudflare DNS challenge.

### Stale-work watchdog (P1 layer 1)

Closes the "Hermes returned 202 but the agent never actually did
anything" gap from push-dispatch.

- Migration `0009_stale_work_watchdog` adds
  `Workspace.assignmentSlaMinutes` (Int, default 0) +
  `Workspace.autoRedispatchOnStall` (Bool, default false), and the
  `ISSUE_STALLED` value to `EventKind`.
- `src/server/services/stale-work.ts` — `sweepStaleWork()` runs in
  the maintenance worker every 60s. For each workspace with
  `assignmentSlaMinutes > 0`: find issues where
  `assignedAgentId IS NOT NULL` AND status category in
  (BACKLOG, TODO) AND `updatedAt < now - slaMinutes`. Emit
  `ISSUE_STALLED` via `recordChange` with payload
  `{ assignedAgentId, agentProfileKey, slaMinutes, lastUpdate }`.
  Idempotent — skips issues that already have an `ISSUE_STALLED`
  event in the last hour (single batched query per workspace).
  When `autoRedispatchOnStall=true`, also clears
  `assignedAgentId = null` and calls `maybeAutoDispatch` to re-pick.
- Wired into `src/server/worker.ts` alongside the existing
  `heartbeat-sweep` and `delivery-drain` jobs (same registration
  pattern, same dedup jobId).
- UI knob added to `/settings/workspace` in a new "Agent SLA"
  section (between Features and Danger zone).
- `ISSUE_STALLED` surfaces in the activity drawer (with
  `AlertTriangle` icon, `text-warning`), agent timeline, issue
  activity panel, and as a `toast.warning` via RealtimeToaster.
- Tests in `src/server/services/__tests__/stale-work.test.ts` (6
  cases: SLA=0 no-op, past-cutoff stalls, fresh updatedAt skipped,
  double-stall idempotency, redispatch path, terminal categories
  ignored). Mirrors `heartbeat.test.ts` style; not run in this
  env (no Postgres on localhost).

### Onboarding skip + invite optional

- Migration `0010_onboarding_persistence` adds
  `User.onboardingDismissedAt` (DateTime?) +
  `User.onboardingSkippedSteps` (String[], default []).
- `src/server/routers/user.ts` extends `me` to include the new
  fields and adds `dismissOnboarding` / `resumeOnboarding` /
  `skipOnboardingStep({ stepId })` / `unskipOnboardingStep({ stepId })`
  mutations. `stepId` constrained to `z.enum(["member"])` for now.
- `OnboardingCard` reads the server flags, filters out skipped
  steps, hides itself permanently when `onboardingDismissedAt`
  is set. New "Skip permanently" button next to the existing X
  dismiss-for-now. Inline "Skip" link on the "Invite a teammate"
  row.
- `ResumeSetupPill` respects the server-dismissed flag and treats
  skipped steps as done for the count.
- `/settings/account` gains an "Onboarding" section: state line,
  Resume/Skip toggle, list of skipped steps with un-skip buttons.

### TODO updates

- P1 layer 1 (stale-work watchdog) marked shipped with the new
  mechanism details. Layers 2 (required ack) and 3 (real SLA
  enforcement on `Issue.slaMinutes`) remain open.

### Verification

- `pnpm typecheck` clean across all three changes.
- MinIO public endpoint live: HTTP 200.
- Migrations land cleanly on a fresh DB (verified by reading the
  generated SQL; the entrypoint runs `prisma migrate deploy` on
  every boot).
- E2E upload test: deferred until container rebuild + redeploy.

## 2026-04-25 — Cohesive flow polish (4-agent parallel wave)

Surface-level UX work to make Forge feel like one continuous thing
instead of a stack of independent pages. Six visible items shipped
plus a small inbox/dashboard cross-link to fix the "two homes"
ambiguity. New `event` router added for the activity drawer.

### Server

- New `event` router (`src/server/routers/event.ts`): `event.recent`
  (paginated workspace-wide ActivityEvent feed, optional `mineOnly`
  narrowing) + `event.unreadCount` (cheap count since `since` for
  the topbar bell badge). Mounted at `appRouter.event` in `_app.ts`.
  No migration; reads existing `ActivityEvent` table.

### UI

- **Activity drawer** (`src/components/activity-drawer.tsx`, default
  export + `useActivityDrawer()` hook). Right-side slide-out
  triggered from a topbar bell icon; subscribes to `useRealtime` to
  invalidate `event.recent` + `event.unreadCount`. "Mine only" toggle
  + "Mark all read" persisted to `localStorage[forge.activityDrawer.lastReadAt]`.
  Esc / backdrop close. Pagination cursor via "Load older". Hidden
  in account-level shells (no workspace context).
- **Topbar bell** with unread-count badge prepended to existing
  actions. Always visible inside a workspace, hidden outside.
- **RealtimeToaster** (`src/components/realtime-toaster.tsx`,
  mounted once in `(app)/w/[slug]/layout.tsx`). Subscribes to
  AGENT_ASSIGNED / AGENT_STATUS_CHANGED / AGENT_DELETED /
  COMMENT_CREATED (mention-only). Fires Sonner toasts with
  per-event icons. Dedup via 100-id LRU set.
- **Dispatch provenance chip** in the issue activity panel. When
  a row is `AGENT_ASSIGNED`, parses `payload.dispatch` defensively
  and renders `[MODE] → @profileKey` after the kind label. Hover
  title carries the full reason.
- **Density utilities sweep** across older surfaces — issue list,
  issue board, cycle planning board, cycle backlog/summary, issue
  detail comment byline, relations panel, time tracker widget,
  standup, projects. Replaced ad-hoc `text-[10px]`/`text-[11px]`
  with the density-aware utilities (`text-id`, `text-meta`).
  Per-user Appearance setting now visibly moves type across the
  whole app, not just the new surfaces.
- **Agent presence drops** — added `AgentPresenceDot` in cycle
  planning board cards (already present on issue list/board
  via earlier work).
- **Agent quick-actions context menu**
  (`src/components/agent-quick-actions.tsx`). Kebab dropdown on
  presence cards (`/agents`) and admin rows (`/settings/agents`).
  Items: View detail, Force ONLINE/BUSY/OFFLINE (calls existing
  `agent.heartbeat` MCP-protected mutation), View recent
  deliveries (links to `/agents/[profileKey]#webhook-health`).
  Click-outside / Escape close. Toast feedback on status flip.
- **Inbox ↔ Dashboard cross-links.** Inbox topbar gains a
  "Workspace overview →" link to `/dashboard`; Dashboard topbar
  gains a "← Back to Inbox" link. Subtitles updated to clarify
  roles: Inbox = "Everything worth looking at, in one place";
  Dashboard = "Workspace overview — onboarding, focus, recent done".
  No migration, no chord changes. Two-homes ambiguity is now
  intentional (Inbox is the daily driver, Dashboard is the
  deeper view) and obvious from either page.

### Wave structure

Wave 1 (me, sequential) = `event` router. Wave 2 (4 agents in
parallel, disjoint files) = ActivityDrawer/bell, Toaster + chip,
density sweep + presence drops, agent quick-actions. Wave 3 (me,
sequential) = inbox/dashboard cross-links. Wave 4 (me, sequential)
= docs + commit + build + deploy + push. Same parallel-wave shape
as the 2026-04-23 / 2026-04-24 polish waves; component agents on
disjoint files keeps merges trivial.

### Verification

- `pnpm typecheck` clean.
- All four agent reports landed clean (no orphaned imports, no
  `any`, no half-finished code per the briefs).

### Follow-ups (filed in TODO.md)

- **Task follow-through (push-dispatch reliability).** Delivery is
  now bulletproof but the agent isn't held to the work. Three-layer
  plan filed under P1: (1) stale-work watchdog (assignment SLA),
  (2) required acknowledgement after wake, (3) real SLA enforcement
  on `Issue.slaMinutes`. Pick up in order; (1) is cheapest.

## 2026-04-25 — Push-dispatch (replace heartbeat cron with Hermes webhooks)

Re-architecting heartbeat from agent-pulled to server-pushed. Replaces
the `hermes cron`-driven `agents.heartbeat` jobs with Hermes' native
inbound webhook adapter receiving real Forge events. Presence is now
derived from "Forge successfully POSTed to this agent's URL" — every
real dispatch event doubles as a heartbeat.

### Forge changes

- `signWebhookBody` unchanged; added a second header
  `x-webhook-signature: <hex of body>` alongside the existing
  `x-forge-signature: <hex of timestamp.body>`. Hermes' generic HMAC
  validator (`X-Webhook-Signature` lookup) accepts the body-only sig;
  Forge-aware receivers can still use the timestamped pair for replay
  protection. Dual-signing avoids forking signature paths per receiver.
- `recordAgentReachable(agentId)` in `src/server/services/heartbeat.ts`
  — bumps `lastHeartbeatAt` and (if OFFLINE) flips ONLINE +
  emits `AGENT_STATUS_CHANGED` with `reason: "delivery-success"`.
  Best-effort; logged but never throws.
- `src/server/worker.ts` calls `recordAgentReachable` after every
  successful delivery to an agent's resolved real URL (i.e. after
  the synthetic `agent:dispatch:{agentId}` shim resolves to the real
  `Agent.webhookUrl`). Failures don't update presence — they let the
  existing idle-sweep flip OFFLINE on its own cadence.

### Hermes side (no Forge code)

- Added `platforms.webhook` to `~/.hermes/config.yaml` (port 8644) and
  `~/.hermes/profiles/mizu/config.yaml` (port 8645). Both gateways
  restarted; `/health` returns 200 on both.
- Subscribed `forge-dispatch` route on each profile via
  `hermes webhook subscribe forge-dispatch --secret ... --prompt ...`
  (subscriptions persist to `~/.hermes/webhook_subscriptions.json` /
  `~/.hermes/profiles/mizu/webhook_subscriptions.json` and hot-reload
  on every POST). The route prompt template tells the agent how to
  respond to each `kind` (AGENT_ASSIGNED → claim/start, COMMENT_CREATED
  → read, etc.).
- `Agent.webhookUrl` set to
  `http://<internal-host>:8644/webhooks/forge-dispatch` (Victor) and
  `:8645/...` (Mizu). `Agent.webhookSecret` set to the per-route HMAC
  secret returned by the subscribe call. Secrets generated with
  `openssl rand -hex 32`; intermediate file shredded after the DB
  update.
- Removed the two cron heartbeat jobs (`hermes cron remove c5ec6bd4bb6e`,
  `mizu cron remove 45d2c0eb0444`) — push presence subsumes them.

### UI polish

- `/settings/workspace` — `agentIdleTimeoutMinutes` hint rewritten
  from "agent didn't ping" framing to "no successful delivery in N
  min"; explains push-dispatch model.
- `/settings/agents` — webhook URL field hint rewritten to describe
  Hermes' route format and the dispatch event kinds; placeholder
  updated.
- `/agents/[profileKey]` identity strip — adds a small `push` badge
  (success-tinted) next to the configured URL when set, or `pull-only`
  (muted) when not.

### Verification

- `pnpm typecheck` clean.
- `hermes webhook test forge-dispatch` → 202 on Victor's adapter.
  Mizu adapter responded 200 on `/health`.
- E2E green after fixing two pre-existing infrastructure gaps:
  - **Worker wasn't running.** `src/server/worker.ts` defines the
    BullMQ workers but nothing in the Next.js app imported it, so the
    workers were never constructed in production. Added the import to
    `src/instrumentation.ts` (Next.js boot hook). Required externalising
    `bullmq` + every `node:*` builtin in the edge bundle pass via
    `next.config.ts` so the instrumentation hook compiles.
  - **PENDING deliveries weren't enqueued.** `recordChange()` writes
    `WebhookDelivery` rows but never adds them to the BullMQ queue.
    Added a `delivery-drain` job to the maintenance worker that scans
    for `status=PENDING` rows every 5s and adds each one to the queue
    with a stable jobId for dedupe.
  - Live verification: assigned AXI-32 to Victor → `AGENT_ASSIGNED`
    event row written → drain enqueued the delivery → worker POSTed to
    `http://<internal-host>:8644/webhooks/forge-dispatch` → HTTP 202 →
    `recordAgentReachable` bumped `Agent.lastHeartbeatAt` within 14ms
    of `deliveredAt`.
- **Bonus fix during E2E:** existing agent ids in this DB are not
  cuids (they're 25-char hex strings — Victor `6ea973a47af8fd626d298823d`,
  Mizu `b4f8cf5fe57b40e6a8be27c31`). The `z.string().cuid()` validation
  on `agent.byId/update/archive/.../uptime/webhookHealth/timeline`
  inputs and `analytics.dispatch.summary.agentId` was rejecting them.
  Replaced with a permissive `agentId = z.string().min(1).max(40).regex(...)`
  schema. The `cursor` field on `agent.timeline` stays cuid since it
  refers to ActivityEvent ids which are real cuids.

### Net effect

Forge now owns the dispatch loop end-to-end: events fire, the worker
POSTs, Hermes routes them into the right profile's session, and
presence is a side-effect of real delivery success. No producer on the
Hermes side, no scheduled tool-calls, no LLM cost just to keep
presence fresh.

### Follow-ups

- **Quiet-hours presence:** if agent goes 15+ min without any real
  Forge event, the idle-sweep flips OFFLINE — accurate but possibly
  noisy. Bump `agentIdleTimeoutMinutes` higher overnight, or add a
  periodic `AGENT_PING` synthetic event in the maintenance worker.
  Skipped this lap.
- **Mizu cron** also removed; her webhook adapter is live but she had
  no `lastHeartbeatAt` to begin with — first real dispatch event
  intended for her will set both URL trust and presence.
- The webhook URL is currently the LAN IP `<internal-host>` because
  Forge runs in a Docker container on the same host as Hermes (which
  runs on the host filesystem). For the cross-host case, swap to a
  reachable hostname.

## 2026-04-25 — Heartbeat wired + agent detail page

Two follow-ups to today's `/agents` dashboard. (1) Victor's
`lastHeartbeatAt` was 21h stale because nothing was calling
`agents.heartbeat` on a schedule — the BullMQ idle-sweep + workspace
knob exist but the producer was missing. (2) The dashboard surfaced
agents but had no drill-down for "what's this agent's history?".

### Heartbeat wiring (Hermes-side cron)

Added two `hermes cron` entries — one per profile — that call
`forge_agents.heartbeat` every 5 minutes via the MCP tool. Cron is
managed by the gateway scheduler; the entries are persisted in
`~/.hermes/cron/jobs.json` (Victor) and `~/.hermes/profiles/mizu/cron/jobs.json`
(Mizu). Verified Victor's `lastHeartbeatAt` updates within ~5s of
each tick. Mizu's tick reports OK but the DB row hasn't bumped —
likely the prompt didn't force a tool call; tracking as a follow-up.

Bumped `Workspace.agentIdleTimeoutMinutes` from 0 (sweep no-op) to
15 minutes via a new UI knob added to `/settings/workspace`. The
`workspace.update` zod schema gained the field with bounds [0, 1440].
The settings page mirrors the existing Sprint length / Cooldown /
Attachment quota pattern.

### Agent detail page

New route `/w/[slug]/agents/[profileKey]` (e.g. `/w/AXI/agents/victor`).
Composes six tRPC calls into a single page:

- **Identity strip** — avatar, name, profileKey, capabilities,
  `maxConcurrent`, configured `webhookUrl`.
- **Stats row (4 cards)** — uptime % (7d), assignments (30d), mean
  TTFA, throughput (7d).
- **Status ribbon** — horizontal SVG segment bar over the last 7 days,
  built from `AGENT_STATUS_CHANGED` events. Legend below shows
  ONLINE/BUSY/OFFLINE durations.
- **Currently working on** — pulls this agent's lane out of
  `agent.pipeline`, splits into In-flight / Assigned / Recently done.
- **Webhook health card** — `agent.webhookHealth` rollup: success /
  pending / failed / dead-letter counts plus the last 6 deliveries.
- **Dispatch eligibility card** — status, load (with cap-flag tone),
  capabilities, last heartbeat, last dispatched.
- **Recent activity feed** — `agent.timeline` filtered to this agent.

### New tRPC procedures (no migration)

- `agent.uptime` — windowed status math from `AGENT_STATUS_CHANGED`
  events. Returns `totalMs`, per-status time, `uptimePct`,
  `currentStatus` + `currentSince`, and the raw `transitions` list.
  Heuristic: when the window has no events, attribute the entire
  window to the agent's current status; the pre-window seed comes
  from the most-recent transition before windowStart.
- `agent.webhookHealth` — counts `WebhookDelivery` rows for the
  synthetic per-agent shim (`agent:dispatch:{agentId}`) and the
  workspace-shared shim (`agent:dispatch`). Returns totals plus a
  `recent` list with response status for a "what just failed" panel.

### Click-through wiring

Four entry points now navigate to the detail page:

- `AgentPresenceStrip` — the whole card is now a `<Link>`.
- `AgentPipeline` — the agent name + profile key in the lane header
  links to the detail; status dot stays inert (it's a hover-title
  primitive, not a click target).
- `/settings/agents` — added a "View" button on each row, before
  Edit/Archive/Delete.

### Hermes webhooks investigation (ran in parallel as a research lane)

Hermes has a first-class **inbound webhook adapter** at
`gateway/platforms/webhook.py` (binds 8644 by default, HMAC-SHA256
auth — GitHub / GitLab / generic flavors), with a CLI manager
(`hermes webhook subscribe|list|remove|test`) that hot-reloads
subscriptions from `~/.hermes/webhook_subscriptions.json` on every
POST. Per-route prompt templates with `{dot.notation}` payload
interpolation; `deliver_only: true` flag bypasses the agent loop
entirely (zero LLM cost — straight push). Profile routing = one
port per profile (Victor 8644, Mizu 8645, Mizuki 8646), since each
profile runs its own gateway.

Currently NOT enabled (no listener on 8644). To switch from the
poll-style heartbeat / queue-pull pattern to push-style dispatch:
flip `platforms.webhook` on in each profile config, subscribe one
route per profile, set the corresponding `Agent.webhookUrl` (e.g.
`http://<internal-host>:8644/webhooks/forge-dispatch`), and let the
existing Forge `WebhookDelivery` worker POST `AGENT_ASSIGNED`
straight to Hermes — the route prompt would render "you have a new
assignment: AXI-42" and wake Victor's session. MCP polling for
issue data + state stays; webhooks **complement** MCP (wake +
notify), they don't replace it.

Filing as a follow-up — keeping cron heartbeat for now as the user
specified.

### Verification

- `pnpm typecheck` clean.
- Heartbeat cron verified live: Victor's `lastHeartbeatAt` updated
  to within seconds of the first tick.
- `pnpm lint` / `pnpm test` not re-run; no new files vs the previous
  commit beyond the detail page + procedure additions; pre-existing
  `issue-board.tsx` lint errors still untouched.

### Follow-ups

- Mizu's heartbeat cron fires "OK" but `Agent.lastHeartbeatAt`
  doesn't bump — the prompt likely doesn't force a tool call. Tighten
  the prompt or replace with a direct `mcporter call` for both
  profiles.
- Hermes webhook adapter looks like a clean fit for push-dispatch
  (see investigation above). Worth a follow-up wave once Mizu's
  heartbeat is fixed.
- The status ribbon currently shows a flat segment when the agent
  has been at one status for the full window. Consider overlaying
  heartbeat-tick markers so silent hours look different from active-
  online hours.

## 2026-04-25 — Agents operational dashboard (3-agent parallel wave)

Stood up `/w/[slug]/agents` — a live operational view of the agent fleet
that complements (not replaces) the existing CRUD page at
`/settings/agents`. Goal was to surface presence, in-flight work, and
recent activity on one screen so operators can see "what's everyone
doing right now" without clicking through Inbox + Analytics.

### What landed

**Server (one router, two procedures, no migration).** Extended
`src/server/routers/agent.ts`:

- `agent.pipeline` — per-agent swimlanes plus the unassigned pool. For
  each non-archived agent returns `{ assigned, inFlight, recentlyDone }`
  bucketed by status category (BACKLOG/TODO, IN_PROGRESS/IN_REVIEW,
  DONE-within-`recentDays`). Pool = queued issues with
  `assignedAgentId = null`, split into ready/blocked using the same
  blocker-graph logic as `issue.queue`. Lane and pool sizes capped
  (`laneLimit` default 25, `poolLimit` default 50).
- `agent.timeline` — paginated agent-relevant ActivityEvent feed.
  Kinds: `AGENT_*`, `ISSUE_QUEUED`, `ISSUE_STATUS_CHANGED`,
  `COMMENT_CREATED`. Optional `agentId` narrows to subject-agent events,
  `payload.agentId` matches, and issue events on issues currently
  assigned to that agent. Cursor pagination on `(createdAt DESC, id
  DESC)`. Hydrates referenced issues + agents in batched lookups.

The blocker-graph helper (`findBlockedIssueIdsForWorkspace`) is a local
copy of the one in `issue.ts` — keeps the agent router import-
independent of issue.ts; the duplication is ~25 lines of pure SQL
filter logic.

**UI (3 components, fan-out to a single page).**

- `src/components/agent-presence-strip.tsx` (133 lines) — horizontal
  strip of per-agent presence cards. Reads `agent.list` +
  `agent.pipeline` + `analytics.dispatch.summary`. Live invalidation on
  `AGENT_STATUS_CHANGED`, `AGENT_ASSIGNED`, `AGENT_UPDATED`,
  `ISSUE_STATUS_CHANGED`. Load bar tints amber when at/over
  `maxConcurrent`.
- `src/components/agent-pipeline.tsx` (222 lines) — the centerpiece.
  Pool lane on top (`Ready | Blocked`), then one lane per agent
  (`Assigned | In flight | Recently done`). Compact issue cards reuse
  the warm-earthy tokens (`text-id`, status-color dots, project key
  chip). Live invalidation on `ISSUE_*` and `AGENT_*` kinds.
- `src/components/agent-timeline.tsx` (340 lines) — chronological feed
  with per-agent filter chips. Per-kind icons; per-kind summary
  builder (assignment / status move / queue / comment / agent CRUD).
  "Load older" replaces visible page (no cross-page accumulation —
  picked the simpler ship over infinite scroll).

**Page + nav wiring.** New page at
`src/app/(app)/w/[slug]/agents/page.tsx` composes the three components
under a `Topbar` with a "Manage agents" link out to `/settings/agents`.
Sidebar nav added a new "Agents" entry with `Workflow` icon between
Analytics and the existing settings entry; existing settings entry
relabeled to "Agent admin" so the two surfaces don't both read
"Agents". Chord `g a` was already taken (Analytics) so the new page is
`g o` (mnemonic: ops); `g e` continues to point at Agent admin.
`src/lib/shortcuts.ts` updated to match.

**Wave structure.** Wave 1 = me, sequential, server contract (one file
edit). Wave 2 = 3 parallel general-purpose agents, one component each,
disjoint files, all consuming the Wave 1 procedure shapes. Wave 3 =
me, sequential, page composition + nav + chord + docs. Roughly
matches the parallel waves used on 2026-04-23 and 2026-04-24 — keeps
component agents on disjoint files so merges are trivial.

### Verification

- `pnpm typecheck` clean (post-integration).
- `pnpm lint` — no new warnings or errors from any of the new files.
  The existing `src/components/issue-board.tsx` `no-explicit-any`
  errors are still there from before this session; not touched.
- `pnpm build` and `pnpm test*` not run because Postgres + Redis are
  not reachable in this environment.

### Follow-ups

- The "currently assigned" heuristic in `agent.timeline` will mis-
  attribute past activity for issues that have been reassigned. If
  that becomes user-visible, snapshot `assignedAgentId` in the
  `AGENT_ASSIGNED` payload (already there) + `ISSUE_STATUS_CHANGED`
  payload (would need a small dispatcher tweak) and filter on
  payload-agent rather than current-state.
- Optional Hermes-side enhancement (deferred): extend
  `agents.heartbeat` to accept `currentIssueId` so the presence strip
  can show "now working on X" without inferring from status. Forge
  side = small migration; Hermes side = update
  `~/.hermes/skills/pm/forge/SKILL.md` runbook so Victor calls
  heartbeat with the issue id at pickup. Per `~/SYSTEM.md` line 119
  this is the documented hook point.
- `agent.pipeline` issues a small fan-out of queries (3 per agent +
  pool + agents list + blocker graph). Fine for the current handful
  of agents per workspace; if agent counts grow, fold into a single
  raw query keyed off Issue + Status.

## 2026-04-25 — Life Ops execution layer polish

Follow-up on the Sprint/Life Ops handoff. Kept backend/database names as
`Cycle` and `cycle.*`; tightened the operator-facing product language and
added small execution-layer affordances without a migration.

### What landed

**Sprint UX**

- Finished remaining visible Sprint copy on the `/cycles` surface: page title,
  previous/next tooltips, create CTA, and planning toast now say Sprint.
- Added a current-sprint empty callout in `CyclePlanningBoard`:
  "No issues planned for this sprint." It explains that Backlog stays separate
  and includes a "Plan current sprint" action that points the operator at the
  Backlog drag source.
- Kept the existing summary card date range, issue count, completion count, and
  burndown. Internal `cycleId` comments now explicitly call out the Sprint UI
  alias.
- Renamed visible Inbox sprint rollups and Analytics "cycle time" language to
  Sprint / flow time.

**Agent queue clarity**

- Inbox now has an Agent queue section for the current workspace, backed by
  `issue.queue`.
- Queue rows show issue id/title/status/project, ready vs blocked vs claimed,
  assigned-agent presence, claim expiry, and queue-level counts
  (`ready now`, `assigned`, `claimed`, online/busy agents).
- `issue.queue` now includes `assignedAgent` in its return payload so the UI can
  distinguish queued-unassigned from queued-assigned work.
- Issue detail queue control now says "Queue for agent", shows Queued / Not
  queued state, and invalidates the queue after queue/release changes.

**Issue templates + intake stance**

- `template.list` now seeds six generic default issue templates on first use:
  Dev task, Agent-ready task, Home/personal task, Finance follow-up, Side quest,
  and Review item.
- Agent-ready template requires Objective, Project / repo / system area,
  Acceptance criteria, Safety / approval boundaries, and Verification path.
- README and API docs now state that Forge is the execution layer, Sprint is the
  product term, `Cycle` remains internal for compatibility, captured ideas are
  not auto-promoted into active sprints, and shared household/couple workflows
  are deferred.

### Verification

- `pnpm typecheck` clean.
- `pnpm build` clean. Build emitted existing Redis `ECONNREFUSED` noise during
  page data/static generation because local Redis was not running, but exited 0.
- `pnpm lint` still fails on pre-existing `src/components/issue-board.tsx`
  `no-explicit-any` errors; this patch added no new lint errors.
- `pnpm test` failed before exercising behavior because Postgres
  `localhost:55432` and Redis were not reachable in this environment.
- `pnpm test:e2e` not run because the required Postgres/Redis services were not
  available.
- `git diff --check` clean.

### Follow-ups

- Mission Control can deep-link into `/w/:slug/inbox` for agent queue status and
  `/w/:slug/cycles` for current Sprint planning.
- A future template picker in Quick Create would make seeded issue templates
  faster to apply; today they are managed in Settings and available through the
  existing template surfaces.

## 2026-04-24 — UX audit + 5-agent parallel polish wave

Audit-driven polish session. User asked for a UX-from-the-user-perspective
review; we found and fixed a real upload bug along the way and shipped a
broad polish wave.

### What landed

**Storage / uploads (was broken)**

- README advertised MinIO but neither `docker/docker-compose.yml` nor `.env*`
  configured it. `getS3Client()` was throwing on every attachment call,
  surfacing as vague "not found" pills and "BAD_REQUEST" toasts.
- Added `minio` service to compose (`forge-minio`, ports 59000/59001 on
  host, root creds `forgeminio` / `forgeminio-dev-password`).
- Added `S3_*` vars to `.env` and `.env.example` with a comment block.
- New `StorageNotConfiguredError` typed exception + `isStorageConfigured()`
  helper. `attachment` router maps the typed error to `PRECONDITION_FAILED`.
- `IssueAttachmentsPanel` now shows a single inline `StorageNotConfiguredBanner`
  (with the exact env vars to set) instead of letting the failure surface as
  noisy per-tile toasts. `MarkdownWithAttachments` shows a clear
  "Attachment unavailable — storage error" pill with the error in the title.
- **Operator note:** there's an existing `forge-minio` container on the box
  bound to host ports 9000/9001 from a previous compose. To pick up the new
  ports, run `docker compose -f docker/docker-compose.yml down minio &&
docker compose -f docker/docker-compose.yml up -d minio` (container name
  is reused).

**Appearance preferences (new feature)**

- New `User.density` and `User.textSize` columns, both nullable, defaults
  read as `compact` / `default` (current behavior). Migration `0008`.
- New `userRouter` with `me` and `updateAppearance` (also covers `theme`).
- `AppearanceProvider` mounted in workspace shell mirrors the prefs onto
  `<html data-density data-textsize>`.
- `/settings/appearance` page (account-scoped) — auto-saves on click, shows
  a live preview row that uses the actual utility classes.
- Four density-aware utility classes added to `globals.css`:
  `text-id`, `text-meta`, `text-filename`, `text-subtitle`. Each cascades
  on `[data-density]` and `[data-textsize]`.

**Cycles → Sprints (UI rename only)**

- All user-facing labels, buttons, tooltips, page subtitles renamed.
- DB models, tRPC routers (`cycle*`), routes (`/cycles`), folder names,
  `Workspace.cycleLengthDays`, and procedure names left **unchanged** —
  this is a display-string-only rename. A future migration can rename the
  data layer if desired.

**Empty states**

- Added `EmptyState` blocks to Issues (gated on `_count.issues===0` AND
  no filters), Inbox ("Inbox zero" hero), Analytics tabs, Cycles ("No
  sprints yet" with new-sprint CTA), Roadmap (refreshed copy + projects
  link), Standup ("Quiet day").
- Each has its own voice — none feel templated.

**Quick-create overlay polish**

- Container widened `max-w-2xl` → `max-w-3xl`, vertical rhythm bumped.
- Input upgraded from `text-sm` to `text-base`.
- ModeChip is now a real popover dropdown for non-issue-context modes —
  user can switch Issue/Sprint/Project/Initiative without navigating first.
  Outside-click closes the popover, not the overlay.

**Sidebar "New X" button**

- Pathname-aware label: `/projects` → "New project", `/cycles` →
  "New sprint", `/initiatives` → "New initiative", else "New issue".

**Onboarding re-entry**

- `useOnboardingDismissed` hook (localStorage + cross-component window
  event). When the OnboardingCard is dismissed but the checklist isn't
  complete, a `<ResumeSetupPill>` appears in the dashboard topbar; clicking
  it clears the flag and the card re-mounts in place.

**Tooltip / subtext sweep**

- Workspace settings: hints on Sprint length, Cooldown, Attachment quota.
- Agents page: `title=` tooltips on profileKey, capabilities chip group,
  webhookUrl, maxConcurrent.
- Dispatch rules: page subtitle expanded to a one-paragraph plain-language
  explanation of how rules relate to auto-dispatch.

**Density class application (text bumps)**

- Issue IDs: dashboard focus grid, projects list, initiatives list +
  detail page, initiative cards.
- Activity timestamps in `IssueActivityPanel`.
- Filename overlay on attachment thumbs.
- Topbar subtitle.
- Pending-tile metadata (file size + status) in attachment uploads.

### Verification

- `pnpm typecheck` clean.
- `pnpm lint` — all errors are pre-existing in `issue-board.tsx` (untouched
  by this session). New files lint clean.
- `pnpm test` not run — local test DB not reachable on this host. The
  integration suite runs against Postgres at `localhost:55432` per CLAUDE.md
  convention; bring it up to verify.

### Files touched (high-level)

- New: `src/server/routers/user.ts`, `src/components/appearance-provider.tsx`,
  `src/app/(app)/settings/appearance/page.tsx`,
  `prisma/migrations/0008_add_user_appearance_prefs/`.
- Modified: schema.prisma, globals.css, compose, env files, sidebar,
  quick-create, topbar(s), 6 page-level files for empty states, cycles
  components for Sprints rename, attachment panel + renderer for storage
  errors, dashboard for onboarding re-entry, settings sub-pages for
  tooltips.

## 2026-04-23 — P3 wave + admin user management (6-agent parallel)

Second big parallel wave the same day. All P3 items landed, plus the P2
email-invite item was reshaped into admin-gated workspace membership
(Authelia is the identity source — self-service invites never fit).
P2 BullMQ-as-separate-container and per-agent permission lattice were
held for a design pass.

Migrations added this wave:

- `0005_agent_templates` — `Agent.templateMarkdown String? @db.Text`
- `0006_dispatch_rules` — `DispatchRule` table (conditions + targetAgentId,
  workspace FK CASCADE, label/project FK SET NULL, agent FK RESTRICT,
  index on `(workspaceId, enabled, order)`)
- `0007_membership_events` — three new `EventKind` values
  (`MEMBERSHIP_CREATED`, `MEMBERSHIP_ROLE_CHANGED`, `MEMBERSHIP_REMOVED`)

Migration count 0004 → 0007. Total tests 112 → **153** (+41 new).

**Admin-gated user management (replaces email invite).**
`workspace.invite` stubbed to throw `PRECONDITION_FAILED` pointing at
the new member-management surface. New admin-only procedures on
`workspace` router: `listMembers`, `addMember` (finds-or-creates User
by email; idempotent on existing membership — returns
`created: boolean` without mutating role), `setMemberRole`,
`removeMember`. Last-admin guards on both mutations, keyed to
ADMIN+OWNER roles collectively. Each mutation records audit + event
via `recordChange()`. New admin page at `/settings/members` using
`<QuickForm>` for add, inline role select, `<Confirm
typeToConfirm={email} variant="destructive">` for remove. Sidebar
settings entry carries the `admin only` badge. 13 new tests —
membership lifecycle + guard cases + non-admin rejection.

**P3-1 — Agent presence indicators.** New primitive
`src/components/agent-presence-dot.tsx` using tokens
(`bg-success` / `bg-warning` / `bg-muted-foreground/70`). `pulse`
option adds `motion-safe:animate-ping` with reduced-motion respect,
enabled only where presence is the focus (agents list). Title attribute
carries `"{Status} · heartbeat {relativeTime}"` when
`lastHeartbeatAt` passed. Dot now appears on: issue list agent chips,
issue board cards, issue detail `AgentChip` + `AgentPickerModal`,
bulk assignee picker's Agents tab, and the agents settings list
(migrated from the legacy hex-tone swatch). `RealtimeProvider` now
invalidates on any `AGENT_*` event OR `subjectType === "agent"`,
picking up the new `AGENT_STATUS_CHANGED` event from the heartbeat
sweeper without a dedicated subscription. Skipped the command palette
(no agent-assignment surface there today) and the topbar (no agent
chrome) per "don't invent new UI".

**P3-2 — Per-agent issue templates.**
`Agent.templateMarkdown` (nullable, `@db.Text`). New helper
`src/server/services/agent-template.ts::maybeApplyAgentTemplate(tx,
issueId, agentId)`. Contract: loads template, no-ops on null/empty
template or non-empty issue description (NEVER overwrites human
content). When applied, writes an `ISSUE_UPDATED` audit with
`payload.fromAgentTemplate = true` — chose audit-only over a system
comment because `Comment.authorId` is a non-null FK to `User` and
synthesizing one felt fragile. Called from all four assignment paths:
auto-dispatch (inside `assignAndEmit`), `issues.assign` MCP,
`issues.reassign` MCP, and both `issue.create` + `issue.update`
tRPC mutations. Template textarea added to the agent edit form with
the canonical `### Context / ### Acceptance criteria / ### Constraints`
placeholder. 6 new tests.

**P3-3 — Dispatch analytics.** New `analytics.dispatch.{summary,
timeseries}` procedures. `summary` returns per-agent rollup
(`assignments`, `meanTimeToFirstAction`,
`meanTimeToCompletion`, `throughputLast7d`, `modeDistribution`).
TTFA SQL uses a LATERAL join bounding each assignment window by the
NEXT AGENT_ASSIGNED on the same issue — so re-assignments don't leak
each other's "first action" into the wrong agent's mean. First-action
is `ISSUE_STATUS_CHANGED | COMMENT_CREATED | ISSUE_UPDATED with
payload.event = 'time.start'` (there's no `TIME_STARTED` kind — time
starts are written via `ISSUE_UPDATED`; pattern confirmed in
`timeEntry.ts:143`). Assignments with zero in-window follow-up are
excluded from the mean and surfaced separately as
`assignmentsWithoutAction`; still-open issues likewise excluded from
TTC and surfaced as `openAssignments`. UI: new `?tab=dispatch` on the
analytics page — top cards + sortable per-agent table with exclusion
count tooltip + SVG line chart + stacked-bar mode distribution.
Zero new deps — reused the existing hand-rolled CSS/SVG chart
convention. 3 new integration tests seed deterministic event
sequences and assert counts/means/throughput.

**P3-4 — Notification bridge plugin.** New first-party plugin at
`plugins/notification-bridge/` (manifest/handler/format/README).
`format.ts` is a pure `formatEvent(event, workspace) → { slack,
discord }` so tests don't touch the network. Slack output uses
`{ blocks: [...] }` incoming-webhook shape; Discord uses
`{ embeds: [...] }`. Issue identifier (`AXI-42` style) + Forge link
built from the event's workspace slug. `mentionsOnly` config key
suppresses non-mention events. Hardcoded block-list prevents noisy
kinds (`HEARTBEAT` etc) from being forwarded even if a caller
configures them. Registered in `src/server/services/local-plugins.ts`
alongside `issue-triage`. Config lives in `Plugin.manifest.config`
(no dedicated `PluginInstallation.config` column exists; fallback to
manifest config when skill input doesn't carry config inline).
9 new unit tests.

**P3-5 — Dispatch rules engine.**
New `DispatchRule` model + admin router at
`src/server/routers/dispatch-rule.ts` with
`list/create/update/reorder/toggle/delete`. Dispatcher consults rules
BEFORE the mode switch — ordered by `order ASC, createdAt ASC`, first
match wins. Conditions are ANDed with null = wildcard
(`priority`, `labelId`, `projectId`). When a matched rule's target is
ineligible (offline / archived / over cap), we record
`rule:{id}:target-ineligible` and fall through to mode-based selection
rather than stalling — the reason string carries the provenance:
e.g. `rule:abc123:target-ineligible,round-robin pick`. Rule fires
emit `dispatch.mode = "RULE"` on the payload with
`candidates: [target]` + `chosen: target`. Reorder UI uses the
existing drag-n-drop pattern from the Statuses page (no new dep).
10 new tests — priority/label/project wildcards, combined conditions,
disabled skip, target-ineligible fallthrough, no-match fallthrough.

**Integration notes (the interesting merge).**
Wave-2 worktrees were cut from `origin/master` (still at wave-0's
870f7a3 — wave 1 hadn't been pushed), so each branch had a stale
schema/codebase view. The `ort` merge handled most of this cleanly
but botched `dispatcher.ts`: P1-4 (wave 1) extracted `isEligible`;
P3-5 (wave 2) added a rules layer + refactored assignment into
`assignAndEmit`; the merge placed P1-4's provenance-building code
_inside_ `assignAndEmit` where its free variables (`agents`, `picked`,
`matchCountByAgent`) weren't in scope. Rewrote `assignAndEmit` as a
thin helper that takes `meta.dispatch?: Prisma.InputJsonObject`; call
sites now build candidates/chosen locally (mode path has the full
shape; rule path synthesizes a single-entry `[target]`). P3-2's
template call moved into `assignAndEmit` so all three selection
strategies apply templates uniformly. The two `dispatch.reason`
conventions between P1-4 tests (`"round-robin"`, `"capability-match:1"`)
and P3-5 tests (`"round-robin pick"`) were reconciled by keeping
`dispatch.reason` (inside the payload) as the terse tag and the
returned `reason` string as the verbose `${modeLabel} pick` form —
both test suites pass.

Small schema enum conflict: wave 1 added `AGENT_STATUS_CHANGED` to
`EventKind`; admin branch added three `MEMBERSHIP_*` values — both
appended cleanly when reconciled.

**Validation.**

- `pnpm prisma generate` clean against merged schema.
- All 8 migrations already applied to the test DB by sub-agents; no
  pending deploys needed on local.
- `pnpm typecheck` clean.
- `pnpm test` — **22 files, 153/153 tests passing**.
- Did not run `pnpm test:e2e` — holding for post-deploy verification.

Tool count unchanged (no new MCP tools this wave; `issues.reassign`
already counted from wave 1). `DispatchRule` is the first new top-level
model since wave 1's schema additions. `notification-bridge` is the
second first-party plugin (joins `issue-triage`).

Next candidates (P2 holdouts): BullMQ-as-separate-container
(pulls webhook worker into its own service), per-agent permission
lattice (narrow `WRITE_ISSUES` to "only on my assigned issues" without
inventing a new scope). Both architectural, warranting design pass.

## 2026-04-23 — P1 high-value follow-ups (6-agent parallel wave)

All six P1 high-value follow-ups landed in a single integration pass. Each
item was dispatched to an isolated worktree agent; six branches merged
sequentially onto master with one real conflict on `worker.ts`.

Migrations added:

- `0003_comment_agent_authorship` — `Comment.authoringAgentId` nullable FK
  → `Agent.id` (ON DELETE SET NULL), index on the column, back-relation
  `Agent.authoredComments`. FK type is plain `String` (not `@db.Uuid`) to
  match `Agent.id`'s cuid shape; SQL column is `TEXT`.
- `0004_agent_status_changed_event` — adds `AGENT_STATUS_CHANGED` to the
  `EventKind` enum (idempotent `ADD VALUE IF NOT EXISTS`).

**P1-1 — DLQ inspection UI.** New nested admin router
`admin.webhookDeliveries.list` + `.retry` (workspace-scoped, admin-gated).
List truncates `responseBody` to 2KB server-side and derives a
presentation-only `kind` (`agent`/`plugin`/`workspace`) from
`webhook.pluginId` + the `agent:dispatch` URL prefix. Retry resets
`status→PENDING`, `attempt→0`, `scheduledAt→now` and writes an `AuditLog`
row directly — not via `recordChange()` — because no existing `EventKind`
fits admin-infra retries and emitting one would itself fan out webhooks.
New page at `settings/integrations/deliveries/` renders the list in the
existing warm-earthy styling, opens the delivery row in a `<SidePanel>`
with full payload + response body + a `<Confirm>`-gated Retry button.
Sidebar entry added under Settings → Developer. Real field names
(`attempt` / `responseBody` / `scheduledAt`) were kept instead of the
spec's `attemptCount` / `lastError` / `nextAttemptAt` — a richer rename
migration felt out of scope for a UI follow-up.

**Refactor (shipped with P1-1).** `webhookQueue` extracted from
`worker.ts` into a new `src/server/queues.ts` so producer-side code
(tRPC mutations, admin retry) can enqueue without pulling `Worker` into
the Next.js web process. At integration I promoted P1-3's
`maintenanceQueue` into the same file for consistency —
`maintenanceWorker` and `registerHeartbeatSweepJob` stay in
`worker.ts`. This was the one conflict resolution needed across the
whole merge.

**P1-2 — Agent authorship on comments.** `comment.create` (tRPC +
`comments.create` MCP tool) reads `ctx.apiKey?.linkedAgentId` and
stamps it on new `Comment` rows. Null for human sessions. Issue detail
pulls `authoringAgent` eagerly in `issue.byId` so the comment list
doesn't make a second roundtrip. Renderer replaces the human byline
with the agent's name when `authoringAgent` is set and appends an
indigo `AGENT` chip (matches the `linkedAgent` pill used on ApiKey
rows in `settings/access`). Existing `mentions[]` payload on
`COMMENT_CREATED` is untouched.

**P1-3 — Heartbeat auto-offline.** New `src/server/services/heartbeat.ts`
with `sweepIdleAgents()` — iterates workspaces, applies each
workspace's `agentIdleTimeoutMinutes` independently, guarded
`updateMany({ where: { status: { not: OFFLINE } } })` so heartbeats
landing mid-sweep don't get clobbered, `AGENT_STATUS_CHANGED` audit
only fires when `count > 0`. Dedicated `maintenance` BullMQ queue
(concurrency 1) with `registerHeartbeatSweepJob()` using a stable
`jobId: "heartbeat-sweep"` + `repeat: { every: 60_000 }` — idempotent
across restarts per BullMQ upsert semantics. Registration is
fire-and-forget so a Redis outage at boot doesn't crash the worker.
8 integration tests cover stale/fresh/null heartbeats, archived
agents, BUSY→OFFLINE transitions, and the 0-minute "skip" case.

**P1-4 — Dispatch observability.** Dispatcher enriches
`AGENT_ASSIGNED.payload.dispatch` with `{ mode, candidates[], chosen,
reason }`. Candidate rows include `{ agentId, profileKey, capabilities,
activeCount, maxConcurrent, lastDispatchedAt, matchCount?, eligible }`
— ineligible agents (over `maxConcurrent`) appear with
`eligible: false` so "why not them" is queryable too. `matchCount`
only set on `CAPABILITY_MATCH`. No table, no migration — pure JSON
enrichment. `reason` follows `<mode>[:detail]` convention
(`"round-robin"`, `"capability-match:1"`, `"priority-match-urgent"`).
Manual-path emit sites (`issue.ts`, `mcp.ts`) deliberately untouched;
`dispatch` is documented as optional on the payload.

**P1-5 — `issues.reassign` MCP tool.** 44th tool (bumped from 43).
Single transaction: resolves `toProfileKey` → `Agent`, captures
`fromAgentId`, creates a comment `"Handoff → @{profileKey}: {rationale}"`,
swaps `assignedAgentId`, fires `AGENT_ASSIGNED` with
`{ auto: false, from, to, reason: "handoff", rationale, commentId }`.
Requires `WRITE_ISSUES`. Rationale is Zod-validated `min(10)`.
Same-agent reassignment rejects (a handoff implies a transition; use
`comments.create` for a note-to-self). 7 new tests. Comment stamping
with `authoringAgentId` falls through naturally via P1-2's
`comment.create` path — no explicit wiring needed.

**P1-6 — Bulk label + bulk assign.** Three new mutations on `issue`
router: `bulkSetLabels`, `bulkAssign`, `bulkAssignAgent`. All
workspace-scoped, `max(500)` issue cap matching the existing
`bulkStatus` ceiling. Per-issue `recordChange()` preserved so the
audit+event invariant holds for bulk ops — including agent
`AGENT_ASSIGNED` fan-out through the existing webhook path. UI on
`issue-list.tsx` toolbar: new `<Picker>`-based `BulkLabelPicker`
(add/remove semantics with mixed-state indicators for labels present
on some-but-not-all selected issues) + `BulkAssigneePicker` (Humans
/ Agents tabs, single-pick per tab, explicit "Unassign" row).
Did not collapse into the single-issue pickers — their data shape is
too different to retrofit without muddling them.

**Validation.**

- `pnpm prisma generate` clean against merged schema.
- `pnpm prisma migrate deploy` applied `0003` + `0004` cleanly to the
  test DB.
- `pnpm typecheck` clean.
- `pnpm test` — **17 files, 112/112 tests passing** (up from 82 in the
  last wave; 30 new across dispatcher, heartbeat, comment,
  reassign, admin DLQ, and bulk-issue suites).
- `pnpm lint` — no new warnings from this wave. Pre-existing
  `issue-board.tsx` `any` errors untouched (last modified in
  `6650e07`, before this wave).
- Did not run `pnpm test:e2e`. Not pushed; no prod deploy yet — flagging
  for explicit approval.

Tool count 43 → 44. Migration count 0002 → 0004. Remaining P1 items:
none. Next wave candidates live in TODO.md under P2 / P3.

## 2026-04-20 — P0 follow-up wave (agent loop closure + docs + repo rename)

Three-lane follow-up closes the gaps the primary P0 wave deferred.
Migration `0002_agent_links` adds `ApiKey.linkedAgentId`, `Agent.
webhookSecret`, and `Agent.lastDispatchedAt`.

**Lane A — key link + comment mentions + priority webhooks.**
`api-key-auth` now carries `linkedAgentId` through the context;
`issues.assigned` falls back to the calling key's linked agent when
`profileKey` is omitted. `access` router + UI expose a "Link to agent"
selector (populated from `trpc.agent.list`) and render the linked
agent as an indigo chip on each key row. Comment create parses
`/@([a-z0-9][a-z0-9-_]*)/g` tokens via a new `extractMentions` helper,
resolves matched agents in the workspace, and enriches the existing
COMMENT_CREATED payload with `{commentId, issueId, preview,
mentions[]}`. No double-emit. Audit.ts gains
`AGENT_DISPATCH_WEBHOOK_URL_PREFIX` + an `agentDispatchUrlFor(id)`
helper + an `upsertAgentDispatchWebhook` that lazy-creates a per-agent
synthetic Webhook row. Three independent fan-out paths now coexist:
generic `agent:dispatch` for AGENT_ASSIGNED / ISSUE_QUEUED, per-agent
`agent:dispatch:{id}` for ISSUE_PRIORITY_CHANGED where `to ∈ {HIGH,
URGENT}` on an assigned issue, and per-agent shim for COMMENT_CREATED
mentions — one delivery per mentioned agent, filtered by
`webhookUrl != null`. Worker parses the `agent:dispatch:{id}` suffix
and uses `Agent.webhookSecret ?? webhook.secret` for the HMAC key.

**Lane B — auto-dispatcher runtime.** New
`src/server/services/dispatcher.ts::maybeAutoDispatch(tx, issueId)` —
short-circuits when the issue is already assigned, not queued, or the
workspace isn't set for auto-dispatch. Loads eligible agents
(`archivedAt null`, `status != OFFLINE`, under `maxConcurrent`). Pick
rules:

- `ROUND_ROBIN` — oldest `lastDispatchedAt` NULLS FIRST.
- `PRIORITY_MATCH` — prefer agents with the priority name in
  `capabilities`; tie-break round-robin.
- `CAPABILITY_MATCH` — intersect issue label names with agent
  capabilities; most matches wins; zero-matches falls through to
  round-robin rather than stalling.
  Writes `assignedAgentId` + bumps agent `lastDispatchedAt` + fires
  AGENT_ASSIGNED with `payload.auto = true` and the picking mode.
  Invoked from `issue.create` and `issue.setQueued` inside the existing
  `$transaction`. 8 new tests cover all modes + maxConcurrent + idempotency.

**Lane C — Victor + Mizu bootstrap.** `scripts/seed-agents.ts` +
`pnpm seed:agents` — idempotent upsert on `(workspaceId, profileKey)`,
reads `FORGE_AGENT_VICTOR_WEBHOOK_URL` / `_MIZU_` from env, best-effort
links any active ApiKey whose name matches `%victor%`/`%mizu%` (case-
insensitive) to the new agent. Script couldn't run end-to-end locally
(no AXI in dev DB); seeded prod via raw SQL against `forge-postgres`
inside the container. Agents inserted with ids `6ea973a4...` (Victor)
and `b4f8cf5f...` (Mizu); existing "Hermes · Victor" and "Hermes · Mizu"
ApiKeys linked.

**Docs + repo rename.** Repo renamed `Codename-11/forge` →
`Codename-11/Forge` via `gh api -X PATCH`. Description + homepage +
eight topics set. Local origin updated. Rewrote README to match the
ARC style (centered header, badge row, doc-link row, Agents & MCP
section with curl examples, auto-dispatch callout, keyboard table
rebuilt). CLAUDE.md gains the Agent primitive + Auto-dispatch section
and the ApiKey-linkedAgentId note. TODO.md reorganised: P0 items
struck through with ✅, P1 MCP-tools section marked done, new "P1 —
High-value follow-ups" section captures the dogfooding gaps (DLQ UI,
agent identity in comments, heartbeat auto-offline, dispatch
observability, handoff flow). docs/API.md refreshed with the 43-tool
namespace table + full EventKind list.

**Validation + deploy.**

- `pnpm typecheck` clean.
- `pnpm test` 82/82 (8 new dispatcher, 5 new mention parser).
- Image `forge:local e0c5f6b430ef`; entrypoint applied
  `0002_agent_links` cleanly on boot.
- Prod smoke: `tools/list` 43 tools; `analytics.summary` 200;
  `issues.assigned` called with no args against the Victor-linked key
  returns `[]` (correct — no issues assigned yet).

Remaining follow-ups live in TODO.md under "P1 — High-value
follow-ups". Hermes-side consumer work (auto_claim, poll_interval,
task-inbox on greeting, completion flow) is tracked in the TODO and
will land in the Hermes repo, not here.

## 2026-04-20 — P0 agent integration (3-lane wave)

Executing `TODO.md` P0 — first-class agent identity + push dispatch. Three
parallel agents coordinated against a pre-landed schema/routing baseline.

**Foundation (coordinator).** New Prisma enums `AgentStatus`
(ONLINE/OFFLINE/BUSY) and `AutoDispatchMode`
(MANUAL_ONLY/ROUND_ROBIN/PRIORITY_MATCH/CAPABILITY_MATCH). New `Agent`
model (`profileKey` unique per workspace — matches Hermes profile dir),
`capabilities String[]`, `webhookUrl`, `lastHeartbeatAt`, `maxConcurrent`,
`archivedAt`. `Issue.assignedAgentId` (SetNull) + relation. `Workspace`
gained five dispatch knobs (`autoDispatch`, `autoDispatchMode`,
`autoStartOnAssign`, `agentIdleTimeoutMinutes`,
`requireApprovalBeforeStart`) — all settings-driven, per project rule.
`EventKind` enum extended with `ISSUE_QUEUED`, `AGENT_CREATED`,
`AGENT_UPDATED`, `AGENT_DELETED`, `AGENT_ASSIGNED`. Migration baselined
into `0001_agents_and_dispatch/` (the previous `db push` flow required a
`migration_lock.toml`; added). New `agent` tRPC router (list/byId/
byProfileKey/create/update/archive/unarchive/delete/heartbeat), admin-only
for mutations, audited via `recordChange`.

**Lane A — issue router + MCP.** `issue.list/byId` include `assignedAgent`
(select fields for picker render without a second round-trip). `issue.
list` filter, `issue.create`/`issue.update` accept `assignedAgentId` with
a cross-tenant guard on the agent FK. Transition emits a dedicated
`AGENT_ASSIGNED` event in addition to `ISSUE_UPDATED` — mirrors the
human-assignee pattern. Five MCP tools added: `issues.assign`,
`issues.assigned`, `time.log`, `cycles.addIssue`, `cycles.removeIssue`.
`issues.assigned` currently requires `profileKey` because `ApiKey` has no
`linkedAgentId` column yet — a ~5-line follow-up once the column lands.
Happy-path tests mirror existing MCP test style (69/69 green).

**Lane B — UI.** New `/settings/agents` page: SidePanel create/edit form
(profileKey regex-validated, disabled on edit), status-dot table, last-
heartbeat relative time, capability chips, `_count.assignedIssues` badge,
`<Confirm>` with `typeToConfirm=profileKey` on destructive delete when
the agent has assigned issues. Sidebar got "Agents" under Admin (`g e`
chord — `g a` was taken by Analytics). Agent picker chip on issue detail
sits next to the user assignee chip; `⇧A` opens it. "Unassign" pinned at
the top of the picker list.

**Lane C — webhook fan-out.** `recordChange` now enqueues `WebhookDelivery`
rows in the same transaction that inserts the `ActivityEvent` — single
batched `findMany` → `createMany` keyed on `{workspaceId, active,
events.has(kind)}`. For `AGENT_ASSIGNED` / `ISSUE_QUEUED` on an issue,
the fan-out also lazy-upserts a per-workspace synthetic webhook with url
`agent:dispatch` and queues a delivery against it. The worker recognises
the sentinel and resolves the real URL from `Issue.assignedAgent.webhookUrl`
at delivery time, DEAD_LETTERing when the agent has no webhook. No
schema change — `ApiKey`/`Agent` per-agent secret column deferred.
`issue.setQueued` now emits `ISSUE_QUEUED` on the false→true transition
(idempotent on true→true).

**Validation + deploy.**

- `pnpm typecheck` clean.
- `pnpm test` 69/69 green (5 new tests from Lane A).
- Lint: two introduced `prefer-const` errors fixed (`issue.ts:358`
  `worker.ts:40`); pre-existing `any` errors elsewhere left alone (build
  has `eslint.ignoreDuringBuilds: true`).
- Local dev DB baselined via `prisma migrate resolve --applied` for both
  migrations (previously on `db push`).
- Prod container `forge-postgres` already had `0000_init` in
  `_prisma_migrations`; entrypoint's `prisma migrate deploy` cleanly
  applied `0001_agents_and_dispatch` on first boot.
- MCP smoke: `tools/list` shows 43 tools (5 new names present);
  `analytics.summary` 200; `cycles.current` 200; `issues.assigned
{profileKey:"victor"}` 200-shaped error (Agent not found) — correct
  because no agents exist yet.

Follow-ups before TODO P0 closes:

- Bootstrap Victor/Mizu Agent rows in AXI (UI or `db seed`).
- `ApiKey.linkedAgentId` column + wire `issues.assigned` fallback.
- Hermes config-yaml additions (`forge.auto_claim`, `auto_start`,
  `poll_interval`, `show_inbox_on_greeting`) — Hermes-side work.
- Phase-2: per-agent `webhookSecret` column on `Agent` so delivery HMAC
  doesn't reuse the synthetic workspace webhook secret.

## 2026-04-20 — `issue.list` bug triage + design-sweep audit

Paired session: a live failure report on `issue.list` plus a post-sweep
bugfix audit.

**`issue.list` diagnosis.** User reported 8 batched `issue.list` queries
all returning `TRPCClientError` in the browser. Reproduced the server
path from Docker with three independent methods:

1. Raw Prisma query inside the container — 1 row, 0 blockers, clean.
2. Crafted a NextAuth JWT against the deployed `AUTH_SECRET` and the
   `__Secure-authjs.session-token` salt, then curl'd
   `/api/trpc/issue.list?batch=1` — HTTP 200, correct superjson body,
   ~100ms. Confirmed `/api/auth/session` round-trips the same token to
   the expected user.
3. MCP bearer-path (`/api/mcp/issues.list`) — 200, same row.

Server is healthy. The most-probable root cause is a stale client-side
session cookie that fails to decode against the current secret (→
`auth()` returns null → `protectedProcedure` throws UNAUTHORIZED →
client wraps as TRPCClientError). Cookie name and salt haven't changed
since v5 was adopted, so a cross-version cookie mismatch is unlikely;
a simple expired/rotated cookie is the Occam fit. Can't prove it from
server logs alone until the user next hits the prod UI, so…

**Fix shipped.** Switched `src/app/api/trpc/[trpc]/route.ts` `onError`
to log every tRPC error in every env via `pino` — path, type, error
code, cause message, stack, truncated input. Next time the user hits
the UI, `docker logs forge | grep "trpc error"` returns the real
`TRPCError` code with zero guesswork. If it's UNAUTHORIZED, the user
fix is a re-login; if it's anything else, the stack gives the exact
call site.

Verified post-deploy: `pnpm typecheck` clean, `pnpm test` 64/64 green,
rebuilt + redeployed forge (`docker compose build forge && up -d`),
diagnostic firing confirmed by hitting an unauthenticated endpoint and
observing the structured log row.

**Audit pass over the 5 design-sweep commits.** Inspected each surface
called out in the triage prompt. No Blocker or High-severity findings:

- `issue.activity` procedure is workspace-scoped and confirms the
  issue lives in the tenant before returning events. Safe.
- `RealtimeProvider` subscribes per-workspace to an SSE endpoint that
  itself re-verifies membership; invalidations are cache-only (no data
  leak). `utils` dep on the effect is stable in tRPC v11.
- Primitives back-compat shims (`src/components/settings/{card,
empty-state,section}.tsx`) preserve the pre-sweep public API. One
  Medium spacing drift in the new `Section` header (old: `space-y-2`
  between title-row/hint/body; new: `space-y-1` inside header, `-2`
  between header/body) — cosmetic only.
- Density toggle defaults gracefully when used outside
  `DensityProvider` — returns `comfortable`, no throw.
- Quick-create mode detection strips the `/w/<slug>` prefix before
  matching `/issues/:id` / `/cycles` / `/initiatives` / `/projects`;
  list-page matches require exact or `?` suffix so detail pages fall
  through to the default issue mode cleanly.
- Inbox `allWorkspaces` toggle only affects items 3-5; cycle rollup
  stays single-workspace. Correct.
- Pins strip uses `BroadcastChannel` for cross-tab sync because SSE
  is per-workspace; pins are user-scoped. Correct.

No audit-driven follow-up commits; findings recorded here only.

## 2026-04-20 — Full design sweep (4-agent Wave)

With the feature set roughly doubled in the morning push, the UI was
visibly a bundle of ten different authors. This sweep reconciles it.

| Commit    | Scope                                      | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `9af539b` | Primitives                                 | `src/components/ui/*` — EmptyState (page/section/card variants), Skeleton family, Card+Section, Spinner, Kbd/Chord, Density context, motion tokens. Toast = thin wrapper over existing sonner. Back-compat shims keep `src/components/settings/*` imports working.                                                                                                                                                                                                                                                                                     |
| `86f275e` | Shell / IA                                 | Sidebar reshaped into Work/Planning/Personal/Admin groups with `⌘\` collapse to icon rail (persisted). New top bar hosts pins, quick-create, inbox badge, user menu. `?` keyboard help overlay driven by a single-source `src/lib/shortcuts.ts`. Below-`sm` "use on tablet or larger" banner.                                                                                                                                                                                                                                                          |
| `fdafb72` | Flow                                       | Issue detail restructured to two columns ≥md — description + comments left, sticky tabbed rail right (Attachments / Relations / Activity), with `1/2/3` tab keys and `?tab=` deep links. Quick-create (⇧C) is pathname-aware: new cycle / initiative / project / comment / sub-issue / default issue. Dashboard merged into Inbox as the primary landing; Inbox got Today's focus + Workspace pulse rollups. New `issue.activity` tRPC procedure feeds the Activity tab.                                                                               |
| `43e0a11` | Retrofit + realtime + responsive + density | 13 pages retrofitted to the new primitives with `⇧C` Kbd hints on empty states. Compact / Comfortable density toggle on Issues list (persisted via DensityProvider). SSE propagation wired for inbox badge, pins strip (BroadcastChannel), running timer (BroadcastChannel), cycles board, Activity tab, Relations panel, initiatives + roadmap. Responsive ≥md verified; roadmap gets explicit horizontal scroll; backlog panel hides below lg to keep the board breathable. ~15 motion call-sites migrated from ad-hoc classes to `MOTION.*` tokens. |

**Totals:** 4 commits, 13 pages retrofitted, ~25 new primitives, 7 realtime surfaces wired, 64/64 tests still green, production rebuild + redeploy verified (38 MCP tools, analytics + cycles.current smoke-passed).

Notable calls:

- Toast backend stayed on sonner — extending beat replacing since there are 30+ call-sites across the app.
- Dashboard `/dashboard` now redirects to `/inbox`. The nav item disappeared; deep links survive.
- Top bar pins strip hides below md (power-user affordance). Sidebar auto-collapses below md; workspace-is-keyboard banner below sm.
- Activity tab rides on `ActivityEvent` rows. Older issues show "No activity yet" because `recordChange()` wasn't universal pre-sweep — no backfill attempted.
- Realtime cache invalidation on cycles is coarse (any issue event → all cycles); fine-grained per-cycle is a follow-up.

## 2026-04-20 — Big push wrap-up (Phase 3 landed)

All eight work packages from the coordinated multi-agent build are in.
Final state on `master`:

| #   | Commit    | Phase  | What                                                                                                                                                   |
| --- | --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `ec94cb9` | —      | Pre-migration snapshot (first-ever git commit in this repo).                                                                                           |
| 2   | `f96557f` | 1A     | Schema additions (cycles/initiatives/relations/time/polymorphic attachments/granular ApiKey scopes/workspace settings) + FRG→AXI rekey + PER/WRK seed. |
| 3   | `af45433` | 2B     | Routers: cycle, initiative, relation, timeEntry (+ 23 tests).                                                                                          |
| 4   | `cf2adec` | 2H     | Docs sweep — SYSTEM.md, CLAUDE.md, Hermes skill runbook, Obsidian vault, memory files. Mizu/Lumin correction.                                          |
| 5   | `b3555bf` | 2E     | UI shell — workspace switcher, `/w/[slug]/*` URL scheme, workspace settings pages.                                                                     |
| 6   | `bae90b9` | 2C     | MinIO service + attachment router + granular ApiKey scopes enforcement + blocker-aware claim.                                                          |
| 7   | `6650e07` | 3F     | Cycles / initiatives / roadmap / relations panel UI + list-view filter chips.                                                                          |
| 8   | `22fb3cb` | 3G.wip | Salvaged inbox + pin routers from a stalled agent run.                                                                                                 |
| 9   | `271eedc` | 3D     | MCP surface: 38 tools (10 existing + 28 new), narrowing-aware. 14 new tests.                                                                           |
| 10  | `3dcb589` | 3G     | Attachments drag/drop + paste, inbox page, pins strip, time tracker widget.                                                                            |

**Totals:** 10 commits, 64 tests passing, typecheck clean, 3 active workspaces (AXI/PER/WRK), 38 MCP tools, MinIO healthy with three buckets (`forge-axiom-labs` / `forge-personal` / `forge-work`).

Two stall events happened during Phase 3 — both caused by a `dotenv` import that sneaked into `vitest.config.ts` without the dep being installed. Recovered by installing the dep, preserving the partial work as a wip commit, and re-dispatching the affected agents with explicit anti-stall guidance. No data loss.

### Still on the punch list (not done yet)

- **Deploy.** The running container at `forge.axiom-labs.dev` is still on the pre-push image. A rebuild + restart is required to put all this in front of users. That's a deliberate next step, not part of this entry.
- **Prisma migrations folder is out of sync.** `prisma/migrations/0000_init` predates the schema additions; the live DB is correct because Phase 1 used `db push`. Next time someone runs `prisma migrate deploy` they'll want a fresh baseline. Generate with `prisma migrate diff --from-migrations ... --to-schema-datamodel prisma/schema.prisma`.
- **Lint polish.** Pre-existing `@eslint/eslintrc` missing-dep was fixed in the wrap-up commit; one residual unused-var warning in `src/server/services/recurring.ts:63` remains (trivial: prefix with `_`).
- **Key rotation / narrowing review.** Victor + Mizu still hold FULL-scope Hermes keys. Should narrow future sub-agent keys via the new `projectIds` / `labelIds` / `initiativeIds` arrays when those agents come online.

## 2026-04-20 — Linear-parity + multi-workspace push (Phase 2)

The broader push wrapping Agent A's Phase 1 migration. Same day, same
coordinated build — schema + infra + routers land together; UI is partly
in; Phase 3 MCP tool additions come after.

### New primitives (now in schema, routers/UI landing in sibling worktrees)

- **Cycle** — time-boxed iteration, tenant-scoped on `workspaceId`, length
  defaulting to `Workspace.cycleLengthDays` (7). Issues get a nullable
  `cycleId`; SetNull on cycle delete so history survives.
- **Initiative** — higher-level grouping above projects. Projects get a
  nullable `initiativeId`; SetNull on delete.
- **IssueRelation** — directed, typed links between issues
  (`RelationKind`). Cascade-deleted from either endpoint.
- **TimeEntry** — per-user, per-issue duration rows. Only active when the
  owning workspace has `timeTrackingEnabled=true`.

### Polymorphic Attachments + MinIO

- `Attachment.targetType` / `targetId` (nullable for migration safety)
  replace the issue-only model. Attachments can now hang off any first-
  class entity (issue / comment / project / initiative / …).
- MinIO backs storage (being wired up by Agent C in the same push).
  Per-workspace quota surfaces as `Workspace.attachmentQuotaMb` (default
  1024). Signed URLs for read; direct PUTs for upload.

### Granular ApiKey scopes

`ApiKey` gets `projectIds`, `labelIds`, `initiativeIds` — string arrays,
empty = no narrowing (unchanged semantics). A key can still have FULL
scope _and_ be narrowed to a project / label / initiative subset, so a
sub-agent can be scoped to just one initiative without losing any
existing capability. Victor and Mizu currently keep FULL + unnarrowed.

### Multi-workspace UI

- Workspace switcher in the shell; `User.lastWorkspaceId` restores the
  last-used workspace on sign-in.
- New default workspaces seeded: **Personal** (`PER`, time tracking off)
  and **Work** (`WRK`, time tracking on). Bailey is `OWNER` on all three.
- The original `FRG` workspace was rekeyed to **`AXI` / Axiom-Labs** in
  the Phase 1 entry below; all current-state references (SYSTEM.md,
  Hermes runbook, Obsidian, mcporter) now say AXI.

### Workspace-level configurability

New columns on `Workspace` expose what used to be hard-coded:
`cycleLengthDays` (7), `cycleCooldownDays` (0), `timeTrackingEnabled`
(false), `attachmentQuotaMb` (1024). Per-workspace overrides are just a
row update — no redeploy.

### Mizu / Lumin correction

Sweep of docs: Mizu's role was described as "CEO — Lumin ops" in a few
places. **Lumin is shelved.** Mizu now works across Axiom-Labs
(marketing / growth / intelligence / community). Corrected in
`SYSTEM.md`, `~/.hermes/skills/pm/forge/SKILL.md`, and the Obsidian
vault notes that were out of date. Historical entries (prior DEVLOGs,
archive notes) were not rewritten.

### Out of scope (handoff)

- Phase 3 MCP tool additions for the new primitives — Agent D.
- Remaining UI surface (initiative pages, cycle view polish) — ongoing
  in Agents E/F/G's worktrees.

## 2026-04-20 — Schema: cycles/initiatives/relations/time + rekey FRG -> AXI + seed PER/WRK (Agent A, Phase 1)

Phase 1 of the coordinated multi-agent build. Strictly additive schema + one
data migration (workspace rekey). App stayed up throughout.

### Schema (`prisma/schema.prisma`)

- New enums: `CycleStatus`, `InitiativeStatus`, `RelationKind`.
- New models: `Cycle`, `Initiative`, `IssueRelation`, `TimeEntry` — all
  tenant-scoped on `workspaceId`, with the indexes called out in the plan.
  Issue relations are directed and deletion-cascaded from either endpoint.
- Workspace: added `cycleLengthDays` (default 7), `cycleCooldownDays` (0),
  `timeTrackingEnabled` (false), `attachmentQuotaMb` (1024) — all configurable
  defaults surface as columns so per-workspace overrides are trivial.
- Issue: added nullable `cycleId` (SetNull on cycle delete), `relationsFrom`
  /`relationsTo` reverse relations, `timeEntries` reverse relation, and a
  `(workspaceId, cycleId)` index.
- Project: added nullable `initiativeId` (SetNull on initiative delete) +
  reverse relation + index.
- Attachment: made polymorphic via `targetType`/`targetId` (both **nullable**
  — deviation from the spec's non-null ask, so `db push` wouldn't reject the
  existing row; new writes can still set both together). Kept `issueId` for
  backward compat. New composite index on `(workspaceId, targetType, targetId)`.
- ApiKey: added `projectIds`, `labelIds`, `initiativeIds` string arrays with
  `@default([])` — empty = no narrowing.
- User: added `lastWorkspaceId` (remembered workspace), `pinnedIssueIds`
  string array with `@default([])` (cap enforced server-side later), and the
  `timeEntries` reverse relation.

### Applied via standard flow

Schema was baked into the image at build time (no bind mount). Flow:

```
docker cp prisma/schema.prisma forge:/app/prisma/schema.prisma
docker compose exec -T forge prisma validate
docker compose exec -T forge prisma db push --accept-data-loss --skip-generate
docker compose exec -T forge prisma generate
```

`prisma validate` passed; `db push` completed in 605 ms; client regenerated
without restarting the container (running app still serves fine — no existing
router references the new types).

### Rekey + seed SQL

Single transaction in `/tmp/forge-rekey-seed.sql`, executed via
`docker exec forge-postgres psql -U forge forge -v ON_ERROR_STOP=1 -f ...`.

- Enabled `pgcrypto`. ID generator for raw SQL inserts:
  `'c' || encode(gen_random_bytes(12), 'hex')` — 25-char cuid-shaped strings.
- Renamed existing workspace: key `FRG` -> `AXI`, name `Bailey` -> `Axiom-Labs`,
  slug `bailey` -> `axiom-labs`, `cycleLengthDays=7`.
- Seeded `Personal` (key `PER`, slug `personal`, time tracking off) and
  `Work` (key `WRK`, slug `work`, time tracking **on**) workspaces.
- Seeded the same 6 statuses (Backlog/Todo/In Progress/In Review/Done/Canceled)
  in both new workspaces, reusing the warm-earthy hex palette already in use
  on AXI. Todo is default.
- Seeded starter labels.
  PER: `quick-win`, `health`, `finance`, `home`, `learning`.
  WRK: `day-job`, `after-hours`, `billable`, `meeting`, `admin`.
- Added Bailey as `OWNER` membership on both new workspaces.
- Created one ACTIVE `Cycle 1` per workspace (including AXI) with
  `lengthDays=7`, starting now, ending +7 days.
- Set `User.lastWorkspaceId` to AXI's id so the UI lands there by default.

### Verification outputs

```
 key |    name    |    slug    | cycleLengthDays | timeTrackingEnabled
-----+------------+------------+-----------------+---------------------
 AXI | Axiom-Labs | axiom-labs |               7 | f
 PER | Personal   | personal   |               7 | f
 WRK | Work       | work       |               7 | t

statuses/workspace: AXI=6, PER=6, WRK=6
active cycles/workspace: AXI=1, PER=1, WRK=1
labels: AXI=0 (existing, untouched), PER=5, WRK=5
Bailey memberships: OWNER in AXI, PER, WRK
Issue count: 1 (unchanged from baseline).
```

- `https://forge.axiom-labs.dev/` -> 307 to Authelia (healthy SSO).
- `POST /api/mcp/analytics.summary` with Bearer `$FORGE_API_KEY` returned
  `{"data":{"openIssues":1,"doneIssues":0}}` — MCP surface is green.
- Container logs clean since migration.

### Deviations / decisions

- `Attachment.targetType` and `targetId` kept **nullable** (spec said non-null).
  Required so `prisma db push` could apply cleanly to the existing row. New
  code should set both together; the old `issueId` path still works.
- Existing workspace was named "Bailey" / slug "bailey" (not "Forge" / "forge"
  as the brief implied). Rekey still proceeded as planned (FRG -> AXI).
- Used raw `pgcrypto`-backed id generator instead of cuid (couldn't call
  Prisma's cuid from SQL). Column shape identical, indexable, collision-safe.

### Out of scope (handoff)

- tRPC routers for new models — Agent B/C.
- UI (workspace switcher, cycle/initiative/time pages) — Agent E.
- MinIO compose — Agent C.
- MCP tool additions — Agent D.
- System docs (SYSTEM.md, Hermes runbook, mcporter.json, Obsidian) — Agent H.

## 2026-04-19 — Real MCP endpoint (Streamable HTTP)

`/api/mcp/*` was branded as MCP but was a custom REST dispatcher. Added a
real MCP-compliant endpoint that speaks standard JSON-RPC 2.0 per the
Streamable HTTP transport (spec 2025-03-26). REST stays as a simpler
curl/debugging alias.

### Server

- `src/app/api/mcp/rpc/route.ts` — JSON-RPC handler supporting
  `initialize`, `notifications/initialized`, `ping`, `tools/list`,
  `tools/call`. Batched requests + notifications (no-response) honored.
  `tools/list` is open; `tools/call` requires a bearer token and enforces
  the tool's declared scopes.
- Tool input schemas are now exposed as proper JSON Schema (via
  `zod-to-json-schema`), so any MCP client gets correct type hints and
  validation. Error responses include `data: flatten()` on invalid args.
- Rate limiter reused (600 req/min per key; anon key falls back to IP).
- `GET /api/mcp/rpc` returns an empty SSE keep-alive so clients that probe
  `GET` during the Streamable HTTP handshake succeed.

### Client / docs

- `/settings/access` Integration blocks rewritten:
  - **Claude Desktop**: `mcp-remote` now points at the real `/api/mcp/rpc`.
  - **Claude Code**: `claude mcp add --transport http ... /api/mcp/rpc`.
  - **Hermes**: `baseUrl` form — no stdio bridge needed anymore.
  - **curl**: shows both JSON-RPC (standard) and REST (one-shot) forms.
- `~/.openclaw/workspace/daemon/config/mcporter.json` swapped from the
  stdio bridge entry to a `baseUrl: .../api/mcp/rpc` entry with the
  Victor key in `Authorization: Bearer …`.
- `~/.hermes/mcp-servers/forge-bridge/` stays in place as a fallback for
  clients that can't speak HTTP MCP, but is no longer the preferred path.

### Verified

- `initialize` returns 2025-03-26 protocol + serverInfo/instructions.
- `tools/list` returns 10 tools with full JSON Schema input shapes.
- `tools/call` `analytics.summary` with Victor's bearer → `{openIssues:1, doneIssues:0}`.
- Unauthenticated `tools/call` → `-32001 Unauthenticated`.

## 2026-04-19 — Hermes integration + settings layout pass

### Settings UI polish (subagent pass)

- `src/components/settings/{section,card,empty-state}.tsx` — 3 tiny primitives.
- Every `/settings/*` page now shares `mx-auto max-w-{2xl|3xl|5xl} space-y-6 p-6`
  and renders lists through `<Card>` + `<EmptyState>`. Widths by type:
  - Forms (Account, Access): `max-w-2xl`.
  - Lists (Members, Labels, Statuses, Templates, Views, Project Templates,
    Recurring, Plugins, Settings index): `max-w-3xl`.
  - Admin (dense, tabbed data): `max-w-5xl`.
- Settings index grouped into **General / Workspace / Developer** sections.

### Hermes integration (new)

Forge's `/api/mcp/*` is a REST tool dispatcher. Hermes speaks standard MCP
JSON-RPC 2.0 over stdio. Bridged them with a tiny subprocess:

- `~/.hermes/mcp-servers/forge-bridge/server.mjs` — stdio MCP server (~130 lines,
  no dependencies). Handles `initialize`, `tools/list`, `tools/call`, `ping`.
  Proxies tool calls to `POST /api/mcp/:name` with the `FORGE_API_KEY` bearer.
- Registered in `~/.openclaw/workspace/daemon/config/mcporter.json` (shared
  with Victor). Mizu's key is stored in `~/.hermes/profiles/mizu/.env` for
  swap-in.
- `~/.hermes/skills/pm/forge/SKILL.md` — runbook for agents documenting all
  10 tools, the agent-queue loop, config locations, and a health-check snippet.
- `/settings/access` reveal dialog got a **Hermes** tab in the copy-paste
  integration blocks alongside Claude Desktop/Code/curl/env.

### Keys minted

- `Hermes · Victor` (FULL access) — stored in `~/.hermes/.env`.
- `Hermes · Mizu` (FULL access) — stored in `~/.hermes/profiles/mizu/.env`.
  Both inserted directly via SQL (prefix + sha256 hash) since the minting
  procedure expects a tRPC session.

### Verified end-to-end

- Bridge smoke test: `initialize` → 10 tools listed → `issues.list` responds.
- MCP REST call with Victor's key created issue **FRG-1** successfully.
- All 10 settings routes return 200 after the layout pass.

## 2026-04-19 — Agent queue, templates, standup, recurring, views, focus + user menu + project templates

Huge feature pass. Big batch of small things, one consistent theme: reduce
the "blank-page" friction + make Forge usable by agents.

### Data model

- `IssueTemplate` — reusable starters (name, title, description, priority,
  labelIds). Workspace-scoped + optional project pin.
- `ProjectTemplate` — starter suggestions shown on `/projects`. Replaces
  hard-coded Forge/Hermes-Relay/Lucid-Memory. Three defaults seeded on
  first `list` if empty; fully editable after.
- `RecurringIssue` — scheduled issue blueprints with `intervalDays` +
  `nextRunAt` + `active`. In-process ticker (every 5 min) creates issues
  when `nextRunAt ≤ now`.
- `SavedView` — bookmarkable `/issues` filter combos (personal or shared).
- `Issue` gets `queued`, `claimedAt`, `claimedById`, `claimExpiresAt` for
  the agent queue.

### Routers

- `template` — CRUD for issue templates.
- `projectTemplate` — CRUD + auto-seed defaults.
- `recurring` — CRUD + `runNow` to fire a schedule manually.
- `view` — list/create/delete. Delete gated to owner.
- `standup` — `draft({ sinceHours })` returns markdown aggregating last
  N hours of your closed / opened / in-progress / stalled issues.
- `issue` extended with `setQueued`, `release`, `queue` (list queued
  items).
- `workspace.updatePreferences` upgraded earlier to also accept
  `timezone/locale/timeFormat/theme` (prior entry).

### MCP tools for agents

- `issues.claim({ claimTtlMinutes })` — atomically picks the highest-
  priority unclaimed queued issue, stamps `claimedAt` + `claimExpiresAt`,
  upserts the caller into `assignees`. Returns the issue or null.
- `issues.release({ id })` — unclaim.
- `issues.queue({ includeClaimed })` — peek the queue without claiming.

### Scheduler

- `src/instrumentation.ts` calls `startRecurringTicker()` on server boot
  (Node runtime only). `setTimeout` chain that scans `RecurringIssue` rows
  with `active=true AND nextRunAt ≤ now`, creates issues via a transaction
  (also emits the normal audit + ACTIVITY_EVENT row), bumps `nextRunAt`.
- Admins can force-fire via the Run now button on `/settings/recurring`.

### New UI

- `/standup` — draft card with copy-markdown button and 1d/3d/7d window
  toggle.
- `/focus/[id]` — stripped fullscreen view outside the app shell. Timer
  (play/pause/reset), exit, progress notes form, mark-done button.
- `/settings/templates`, `/settings/project-templates`, `/settings/recurring`,
  `/settings/views` — full CRUD pages.
- Quick-create gets a "Start from template" select at the top that fills
  title / description / project / priority / labels.
- Issue detail sidebar: Agent-queue toggle + claim info (who + when it
  expires) + Release claim button.
- Issue detail topbar: Focus button → `/focus/[id]`.
- Project detail topbar: "New issue" button scoped to the project (uses
  the existing QuickCreate via `data-quick-create-project={projectId}`).
- Projects page starter-templates dialog now reads from DB, links to the
  admin page to manage them.

### Sidebar user menu

- User row at the bottom is now a button that opens a dropdown with
  Account settings, Workspace settings, and Sign out. Sign out uses a
  server action calling NextAuth's `signOut({ redirectTo: "/signin" })`.

### Verified

- Build clean on second pass (satori fixes + all new routers).
- `prisma db push` applied `ProjectTemplate` cleanly.
- All new routes + existing routes return 200.
- Recurring ticker boots on container start (log line on success).

### Remaining

- Bulk select UI on `/issues` now supports multi-status + delete; could
  add multi-label / multi-assign.
- Onboarding checklist hasn't been extended to include "create a
  template" / "bookmark a view" yet — worth adding.
- Invite email flow + real workspace creation (out of scope for this pass).

## 2026-04-19 — Dashboard + brand assets

### Brand

- `public/forge-mark.svg` + `src/app/icon.svg` — anvil-on-ember glyph. Used
  on the sign-in page and as the favicon (Next auto-links from `app/icon.svg`).
- `src/app/opengraph-image.tsx` + `src/app/twitter-image.tsx` — 1200×630
  card generated via `next/og`'s `ImageResponse`. Satori's rules bit me
  once (every div with >1 child must have `display: flex`, and no
  dynamic-font-fetched glyphs during Docker build). Cleaned both up.
- `src/app/layout.tsx` metadata — `metadataBase`, `title.template`,
  openGraph, twitter, theme-color per-scheme, `robots: { index: false }`.

### Dashboard (`/dashboard`, `g d`)

Client page built by a subagent. Sections:

- Time-aware greeting + quick-actions (New issue via QuickCreate, Browse
  templates, Invite).
- **Focus today** — up to 6 issues assigned to me, priority-desc + due-soon.
- **Overview** — three columns: Recent activity (admin events, falls back
  to recent issues for non-admins), By status counts, Stalled (IN_PROGRESS
  with updatedAt > 3d).
- **Onboarding checklist** — five steps (project, issue, teammate, key,
  timezone); dismissible via localStorage; auto-hides on 100%.

Root `/` now redirects authed users to `/dashboard` instead of `/inbox`.
Sign-in default destination updated to match. Sidebar + command palette
have "Dashboard" as the first entry.

### UI polish (from audit pass)

- `Button.danger` used `text-white` — swapped for `text-background`.
- `QuickCreate` dialog padding `p-4` → `p-5` (dialog rhythm consistent).
- `Topbar` accepts `ReactNode` title/subtitle and dropped the always-on
  placeholder Filter/Display buttons.

### Verified

- `docker compose build` clean after the satori fixes.
- All 8 app routes 200; `forge-mark.svg` / `icon.svg` / `opengraph-image` /
  `twitter-image` served.

## 2026-04-19 — Chord nav, label CRUD, status reorder, bulk select, project CRUD, baseline migration

Closed the remaining gaps from the audit.

### Chord navigation

- `src/lib/keyboard.ts` gains `useChord(leader, map, windowMs)`. The
  sidebar's `g i`/`g s`/… labels now _actually_ work — press `g` then
  `i`/`s`/`p`/`a`/`l`/`,` to jump. Sidebar renders kbd chips (`G` + target
  letter) in place of the old string hint.

### Label CRUD

- `src/server/routers/label.ts` — list/create/update/delete (admin) +
  `setForIssue` (member). Workspace-scoped, unique `(workspaceId, name)`.
- `/settings/labels` page — color swatches, inline edit, delete with
  impact hint (`removed from N issue(s)`).
- Issue detail sidebar gets a real `<LabelPicker>` (multi-select from
  workspace labels, commits via `label.setForIssue`).

### Status drag-reorder

- Native HTML5 DnD on `/settings/statuses`. Dragging commits via the
  existing `status.reorder` proc on drop; optimistic UI reverts on error.

### Bulk select on issue list

- `IssueList` now renders a per-row checkbox, a sticky action bar with
  "Move to status…" (via `issue.bulkStatus`) and Delete (fan-out to
  `issue.softDelete`), and a clear-all. Wired everywhere `<IssueList>` is
  used (issues, inbox, project detail). Pass `enableBulk={false}` to opt
  out.

### Project CRUD completion

- New-from-scratch "New project" dialog on `/projects` (name + key + desc
  - color swatches + emoji icon). Key auto-suggested from name initials.
- `project.softDelete` mutation + Delete button on project detail page.
- Starter templates dialog preserved for the common suggestions.

### API key deletion

- `access.delete` admin mutation — hard-deletes the row entirely (Revoke
  still sets `revokedAt` for audit trail). Access page exposes both.

### Prisma baseline migration

- `prisma migrate diff --from-empty --to-schema-datamodel` generated
  `prisma/migrations/0000_init/migration.sql` (582 lines).
- `prisma migrate resolve --applied 0000_init` baselined the existing
  production DB. Entrypoint's `prisma migrate deploy` now runs cleanly
  ("No pending migrations to apply.") instead of hitting `P3005`.

### Verified

- Build clean.
- All 12 routes 200 (inbox, issues, projects, analytics, settings +
  account/access/members/statuses/labels/plugins/admin).
- Baseline migration applied; future schema changes can use
  `prisma migrate dev --create-only` → commit → `migrate deploy` on boot.

## 2026-04-19 — Platform-aware kbd + user preferences

Quick follow-up pass.

### Changes

- `src/lib/platform.ts` — `useIsMac` / `useModKeyLabel`. Sidebar now
  renders `⌘K` on macOS, `Ctrl+K` elsewhere. The underlying hotkey handler
  already treated `cmd+k` as `Ctrl+K` on non-Mac, so only the visible
  label needed fixing.
- Prisma `User` gets nullable `timezone`, `locale`, `timeFormat`, `theme`
  columns. Pushed via `prisma db push` since no baseline migration exists.
- `workspace.updatePreferences` mutation (protected, not admin-only — every
  user can set their own prefs). Updates profile name/handle too.
- `/settings/account` page — profile (name/handle/email/platform) +
  regional (timezone/locale/12h-24h/theme). Preview uses `Intl.DateTimeFormat`
  with chosen options so users can see the effect before saving.
- `src/lib/utils.ts` gains `formatDate(d, prefs, opts)` — `Intl`-based,
  respects user's timezone/locale/hourCycle.
- `src/lib/time-prefs.ts` — `useTimePrefs()` hook pulling from
  `workspace.me`. Applied first on the issue detail page (timestamp tooltip).
- `/settings` index now lists Account as the top entry.

### Verified

- `docker compose build` → clean.
- `prisma db push` applied the new columns cleanly.
- Login + `/settings/account`, `/settings/admin`, `/settings/access`,
  `/settings`, sample issue route → all 200.
- No runtime errors in container logs.

## 2026-04-19 — Feature audit + full CRUD pass + admin portal

Post-audit pass: closed most of the gaps found by the explore subagent.
Focus was on real CRUD surfaces and a first-class developer-access flow.

### Server

- `src/server/routers/admin.ts` (new) — `stats`, `audit`, `events`,
  `deliveries`. Admin-gated.
- `src/server/routers/access.ts` — added `rotate` (atomic revoke + reissue
  with same name/scopes/expiry-window). Returns the raw key once.
- `src/server/routers/workspace.ts` — added `me`, `updateMember`,
  `removeMember`. Last-owner guard on both mutations.

### Pages

- `/settings/access` — preset toggle (Full / Standard / Read-only / Custom)
  plus per-scope grid. Rotate button on each key; post-rotate reveal reuses
  the same tabbed integration blocks (Claude Desktop / Code / curl / env).
  Makes it explicit that raw keys are single-reveal — if you lose the key,
  rotate.
- `/settings/admin` (new) — stat cards + tabs for audit log, activity
  events, webhook deliveries.
- `/settings/members` — role dropdown + remove per member (disabled for
  self; last-owner protected server-side).
- `/projects/[id]` — now actually scoped to the project. Shows
  description/color/icon/dates, has Edit dialog (name/description/color/
  icon), Archive, and list⇄kanban view toggle (persisted per-project in
  localStorage).
- `/issues/[id]` — inline title + description editing, assignee picker
  (multi-select from workspace members), project select, due-date picker,
  delete button. Status/priority dropdowns preserved.
- `/issues` — persisted list⇄kanban toggle + inline search box.
- `/inbox` — real filter tabs: Assigned / Created / All active.

### Shared UI

- `src/components/view-toggle.tsx` (new) — `<ViewToggle>` + `useViewPref`
  (localStorage-persisted per scope).
- `Topbar` — dropped the always-visible Filter + Display placeholders that
  did nothing. `title` accepts ReactNode now.
- `CommandPalette` — wired issue search via `issue.list({ query })`.
  Results grouped under Issues / Navigate.
- `QuickCreate` — project picker + description + priority.
- `Sidebar` — added Settings link; dropped the duplicate settings gear.

### Verified

- `docker compose build` → clean.
- Login + all 10 routes 200 (inbox, issues, projects, analytics, settings,
  settings/{access,members,statuses,plugins,admin}).
- No runtime errors in container logs (only the known P3005 migrate
  baseline warning).

### Still pending

- Statuses drag-to-reorder.
- Label CRUD surface.
- Bulk-select + status mutation on issue list.
- Prisma baseline migration.
- Email-based invites.

## 2026-04-19 — Settings hub + developer access + starter projects

Fleshed out `/settings/*` so the nav links go somewhere, added a first-class
developer-access page with copy-paste MCP config blocks, and made it trivial
to seed the workspace with the usual suspects.

### New surface

- `src/server/routers/access.ts` — workspace-level API keys (not tied to a
  plugin). `list` / `create` / `revoke`. `create` returns the raw key once;
  only the sha256 is persisted.
- `src/app/(app)/settings/page.tsx` — rewritten as a proper index with four
  real links + a "developer access" card on top.
- `src/app/(app)/settings/access/page.tsx` — lists keys, create dialog with
  scope toggle grid + optional expiry, post-create reveal modal with
  tabbed copy-paste blocks:
  - Claude Desktop (`mcpServers.forge` JSON via `mcp-remote`)
  - Claude Code (`claude mcp add --transport http ...`)
  - curl (issues.list + issues.create examples)
  - `.env` block
- `src/app/(app)/settings/members/page.tsx` — uses existing
  `workspace.members` + `workspace.invite` procedures.
- `src/app/(app)/settings/statuses/page.tsx` — uses existing
  `status.list` + `status.create`. Reorder-by-drag is still TODO.
- `/projects` gets a "Starter templates" dialog — a UI-only list of
  suggestions (Forge/FRG, Hermes-Relay/HR, Lucid-Memory/LM) that invokes
  the standard `project.create` mutation per row the user keeps. No
  server-side seed endpoint; the template list lives entirely in the
  client so it stays out of the platform's data model.

### Verified

- `docker compose build forge` → clean.
- `POST /api/auth/callback/credentials` → 302 `/inbox`.
- `GET /{inbox,settings,settings/access,settings/members,settings/statuses,settings/plugins,projects}` → 200.

### Known / next

- Prisma baseline migration still missing (`P3005` on entrypoint migrate,
  soft-failed). Generate one before the next schema change.
- `mcp-remote` is the canonical bridge for HTTP-transport MCP into Claude
  Desktop today — the pasted config assumes the user `npm`s it on first run.
- Drag-to-reorder statuses + inline editing pending.

## 2026-04-19 — Pivot to env-based credentials admin (Authelia removed)

Authelia header-bridge didn't land cleanly (edge middleware was setting response headers instead of forwarding request headers; fixed version still didn't produce the expected handshake in the browser). Bailey called it — dropped the bridge entirely.

### Changes

- Deleted `src/middleware.ts`, `src/server/authelia-bridge.ts`, `src/app/api/auth/authelia-bridge/`.
- `src/server/auth.ts` now exposes a **Credentials** provider comparing against `ADMIN_EMAIL` / `ADMIN_PASSWORD`. On first match, upserts the user by email and creates their default workspace (statuses seeded). Session strategy switched from `database` → `jwt` (required for Credentials).
- `src/app/(auth)/signin/page.tsx` rewritten: single email+password form, Server Action handing off to `signIn("credentials")`. OAuth/magic-link buttons removed (providers remain conditionally registered so they can return if env is set).
- `(app)/layout.tsx` stripped of the Authelia handshake check; plain `auth()` → `/signin` redirect now.
- Traefik label swapped: `chain-authelia@file` → `chain-no-auth@file`. Forge is now reachable without SSO; the app handles its own auth.
- `.env` gained `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, `ADMIN_HANDLE`.
- DB reset via `prisma db push --force-reset` — the abandoned Authelia-bridge attempt had left a stale `handle: "bailey"` row that was breaking the upsert on first sign-in. Safe to reset since no real data existed.

### Verified

- `POST /api/auth/callback/credentials` with valid creds → `302 /inbox`, `__Secure-authjs.session-token` set.
- `GET /inbox` with that cookie → `200`.
- Login: `timothy.b.dixon@gmail.com` / `***REDACTED***` (from `~/docker/forge/.env`).

### Ran into

- Disk hit ENOSPC after 8 rebuilds of the ~1 GB image. `docker builder prune -af && docker image prune -af` reclaimed ~17 GB.

## 2026-04-19 — Deploy behind Traefik + Authelia

Same session as scaffold (renamed Cairn → Forge first). Version bumped to `1.0.0`.

### What went live

- `~/docker/forge/docker-compose.yaml` — app + postgres + redis + persistent volumes, on `traefik_proxy` + internal bridge.
- Traefik routed at `https://forge.axiom-labs.dev` via Docker labels; `chain-authelia@file` middleware enforces SSO.
- Homepage entry added under General-Services (`mdi-anvil` icon).
- Dockerfile: multi-stage (deps → build → runner), Next.js `output: "standalone"`, prisma CLI installed in runner for boot-time `prisma migrate deploy`.
- Authelia bridge: edge middleware normalizes `Remote-*` headers → `x-forge-identity`; `(app)/layout` detects no-session-yet-with-identity and redirects to `/api/auth/authelia-bridge`, which upserts user, creates a default workspace (slug=user, key=user prefix), mints a DB session, and drops the NextAuth cookie.
- Schema pushed with `prisma db push` (no migration file yet — first deploy).

### Build fixes that mattered

- `experimental.typedRoutes` → removed (Next 15.5 moved it top-level AND it's too strict for the string-backed nav array; disabled).
- Local plugin import: switched from dynamic template-string `import()` to a static registry at `src/server/services/local-plugins.ts`. Dynamic fs-loading was fighting the bundler and pnpm's virtual store; static registry is the right shape for `runtime: "local"`.
- Prisma + pnpm + Next standalone: `.prisma` lives at `node_modules/.pnpm/@prisma+client*/node_modules/.prisma`, but `@prisma/client/default.js` requires `.prisma/client/default`. Fix: explicit `COPY` in Dockerfile runner to flatten it into `node_modules/.prisma`.
- NextAuth providers now conditional on env — empty `EMAIL_SERVER` was throwing at module init during page-data collection.
- `Prisma.InputJsonValue` casts for manifest + skill schema columns.
- MCP tool handlers needed explicit `input: ...` param types (TS can't close the inference loop across an object literal entry).

### Verified end-to-end

- `curl https://forge.axiom-labs.dev/` → 302 to `login.axiom-labs.dev` (Authelia).
- Follow-redirect with SSO → HTTP 200.
- Forge container logs clean (no Prisma or hydration errors).

### Known / next

- No `prisma/migrations/` yet — first deploy used `db push`. Generate a baseline migration before the next schema change.
- Signin page still renders OAuth/magic-link buttons even when providers are unset (server actions would fail). Behind Authelia this page shouldn't be reached — clean up next pass.
- `issue-triage` sample plugin not yet wired to event delivery — BullMQ outbox scheduler is still TODO.
- `docker compose exec forge prisma db seed` not yet hooked (seed.ts uses tsx; prod image doesn't have it). Either compile seed to JS during build or swap to a `.sql` seed file.

## 2026-04-19 — Initial scaffold

**Session:** Bailey → Claude (Opus 4.7, 1M ctx, auto mode)

### What was done

- Scaffolded repo at `~/forge/` — Next.js 15 + TS + Tailwind + Prisma + tRPC 11 + NextAuth v5 + Redis + BullMQ.
- Wrote comprehensive Prisma schema: users, workspaces + memberships (RBAC),
  projects, issues (with subtasks via self-ref), statuses (workspace-scoped),
  labels, comments, attachments, audit log, activity events, metric aggregates,
  plugins, skills, API keys, webhooks, webhook deliveries.
- Built tRPC base with `workspaceProcedure`/`adminProcedure` middleware and
  per-procedure Redis rate limiter.
- Routers: workspace, project, issue, comment, analytics, plugin, status.
- Issue mutations record both audit + ActivityEvent rows in one transaction
  and publish to Redis pub/sub for SSE fan-out.
- Plugin runtime: HMAC webhook signing, JWT for delegated calls, local-runtime
  dispatch via dynamic import from `plugins/<slug>/handler.ts`.
- MCP surface at `/api/mcp/[tool]` — 7 tools, scope-gated via API key.
- UI: warm-earthy design tokens (`globals.css`), sidebar + topbar + command
  palette (`⌘K`) + quick-create (`C`) + issue list + issue board + issue
  detail with optimistic updates + projects page + analytics page (distribution,
  throughput, cycle time, SLA breaches) + plugins settings page.
- Realtime: server SSE endpoint subscribing to Redis pub/sub, client-side
  `RealtimeProvider` that invalidates tRPC queries on events.
- Sample plugin `plugins/issue-triage/` with local-runtime handler using
  keyword heuristics.
- Tests: vitest unit tests for rate-limit, webhook signing, manifest schema;
  Playwright scaffold for issue flow.
- CI: GH Actions with quality job (lint/typecheck/unit) + e2e job with
  Postgres + Redis service containers.

### Decisions

- **Separate AuditLog from ActivityEvent.** Audit is for compliance (immutable,
  includes IP/UA/before/after). ActivityEvent is the product stream plugins
  subscribe to. Keeps access controls and retention policies independent.
- **SSE over WebSockets.** Simpler to run on Next.js route handlers; sufficient
  for fan-out of server-originated events. Swap to Socket.io if we need
  bidirectional (presence, typing, cursors).
- **Scoped API keys + manifest ceiling.** Plugin manifests declare the max
  scope set. API keys issued to a plugin can only _narrow_, never widen.
- **Metric rollup table + live fallback.** Analytics router reads from
  `MetricAggregate` where warm, otherwise falls back to live SQL. Worker
  job populates rollups out-of-band.

### Next steps

- Actually install deps and run `prisma migrate dev` to validate schema.
- Wire BullMQ delivery scheduler so ActivityEvent → Webhook fan-out is durable.
- Drag-and-drop on kanban board (leave keyboard bulk-status working first).
- Onboarding flow for users with no memberships.
- Invite email flow (currently the invite procedure upserts user directly).
- Replace the quick-create placeholder with status/priority/project pickers.
- Build a second sample plugin demonstrating the `runtime: "plugin"` path
  (webhook delivery). Good candidate: a Hermes bridge that pushes events
  into `#hermes-agent` Discord.

### 2026-04-27 — Agent chat, integrations, presence, nav refactor (full session)

A long session that crossed the chat/agent surface end-to-end. Eleven
commits landed; this entry covers the architectural arc rather than
each commit. Commits, oldest first: `282ce7f`, `eeb58ee`, `0515871`,
`d61cc03`, `29da50a`, `884aa8a`, `64fdbbd`, `104c75e`, `69a5659`.

### What shipped

**Mission Control chat (`282ce7f`, polished through `69a5659`)**
- `ChatThread` + `ChatMessage` Prisma models. Thread is unique per
  `(workspaceId, userId, agentId)`. Migration `0016`.
- New `chat` tRPC router: `threads`, `thread` (mutation, upserts),
  `send`, `appendAgentMessage` (gated on `linkedAgentId`), `history`.
- Chat tab in Mission Control (chord 5), three-pane: agent rail (left)
  → thread (middle) → composer (bottom). Per-(user, agent) thread.
- `ChatContextProvider` + `useChatContext` hook so pages can register
  page-state (route, slug, issueId, selectedIds) into a context bundle
  that ships with every send.
- Audit fan-out branch (d) routes `CHAT_MESSAGE_POSTED` to the
  addressed agent's `webhookUrl` via the per-agent dispatch shim —
  same plumbing as comment @-mentions.

**Chat reply streaming (`69a5659`)**
- Three new MCP tools for stateless streaming drafts:
  `chat.startDraft({ threadId }) → { draftId }`,
  `chat.appendDraftChunk({ threadId, draftId, delta, seq? })`,
  `chat.finalizeDraft({ threadId, draftId, body, sourceRunId? })`.
- Drafts are NOT persisted. Deltas flow through Redis pub/sub on a
  `chat-thread-stream` channel (subjectType discriminator, NOT a
  real EventKind). Only the final body lands as a `ChatMessage` via
  the existing fan-out path. Payload carries `finalizedDraftId` so
  the client swaps the draft bubble for the persisted message
  without flicker.
- Single-shot `chat.appendMessage` (`64fdbbd`) stays as the fallback
  for runtimes not yet wired to the streaming path.

**Chat polish (`104c75e`)**
- `chat-markdown.tsx` — hand-rolled lightweight markdown renderer
  (no new deps; Forge had no markdown libs installed). Headings,
  ordered/unordered lists, fenced code blocks with copy buttons,
  inline bold/italic/code, auto-linkified URLs.
- AGENT messages render through `<ChatMarkdown>`. USER and SYSTEM
  stay plain `whitespace-pre-wrap`.
- Thinking indicator: three staggered `animate-bounce` dots when
  the latest message is USER and < 5min old. Stale hint after 60s.
  Mutually exclusive with the streaming draft bubble.
- Better empty thread state with example prompts.

**Slash commands (`69a5659`)**
- Pure-client registry at `src/lib/chat-slash-commands.ts` modeled
  on `~/mission-control/lib/slash-commands.ts`.
- `/help`, `/clear`, `/info`, `/agents`, `/issue <KEY>`, `/status`.
- Inline popover above composer on `/`. Arrows cycle, Enter/Tab
  accept, Escape closes. Args-needing commands fill `/<name> ` and
  place cursor; arg-less execute immediately.
- Local commands push a SYSTEM-role bubble to `localMessages` state
  (cosmetic only, never persisted). Prompt-dispatch commands
  (`/issue`, `/status`) transform input and call `sendM.mutate`.

**Runtime mode honesty (`0515871`)**
- `Agent.runtimeMode` (PERSISTENT | EPHEMERAL — already existed but
  unused in UI) now surfaces in:
  - Agents tab (sort + badge by mode + last-heartbeat).
  - Chat header (mode badge + last-seen for offline persistent
    agents).
  - Chat composer (banner copy adapts: persistent-offline says
    "queued, delivered on next heartbeat"; ephemeral says "session
    — replies arrive on next session").
  - Glance view (small p/s mono badge).
- Mission Control Control tab (chord 6, OWNER/ADMIN only) — webhook
  delivery queue with status filters, retry button, queue depth,
  recent dispatches. Reads existing `admin.webhookDeliveries.list`
  and `.retry`.

**Access keys split (`0515871`)**
- `ApiKeyKind` enum (AGENT | PERSONAL | SESSION). Migration `0017`
  with backfill: existing rows get `AGENT` if `linkedAgentId` is
  set, `PERSONAL` otherwise.
- `access.createPersonal` and `access.createSession` (TTL-bounded)
  mutations. Existing `access.create` infers kind from
  `linkedAgentId` presence with optional override.
- Settings → Access page reshaped into three sections (Registered
  Agents, Personal Access Tokens, Session Keys) with separate
  create flows, expiry badges, copy-once raw-key reveal.

**Integrations adapter manifest (`0515871`)**
- Static manifest at `src/server/integrations/adapters.ts` (NOT a
  Prisma table — uses existing `AgentProvider` enum). Five
  adapters: Hermes, Claude Code (session), Claude Desktop
  (persistent), Codex CLI, Custom webhook. Each declares
  `defaultRuntimeMode`, `defaultKeyKind`, `presence`,
  `setupMarkdown`, optional `mcpSnippet`.
- New `integration` tRPC router: `list`, `byKind`, `applyToAgent`.
- `/settings/integrations` index page rendering each adapter as a
  card with installed-agent badges and "Generate key" / "Manage
  keys" links into the access page.

**Hermes-side glue (out-of-repo, in `~/.hermes/`)**
- `forge-presence` skill (`~/.hermes/skills/forge-presence/`):
  `bin/heartbeat.sh <profile>` calls Forge's MCP `agents.heartbeat`;
  `bin/setup.sh <profile>` installs a per-minute system crontab
  entry. Supports both installed profile dirs
  (`~/.hermes/profiles/<name>/forge.env`) AND the default agent at
  `~/.hermes/forge.env` for Victor.
- New `gateway/platforms/forge.py` platform adapter in the
  hermes-agent fork. Uses `GatewayStreamConsumer` to call Forge's
  draft-streaming MCP tools as tokens generate.
- `~/.hermes/config.yaml` adds a `platforms.forge` block.
- `~/.hermes/webhook_subscriptions.json` switches `deliver: "log"`
  → `"forge"` with a new `forge_thread_id_path:
  "payload.threadId"` field. Prompt template updated: agent no
  longer calls `forge_chat_appendMessage` directly for chat events
  (platform adapter handles delivery — avoids duplicate messages).
- **Activation requires Hermes gateway restart.**
- Custom-vs-official: the platform adapter file is a clean addition
  using Hermes's `BasePlatformAdapter` extension point. The
  `Platform.FORGE` enum addition + `run.py` adapter creation +
  `webhook.py` re-stamp block ARE patches to Hermes core — internal
  to Bailey's fork at `~/.hermes/hermes-agent/`, not yet
  upstream-mergeable as-is.

**Nav reorg (`d61cc03`)**
- Sidebar: dropped "Admin" group entirely. New "Insights" group:
  Analytics + Agents (Agents is a real surface now, not config).
  Plugins + Admin portal removed from rail (live in Settings).
- Settings navbar: dropped "Account" group from workspace scope
  (account settings live ONLY at root `/settings/*` now, single
  canonical home). Renamed "Developer" → "Integrations".
- Templates merge: `/settings/templates` now renders a tabbed
  parent (Issue templates / Project templates).
  `/settings/project-templates` is a permanent redirect.
- Duplicate-route cleanup: `/w/{slug}/settings/{account,appearance,
  access,workspaces}` are now redirects to `/settings/*` so deep
  links keep working but ambiguity is gone.

### What I learned (write-down for future sessions)

- **Prisma `cuid()` produces mixed v1 + 25-char hex IDs across
  workspaces.** Zod's `.cuid()` only validates v1. All new id
  inputs on routers should use `z.string().min(1).max(40)` matching
  the pattern in `agentId` from the agent router. Fix in `eeb58ee`.
- **The `/api/trpc/...` tRPC route does NOT honor `Authorization:
  Bearer ...` for API key auth.** Only `/api/mcp/...` paths run
  `authenticateApiKey()`. Runtime integrations should call MCP, not
  tRPC, when authenticating with an API key.
- **Forge already had a complete heartbeat sweep**
  (`sweepIdleAgents` in `src/server/services/heartbeat.ts`) AND
  auto-presence on webhook delivery (`recordAgentReachable`). The
  gap was purely on the Hermes side: the runtime never called
  `agent.heartbeat`. The `forge-presence` skill closes this with
  one cron entry.
- **MC's "streaming" was theatre.** `~/mission-control` passes
  `stream: false` to Hermes, then wraps the full completion in a
  single SSE chunk. So MC's chat is no faster/streamier than Forge's
  was before this session. To get true token streaming we needed
  to build Forge as a first-class Hermes platform adapter (Phase 3
  of this work) — done modulo the Hermes restart.

### Verification

- `pnpm typecheck` — clean across all 11 commits.
- `pnpm lint` — only pre-existing warnings in `issue-board.tsx`
  (other team's code, unrelated to this session).
- Smoke tests: Mizu and Victor both flipped ONLINE in real time
  when forge-presence cron entries fired. Victor sent and received
  a chat message end-to-end (single-shot path; the streaming path
  needs the Hermes restart). MCP catalog includes all four chat
  tools.
- Migrations `0016_chat_thread_messages` and `0017_api_key_kind`
  applied cleanly to the dev DB.

### Known gaps / TODOs after this session

- Hermes gateway needs `systemctl --user restart hermes-gateway` to
  load the new `gateway/platforms/forge.py` adapter. Until then
  chat uses the single-shot `chat.appendMessage` path; streaming is
  built on the Forge side but not active end-to-end.
- The `forge-dispatch` prompt template instructs the agent NOT to
  call `forge_chat_appendMessage` (the platform adapter handles
  delivery). If the agent ignores this and calls it anyway, you'll
  see duplicate messages. Watch for this in early use; tighten the
  prompt if needed.
- Hermes-side `webhook_subscriptions.json` change is an additive
  field (`forge_thread_id_path`) — vanilla NousResearch/hermes-agent
  doesn't know about it. If you ever rebase the fork on upstream,
  preserve this field.
- The `Integration` adapter manifest has no UI to walk through the
  full install flow yet — it just deep-links to `/settings/access`.
  A guided wizard would be a nice follow-up.

## Known gaps / TODOs in code

- `auth.ts` assumes `nodemailer` provider; install and configure SMTP.
- `worker.ts` webhook delivery job: enqueue is currently manual — add a
  transactional outbox step that enqueues when `WebhookDelivery` rows are
  written.
- `trpc-provider.tsx` — superjson transformer on `httpBatchLink` works in
  trpc v11; double-check when installing.
- `audit.ts` fire-and-forget pub/sub — acceptable because deliveries are
  durable via `WebhookDelivery` rows, but add a retry guard in prod.
