# Changelog

All notable changes to Forge are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and dates use
ISO-8601.

The dashboard's **What's New** rail reads this file at request time
(cached by mtime in process memory) and surfaces the most recent
entries. Keep entries terse — one line per item under each version
date, grouped by `Added` / `Changed` / `Fixed` / `Removed`.

## [Unreleased]

## [2026-05-24] — Agent runtimes & chat clarity

### Added

- **Codex as a first-class agent** — connect a Codex *app server* as a
  managed runtime and chat with a Codex agent that answers as itself, the
  same way Hermes agents do.
- **Local agent sessions over ACP** — drive a local CLI (Claude Code,
  Codex, OpenCode) as a live agent via the Agent Client Protocol, run by
  the `forge` daemon.
- **Model credentials in Settings → Workspace → AI** — store an
  OpenAI / Anthropic / custom chat-model key (encrypted) so the Streaming
  engine works without environment variables.
- **"Verify connection"** in the agent editor — confirms an agent can
  actually chat (and probes the runtime endpoint) before you rely on it.
- **Fleet-setup checklist** on Settings → Agents — runtime → agent → key →
  chat-ready, at a glance.
- **About / build line** on the Settings page showing the running version,
  release date, and build, plus a "What's new" link.

### Changed

- **Integrations page** now groups every connector by tier — first-class
  managed runtimes, session CLIs, and basic webhooks — with clear
  transport and chat badges.
- **Chat now shows how each agent is served** — a transport chip (Hermes,
  Codex app server, ACP session, local daemon, or streaming) in the chat
  header, Mission Control, and the status rail, so you always know where a
  reply comes from. Slash commands adapt to the agent (e.g. Hermes-only
  commands are hidden elsewhere; a new `/runtime` shows the chat path).
- **Agent detail page** gained a Connection card (transport, runtime
  adapter, disabled state, and a Verify-connection button); dispatch-only
  cards (webhook health, heartbeat) are hidden for agents that don't use
  them, so the page fits the agent.

### Fixed

- **Managed-runtime agents no longer show a false "offline."** An agent
  reached on demand (Codex app server, a streaming model, or a daemon)
  now reads **"on-demand"** consistently across chat, Mission Control, and
  Settings → Agents — it connects when you message it — instead of a
  permanent offline that only applied to heartbeat agents like Hermes.
- **On-demand agents can be auto-assigned work again.** Auto-dispatch no
  longer skips an agent just because it's "offline" by heartbeat (which an
  on-demand agent always is), so Codex/app-server agents are eligible for
  round-robin / capability / priority assignment. Disabled runtimes are
  skipped up front.
- **A Codex app-server agent can now be set to persistent.** Settings →
  Agents previously forced Codex (and Claude) to single-session and blocked
  the persistent option — so a Codex agent stayed single-session and read
  "offline" everywhere despite the on-demand work above. You can now choose
  **Persistent** for a Codex agent attached to the Codex app-server runtime,
  and it shows **"on-demand."**

## [2026-05-23] — Sign-in, SSO & agent platforms

### Added

- **New sign-in experience** with a refreshed split layout.
- **Single sign-on (SSO)** — admins can enable and manage OIDC providers
  (Authelia and other self-hosted IdPs) plus GitHub / Google from
  Settings → Auth.

### Changed

- **Agents answer on the right platform.** A configured agent no longer
  silently falls back to another provider — if its chat backend isn't set
  up, you get a clear "no chat model configured" notice instead of a reply
  from the wrong platform.

### Fixed

- Chat replies no longer occasionally show an empty agent bubble.
- An error notice in chat now stays visible until you retry or send again,
  instead of disappearing on its own.
- Smoother animated backgrounds (sign-in and dashboard) — no more stutter.
- Navbar account menu items are all clickable again; Mission Control's
  History heatmap fits its column width.

## [2026-05-21] — Customizable dashboard

### Added

- **Customize your dashboard** — a "Customize" toggle lets you drag to
  reorder the dashboard's widgets and hide ones you don't use; the
  layout is saved to your account. Reset returns to the default.
- **"Pick up where you left off"** — a dashboard tile surfacing the
  issues, projects, and other items you most recently opened.
- **What's New "unseen" dot** — the What's New tile flags when there
  are changes you haven't read yet, and clears once you open the full
  page.

### Changed

- **Smarter dashboard greeting** — "Browse templates" becomes "New
  project" once you have projects, and "Invite member" only shows for
  admins.
- **Dashboard ↔ canvas round-trip** — your personal canvas now has a
  "Dashboard" button to get back, matching the dashboard's view toggle.

## [2026-05-21] — Canvas motion overhaul + issues-page polish

### Added

- **Canvas present mode** — turn frames into slides with eased
  fit-to-frame, a laser pointer with trail, and arrow / space / Esc /
  Home / End navigation.
- **Images on canvas** — paste, drag-drop, or pick a file to drop an
  image onto the board; backed by the attachment system.
- **Canvas drawing polish** — diamond shape, hand-drawn "sketch"
  rendering, five arrowhead styles (either end), fill color, and an
  adjustable corner radius.
- **Agent profile icons in comments** — agent replies now show the
  agent's own avatar instead of a generic bot glyph.
- **Issue hover previews** — hover an issue title in the list to peek
  status, priority, project, and assignees.
- **Snooze indicator** — snoozed issues now show a "Snoozed" chip in
  the list.

### Changed

- **Smoother canvas camera** — fit / reset / present transitions ease
  instead of snapping, pan carries inertial momentum, and remote
  cursors glide to their positions.
- **Composer discoverability** — the comment and chat composers now
  advertise @-mentions and `/` commands (placeholder + a persistent
  hint).
- **Debounced issues search** — searches settle for 300ms (with an
  in-input spinner) instead of firing on every keystroke.
- **Broader canvas undo/redo** — now covers create + delete for every
  element type, not just moves.

### Removed

- **Duplicate "Personal" sidebar item** — the personal canvas is now
  reached from the Dashboard's List / Canvas view toggle.

## [2026-05-20] — Orchestration loop, on-canvas authoring, crews

### Added

- **Goals → plans → execution** — define a Goal, auto-decompose it into
  an execution plan, and have steps dispatched, judged, and retried
  automatically within cost / time budgets.
- **On-canvas authoring** — create issues and notes directly on a
  canvas, with smart alignment guides, a floating selection inspector,
  and sticky-note / comment-pin / stamp primitives.
- **Agent crews** — group agents into crews with per-member roles.

### Changed

- **Faster nested-frame canvas drags** — the frame drag cascade is now
  linear in descendants.

## [2026-05-19] — Chat streaming + safer destructive actions

### Added

- **Streaming agent chat replies** — agent responses now stream
  token-by-token in the chat surface.
- **Canvas entity hover previews** — hover linked issues / notes on a
  canvas for a quick summary.

### Changed

- **Confirm modals** guard destructive actions; canvas render
  performance improvements.

## [2026-05-18] — First-class Chat workspace

### Added

- **Chat surface** — a dedicated per-agent chat workspace with file
  attachments and rich markdown rendering.

## [2026-05-04] — Pomodoro, email-ingest, today widget, what's new

### Added

- **Today widget** on the dashboard — active-sprint countdown,
  next-7-day due-soon list (max 5), Mon–Sun week peek strip.
- **What's New rail** + `/w/[slug]/whats-new` page sourcing this
  CHANGELOG via the `system.changelog` tRPC proc.
- **Quick-save filter as view** — the `/issues` saved-view bar now
  surfaces an inline "Save changes" / "New view" pair when the
  current filters match an existing view, plus the standard
  "Save view" when they don't.
- **Pomodoro break prompts** — opt-in toggle on `/settings/account`;
  when a timer runs and the toggle is on, the time-tracker fires a
  toast at the configured cadence (default 25 / 5 minutes).
- **Email-to-issue ingest** — `/api/ingest/email` accepts HMAC-signed
  JSON and creates an issue (+ optional attachments). Endpoint is
  off by default; admins enable + rotate the secret in
  `/settings/integrations`. No upstream provider wiring yet.

## [2026-05-04] — Watch, journal, slash commands

### Added

- `IssueWatcher` model + `issue.watch / unwatch / watchers / watching`
  tRPC + matching MCP tools.
- Daily Journal as a Note variant (`Note.kind = JOURNAL`, unique per
  user/date) with `notes.todayJournal` / `notes.listJournal` MCP.
- Slash commands in QuickCreate + comment composers
  (`/assign /due /label /priority /project /watch /unwatch`) plus
  `issue.applyCommands` for after-the-fact application.

### Changed

- Inbox grew a Watching section between Snoozed and Sprint burn.

## [2026-05-03] — Quick Notes, attachments expansion

### Added

- Quick Notes widget on the dashboard with auto-save + ⌘⏎ shortcut.
- Expanded attachment MIME allowlist (HTML, CSV, XML, JSON, YAML,
  audio/video containers); external link attachments via
  `attachments.link`.

### Fixed

- Project page scroll containment regression.
- Per-agent dispatch shim no longer pages every workspace event.

## [2026-05-02] — UX revamp wave (overview → triage)

### Added

- Pinning on issues / projects / saved views (`Pin` table) and
  pinned-recents in the sidebar.
- Bulk-actions bar on `/issues` and a workspace-wide command
  palette.
- Inbox / Agents / Stalled surfaces gained dedicated revamps with
  tooltips and density-aware text utilities throughout.

## [2026-05-01] — Auto-transition on agent assignment

### Added

- `Workspace.startedStatusId` — server-side auto-transition into a
  configured IN_PROGRESS status when an agent is assigned.
- `statuses.list` MCP tool so daemons can resolve transitions
  client-side.

## [2026-04-28] — Agent awareness, runtime primitive, forge CLI

### Added

- 10 new MCP tools for agent awareness:
  `comments.list`, `chat.getThread`, `context.bundle`,
  `attachments.getInline`, and others.
- `Runtime` primitive (LOCAL_DAEMON / REMOTE_HTTP / CLOUD) plus
  token-usage columns on `AgentRun` and a unified agent-activity
  timeline.
- `forge` CLI + local daemon (`forge login / daemon / runtimes /
  agents / issues`) with a real Claude Code adapter.

## [2026-04-27] — Mission Control notifications

### Added

- Actionable Mission Control notifications and a tightened agent
  presence panel.

## [2026-04-26] — VitePress docs

### Added

- In-app docs viewer at `/w/[slug]/docs` plus the static
  VitePress site shipped at `/docs/`.

## [2026-04-25] — SLAs, watchdogs, push dispatch

### Added

- Required-ack window + per-issue SLA enforcement (workspace-level
  toggles + watchdog sweep).
- Push-dispatch model — webhooks from Forge to agent runtimes
  replaced the legacy heartbeat cron.
