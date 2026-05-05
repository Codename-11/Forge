# Changelog

All notable changes to Forge are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and dates use
ISO-8601.

The dashboard's **What's New** rail reads this file at request time
(cached by mtime in process memory) and surfaces the most recent
entries. Keep entries terse — one line per item under each version
date, grouped by `Added` / `Changed` / `Fixed` / `Removed`.

## [Unreleased]

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
