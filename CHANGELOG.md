# Changelog

All notable changes to Forge are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and dates use
ISO-8601.

The dashboard's **What's New** rail reads this file at request time
(cached by mtime in process memory) and surfaces the most recent
entries. Keep entries terse — one line per item under each version
date, grouped by `Added` / `Changed` / `Fixed` / `Removed`.

## [Unreleased]

### Added

- **Link GitHub issues & PRs from the issue page — with a way out of "no mapping".** The issue's GitHub panel now opens a proper dialog: paste a URL or `owner/repo#123` and see a live preview before linking (a PR pasted as an `/issues/` URL is recognized as a PR), or **browse a connected repo's** open issues and pull requests and link them in place. When a repository isn't wired up yet, the dialog explains exactly *why* and offers the one-click fix — **connect the repository** (admins), **resume a paused** connection, or **install the GitHub App** — instead of the old dead-end "No active GitHub mapping for this repository" error. Agents get a new `github.listMappings` tool so they can discover which repos are linkable before searching or linking.
- **Run rows show the engagement mode, engine, and *why*.** Every agent run now displays its engagement mode (including **Execute**, which used to be hidden) and its run engine (**Runs** / **Streaming**) as chips, with a tooltip explaining how the mode was decided (surface default, mention policy, carried from the active run, an explicit marker, …). The mode/engine/source are frozen on the run at dispatch, so they stay truthful even after you later change an agent's settings.
- **See how a dispatch will run before you commit.** The assign popover now previews how the assigned agent will dispatch at the chosen mode ("runs as Research on Hermes Runs"), and the agent detail page shows the agent's *resolved* engine (honoring an attached runs-runtime, not just the raw preference).
- **Command Center & Inbox group repeated asks per issue.** Multiple open requests on the same issue now collapse into one card with a "+N more" count instead of stacking near-duplicates.
- **Per-run safety budgets.** A workspace can now cap each agent run by tokens, cost (USD), and/or wall-clock minutes (Settings → Workspace → Run safety budgets; `0` = no cap, opt-in). When a run crosses a configurable warn threshold you get a one-time heads-up; when it breaches a cap, Forge stops the provider run and either **pauses** it — parked with a clear reason and a "raise the budget & resume, or abandon" notification — or **stops** it outright. The idle watchdog only caught *quiet* runs; this catches a *busy-but-looping* one before it burns unbounded spend. No run is left in a silent dangling state.
- **Slimmer MCP tool list for providers with tool-count caps.** The MCP endpoint now accepts `?profile=core|planning|agents|canvas` (or `?tools=issues,comments,…`) to advertise a focused subset of Forge's ~200 tools — so models that cap the tool list (e.g. xAI/Grok at 200) stop rejecting sessions. `tools/list` is also pruned to the key's scopes. Full capability stays callable regardless. Point a capped runtime's Forge MCP URL at `?profile=core`.
- **Generate a plan with Forge — no agent required.** A goal now offers two ways to draft its plan: **Generate with Forge** builds the steps directly using your workspace's AI model, and **Dispatch to crew planner** hands it to an agent as before. Pick whichever fits; Generate works even with no agents online.
- **The dashboard Customize mode is now a fluid grid.** Tiles live on a 2-column grid you can drag to reorder — the board reflows with smooth motion as you drag instead of snapping. Drag a tile's right edge (or hit the size button) to snap it between half and full width, and the layout animates into place. Your order, widths, and hidden tiles save automatically. Respects reduced-motion.
- **The issues list loads every issue, not just the first 50.** The list now pages in more as you scroll (with a "Load more" fallback); the board pages each column independently, so low-traffic columns like Backlog and Done are no longer starved by a shared cap.
- **Keyboard navigation on the issues list.** Move the row cursor with `j`/`k` or the arrow keys, open the focused issue with `↵`, and select it with `x` — no mouse required. Filter pop-overs also close with `Esc` and move with the arrow keys.
- **Filtered issue views are now shareable.** Your active filters, search, sort, and grouping live in the URL, so a filtered list can be bookmarked, shared, and survives a refresh — and the browser Back/Forward buttons undo and redo filter changes.
- **The issues board honours Sort and the due-date filter.** Changing Sort now reorders board cards, and a `?dueOn=` deep link (from the Today widget) scopes the board too — previously both were silently ignored on the board.
- **Shared GitHub Apps for runtime git auth (no per-repo keys).** A new **Settings → GitHub Apps** page lets you set up one GitHub App and share it across runtimes. Forge mints a short-lived installation token into `GH_TOKEN` at provision time, and you manage which repos it can touch from GitHub — no per-repo tokens, no long-lived key to rotate. **Create with GitHub** runs a manifest flow where GitHub generates the app and key for you (no PEM to paste) and walks you through install; or add an existing app manually. A **Test connection** button reports the account + repo count. Point a runtime at an app from its settings. The private key is encrypted at rest and never leaves the server.
- **Per-project repositories.** Bind a git repo to a project (Project → Edit → Repository). Runtimes clone-or-pull every project's repo, so one runtime can serve many codebases — an agent dispatched to a project's issue is told which checkout to work in.
- **SSH-key git auth.** Add a `GIT_SSH_KEY` runtime secret (with optional `GIT_SSH_KNOWN_HOSTS`) to clone/push over SSH — deploy keys and non-GitHub hosts, alongside or instead of a token.
- **One-command runtime provisioning for any host.** A new **Provisioning** card (Settings → Runtimes → a runtime) gives a copyable bootstrap + downloadable script that sets up a runtime anywhere — fetches its secrets, configures git auth, and clones its repos. Works for ephemeral agents (Claude Code, Codex CLI) and persistent hosts alike; a `forge-provision` Hermes skill runs it on a schedule. Provider-agnostic — the same flow as the Codex bridge.
- **Runtime credentials + repo provisioning.** Runtimes (Settings → Runtimes → a runtime) now have an encrypted **Secrets** store (e.g. `GH_TOKEN`) and **Repository** bindings. A runtime auto-provisions on startup — fetches its secrets, sets up git/`gh` auth, and clones-or-pulls its bound repos into the workspace — so a dispatched agent lands in a ready checkout with push/PR access instead of an operator hand-placing files and keys. Secret values are write-only (never shown again after saving).

### Fixed

- **Assigning a non-Execute agent via `/assign` no longer auto-starts the issue.** A slash-command assignment now carries the resolved engagement mode, so a Research/Review/Discuss agent assigned that way is no longer wrongly flipped into in-progress.
- **Repeated stalled agent runs collapse into one card.** When a piece of work was re-dispatched, each attempt left its own stalled run behind, so one issue could show three or four identical "stalled run" cards in Command Center (e.g. AXI-75). A fresh run now supersedes its earlier attempts and they collapse into a single thread — the head run, with the history preserved underneath — instead of piling up.
- **Duplicate permission/grant requests no longer pile up.** A second runtime-tool-grant request for the same issue (e.g. escalating read-only → full) now *replaces* the earlier open one instead of leaving two competing cards in the queue. Generally, a newer request for the same issue + kind + agent supersedes the prior open one.
- **Mission Control finally fits a phone.** The cross-workspace pages (Mission Control, Inbox, Activity, What's New) used to stack the whole sidebar above the page on mobile — eating the top third of the screen before any content. The sidebar now lives behind a hamburger menu (a bottom sheet), tap targets on the top-bar buttons are bigger, the app extends correctly under the notch (safe-area), and desktop-only keyboard hints are hidden on mobile.
- **Clicking "Plan" no longer leaves you with a silent empty plan.** If the crew's planner can't be reached (no planner assigned, offline, or not wired up), the goal now says so clearly and points you to generate the plan with Forge or add steps yourself — instead of a blank plan with no explanation. When a planner *is* reachable, you see it was dispatched and that steps are on the way.
- **Unused dashboard widgets no longer show as blank tiles.** Widgets with nothing to show (no agents, no recent items, etc.) collapse and take no space; in Customize mode they stay visible, flagged "not in use," so you can hide them.
- **Dashboard customize drag feels smoother.** You can now grab a tile anywhere (not just the small grip), reordering no longer jitters while tiles animate, and the resize edge is a larger, easier target.
- **Filtering the issues list by a "Done" (or "Cancelled") status now shows those issues.** Previously the list hid completed work by default, so explicitly selecting a Done status from the Status filter returned nothing. The list now includes done issues whenever your filter explicitly asks for a completed status.
- **The issues header count is now honest.** The subtitle reflects what you're actually looking at ("N matching" when filters are active) instead of a raw total that counted archived, done, and snoozed issues.
- **"Clear filters" no longer snaps back.** Clearing with both a saved view and a due-date deep link active could silently re-apply the view; it now clears everything in one step. The board also shows a "no matches" state with a Clear shortcut, like the list.
- **The "Recently updated" quick filter no longer resets your window.** A saved view pinned to 7/30 days now lights the chip correctly instead of appearing off and being clobbered back to 3 days on the next click.
- **Invalid due-date links are rejected.** A shared `?dueOn=` with an impossible date (e.g. `2026-13-45`) no longer silently rolls over to a different day.
- **Codex approvals on assigned issues no longer freeze.** Approving (or rejecting) a Codex command request now reaches the agent even when dispatch runs in a separate worker process — previously the button flipped the run between "running" and "waiting" without ever resuming.
- **Failed agent dispatches now show on the issue.** When a dispatched run ends without completing (stalled/abandoned), the agent's output is posted as a comment on the issue instead of being buried in the Mission Control run overlay — so a failed run is visible in the timeline and notifies watchers.
- **Replying to a blocked agent now resumes it.** When an agent pauses a run waiting on you, nudging it (or commenting on the issue) re-dispatches it with your reply — previously a paused run could only be restarted by re-assigning, which lost its context.

### Changed

- **The planning views got a visual refresh.** Plans and goals show a numbered DAG step strip with the running step glowing, status colors now use the warm palette, lists fade in as they load, and detail-view titles are sized to match the rest of the app (no more oversized headers).
- **Creating a goal no longer auto-starts the planner.** You land on the goal and choose how to draft the plan, instead of a planner being dispatched silently in the background.
- **Approve grants session scope by default.** Approving a command request stops the agent re-prompting for similar commands for the rest of the run; a "Just this once" link keeps the single-command option.
- **Command approvals now appear on the issue page.** The Approve/Reject card shows in the issue's agent panel, not only in the Mission Control Live tab.
- **The issue's agent panel shows why a run is paused.** A waiting run now displays the agent's last step / block reason inline, so you can respond without opening the Mission Control overlay.

## [2026-06-09] — v0.7.0 · Chat runtime controls

### Added

- **Runtime model and mode controls.** Codex runtimes can set a default model and YOLO mode; Hermes runtimes can set profile, mode, model, and YOLO auto-approval.
- **Conversation-level YOLO overrides.** Chat threads can inherit, force-enable, or force-disable YOLO from the chat header settings menu.
- **Workspace default issue assignee.** Workspaces can automatically assign new issues to nobody, the creator, or a selected member.

### Changed

- **Chat status is calmer and more accurate.** Stale failed turns no longer keep active conversations stuck in attention/thinking states, `/clear` restores suggestions, and chat work traces render in a shared compact format.
- **Codex app-server run tracking is durable across connector instances.** Forge now retains active run state long enough for pollers and reports unknown or prematurely closed Codex runs as failures.

### Fixed

- **Provider permissions now reach the runtime.** Codex chat turns forward model and YOLO policy, and Hermes approval prompts are auto-resolved when YOLO is enabled.
- **Issue creation paths honor the same assignee defaults.** UI, email ingest, recurring issues, note promotion, MCP promotion, and execution-step materialization now share the same default assignment behavior.
- **The Activity launcher no longer blocks Chat send.** The collapsed Mission Control launcher lifts above the full Chat composer instead of intercepting the Send button.
- **Chat read and composer state are steadier.** Activity views mark visible chat activity read, and newly opened thread drafts finish loading before the composer accepts input.

## [2026-06-09] — v0.6.0 · GitHub support and sprint planning

### Added

- **GitHub App support.** Added GitHub connection setup, install callbacks,
  webhook ingest, synced external resource mappings, issue-detail GitHub links,
  and MCP tooling/docs for linked GitHub work.
- **Sprint management workflows.** Added sprint edit, rollover, guarded create,
  backlog planning, and delete flows with audit-backed issue movement.

### Changed

- **Roadmap is now a working timeline.** Added initiative, date coverage, and
  progress filters, visible sprint bands, no-date rows, and inline project date
  editing.
- **Issue creation now has a shared service path.** UI, API, and MCP creation
  paths share the same issue-create behavior.

### Fixed

- **Sprint and project date guards are enforced server-side.** Forge now rejects
  overlapping active sprints and invalid project date ranges through tRPC and MCP.
- **Side-panel interactions no longer leak to Mission Control shortcuts.**

## [2026-06-06] — v0.5.1 · Android PWA install and push

### Added

- **Forge installs cleanly on Android.** Added install prompts, launcher
  shortcuts, update notifications, offline fallback, and opt-in visited-page
  caching for the PWA shell.
- **Browser push notifications.** Added VAPID-backed Web Push subscriptions,
  service-worker notification handling, and best-effort fanout for alertable
  workspace activity.

### Changed

- **iOS gets lightweight PWA guidance.** Users on iOS see an Add to Home Screen
  hint when Forge is not already running standalone.

### Fixed

- **Twitter image builds without metadata warnings.** The twitter-image route
  now exports metadata config directly so Next can analyze it cleanly.

## [2026-06-06] — v0.5.0 · Agent runroom views

### Added

- **Agents now have an operational runroom.** The workspace agents view now
  surfaces fleet health, dispatch queues, attention items, runtime topology,
  and recent activity in one oversight screen.

### Changed

- **Agent detail pages focus on readiness.** Individual agents now show held
  work, active runs, context, crew activity, runtime readiness, webhook health,
  and dispatch eligibility in a cleaner operator layout.

## [2026-06-03] — v0.4.2 · Build version reporting

### Fixed

- **Version chip reports the tagged package version.** `system.buildInfo` now
  reads `package.json` in standalone Docker images when `npm_package_version`
  is absent, so the in-app release chip shows the deployed Forge version
  instead of the fallback `v1.0.0`.

## [2026-06-03] — v0.4.1 · Release metadata visibility

### Fixed

- **What's New shows the current release again.** Fixed the changelog parser so
  bracketed ISO-date headings like `[2026-06-03]` stay intact instead of being
  split at the first hyphen, restoring `system.buildInfo.release` and the
  release ordering used by What's New.

## [2026-06-03] — v0.4.0 · Mobile app experience

### Added

- **Forge now works as a mobile app.** The authenticated shell, bottom
  navigation, issues list/board/detail, inbox, dashboard, review, settings,
  agents, and Mission Control now adapt down to phone widths with reachable
  controls, stable touch targets, and no document-level horizontal overflow.
- **Mobile regression coverage.** Added a Playwright smoke spec that exercises
  core authenticated workspace routes at 390px, 430px, and 768px.

### Changed

- **Dense workflows read better on small screens.** Page topbars stack, subtitles
  clamp cleanly, issue rows emphasize the useful title/key hierarchy, inbox
  action labels shorten where needed, mobile toasts clear the bottom nav, and
  agent runtime cards use compact tooltip-backed metrics.

## [2026-05-31] — v0.3.1 · Auto-settle stale agent runs

### Changed

- **Finished agent runs stop lingering.** The stalled-run watchdog is now on by
  default (idle ACTIVE runs auto-close after 30 minutes), so an agent turn that
  ended without an explicit "done" no longer shows as a live run on the issue
  page indefinitely. Tunable per workspace (`agentRunStaleMinutes`); set 0 to
  disable.

## [2026-05-31] — v0.3.0 · Issues filtering & live composer UX

### Added

- **Filter, sort & group your issues.** The issues list gains multi-select
  **Status / Priority / Project / Assignee / Label** filters, a **Sort**
  control (priority, newest, oldest, recently updated, title A–Z), and a
  **Group by** control (status, project, assignee, priority, or none). Sort
  and grouping are remembered per browser.
- **Slash commands that show their work.** In the new-issue overlay (⇧C),
  typing a command like `/priority high`, `/assign @victor`, `/due tomorrow`,
  `/label bug`, or `/project AXI` now lights up the matching picker (priority,
  project) or drops a removable **chip** the moment it's valid — press ⏎ to
  apply it and keep only your title text. A live "↵ apply …" hint shows when
  a command is recognized.
- **See your @mentions and /commands as you type.** The issue description and
  comment composers now highlight `@mentions` and recognised `/command` lines
  inline while you type, before you submit.

### Changed

- **Roomier create overlay.** The ⇧C quick-create panel is a touch larger
  with a cleaner layout, and the project picker now matches the rest of the
  app's styling instead of a plain dropdown.

### Fixed

- **Agent runtime reads cleanly.** The "X was assigned by Y" note in an
  issue's timeline now shows a tidy runtime label (e.g. "remote webhook")
  instead of the raw `REMOTE_HTTP` with stray underscores.
- **Live run status settles when work ends.** The agent run strip on an issue
  stops pulsing "working…" and settles to a calm "idle" state once the agent's
  turn finishes, instead of looking busy for minutes afterward.
- **Issue detail fits smaller screens.** The Attachments "attach link" form no
  longer overflows the side panel on smaller laptops, and the issue detail +
  issues list read cleanly down to mobile widths.

## [2026-05-27] — v0.2.0 · Release visibility & docs

### Added

- **What's New, everywhere.** A global **What's New** page (newest first, grouped
  Added / Changed / Fixed / Removed per release) is now reachable from Mission Control
  and Instance Admin — not just the workspace dashboard. All read the same canonical
  `CHANGELOG.md`.
- **Version at a glance.** The running version + build now show as a subtle chip in the
  global "concourse" rail and the Instance Admin rail (hover for release / SHA / build
  time), linking straight to What's New.

### Changed

- **Docs:** new user guides for **Mission Control**, **Connections**, **Instance Admin**,
  and **Agent profiles & bindings** (the three-tier ownership model + request→approve).

## [2026-05-27] — v0.1.0 · Multi-workspace platform

### Added

- **Connect external accounts (OAuth/OIDC).** Connections now do a real authorize →
  callback flow (generic OIDC discovery plus GitHub / Google / Slack), so you can
  **Authorize** an identity from **Settings → Connections** instead of pasting a token.
  Tokens are encrypted and refreshed automatically near expiry.
- **Request an agent profile.** Members can request a new agent profile from a
  workspace's **Settings → Agents** catalog; instance admins approve or reject pending
  requests from **/admin → Agent policy**. (Creating a profile directly still needs admin.)
- **Per-binding "require approval"** — a workspace binding can require human approval
  before a dispatched run starts, overriding the workspace default.
- **Default labels on connection mappings** — inbound work from a mapped repo/channel
  can auto-apply chosen labels.
- **Cross-workspace Mission Control.** A new home at `/` surfaces your work, agents,
  runtimes, and live activity across every workspace you belong to — read-only, with a
  workspace chip on each row and a Slack-style workspace switcher in the rail (also in
  ⌘K and a dedicated **Settings → Workspaces** picker).
- **Global agents, runtimes & connections.** Agent **profiles**, **runtimes** (the hosts
  you've registered), and **connections** (your GitHub / Slack / OIDC identities) are now
  defined once at the account level under **Settings**, then adopted per workspace.
- **Instance admin area.** A dedicated, separately-styled `/admin` section (instance
  admins only) for tenants, users, instance-wide runtimes, audit, and build/system info.
- **Epics & sub-issues.** Issues now have a **type** — Epic, Issue, or Sub-task — set
  from a picker on the issue header (type glyphs show in lists). An **Epic** is an
  issue whose **sub-issues** are its scope: the issue page has a Sub-issues panel with
  a done/total progress bar and inline "add sub-issue", a "↑ part of EPIC-…" backlink
  on children, and an **Epics** quick-filter on the issues list. Sub-issues reuse the
  same parent/child tree the relations graph already draws.
- **Engagement modes for agent work.** When you assign or mention an agent you can
  now say *what* you want — **Execute** (take it to done), **Research** (investigate
  & report, no changes), **Review** (critique only), or **Discuss** (just weigh in).
  Only Execute moves the issue or runs the completion gates, so a research or review
  pass can't accidentally start work or deploy. Defaults per surface are configurable
  in **Settings → Dispatch Rules** (including how a bare @-mention is treated). See
  the [Engagement modes guide](/agents/engagement-modes).
- **Plan steps can become real issues.** Materialize any execution-plan step into a
  tracked Issue (carrying its expected-output + verification), so planned work shows
  up on the board/sprint like everything else — or leave it as pure plan scaffolding.
- **Goal/plan work is now visible in Mission Control.** Steps an agent runs as part of
  a Goal open real runs (with a mode chip) instead of dispatching silently.
- **Goals can sit under an initiative**, and a hand-authored plan can be linked to a
  goal (and built with step dependencies) in one step.
- **Dependency graph on issues.** The Relations tab now has a **Graph** view (toggle
  next to List) that maps the issue's place in its blocks/blocked-by chain *and*
  parent/child sub-issue tree — an animated, themed DAG with the current issue
  flagged "here". Click any node to jump to it.
- **Move issues between projects and sprints in bulk.** The issues list and inbox
  bulk bars gained **Project…** and **Sprint…** actions; select any number of issues
  and move them in one go.
- **"Part of" backlinks on issues.** An issue now shows the execution **plans** it's
  the subject of, each with a step-progress bar (done / total) — alongside the
  existing goals strip.
- You can now link a hand-authored execution plan to a goal: `executionPlans.create`
  accepts a `goalId`, and a new `goals.attachPlan` action attaches an existing plan
  as the goal's active attempt — no need to go through the AI planner.
- `executionPlans.create` can now seed a step DAG in one call using
  `steps[].dependsOnStepIndexes`, matching `plans.addSteps` for hand-authored plans.

### Changed

- **Workspace Agents & Connections are now bindings, not definitions.** A workspace's
  **Settings → Agents** is a catalog of globally-defined profiles you *bind* with
  per-workspace policy (capacity, capability overrides, auto-dispatch eligibility);
  **Settings → Connections** *maps* your global identities to repos / channels /
  webhooks. Dispatch rules can only target agents bound to the workspace.
- **"Mission Control" overlay is now "Activity."** The chord-`G 5` live-runs + chat dock
  is renamed **Activity**; the name *Mission Control* now refers to the new
  cross-workspace home at `/`.
- **Removed the per-workspace "Personal" view** — its cross-workspace successor is
  Mission Control at `/`.
- **Issue sidebar pickers are now searchable.** Project and a new **Sprint** field use
  the command-palette picker; the project picker surfaces each project's initiative
  inline so you can place work in the right bet at a glance.

### Changed

- **The notifications bell no longer wipes unread state the instant you open it.**
  It now marks notifications read when you *close* the panel, so you can open it to
  glance, read individual items, and use the per-row Ack/Dismiss/Resolve controls
  without the badge clearing out from under you.
- **The bell/inbox badge is now a true "unread" count** — items new since you last
  looked — instead of a running backlog total. Visiting the Inbox, pressing `M`, or
  opening and closing the bell clears it; new activity raises it again.

## [2026-05-25] — Settings sidebar + sharper status, dispatch, and detail styling

### Added

- **Command Center asks can now set the issue's status inline.** When an agent
  asks for you on an issue, a "Set status…" control on the card moves the issue
  (e.g. straight to Done) without accepting or declining the ask — so closing an
  issue never records a decline resolution.
- **Settings now has a left sidebar** with grouped sections, short descriptions,
  admin tags, and a search box (press `/`) — replacing the cramped top tab bar.
- **Status icons** across issues now show their true shape (backlog, started,
  in-review, done, blocked, canceled) instead of a plain dot, and **priority**
  marks are colour-coded (urgent reads red, high amber).
- **`+ Add`** affordances (capabilities, labels, assign-agent, providers) now use
  the dashed-outline style from the design.

### Changed

- **Dispatch rules** is now a proper routing table — On / Name / Priority /
  Label / Project / Target agent columns with a real toggle — instead of a
  one-line sentence per rule.
- **Plans** cards show their step DAG and owner; **Roadmap** bars show a progress
  fill and project key; **Goals** keeps the loop guide visible above the list;
  the **sprint backlog** reads as a dashed "drag → plan" tray.
- **Dashboard** "Needs you" now lists the actual asks inline (with the agent and
  a Resolve/Review action) and gained a **Pulse** widget (open / in-progress /
  done-this-week / sprint).
- Chips/badges use a consistent rounded style; **labels** render as bordered
  chips. Per-status groups on the issues list have an inline **+ Add issue**.
- **Sprints** header has a sprint switcher + always-available "Rollover
  incomplete"; the burndown notes whether you're on pace.
- Smaller polish: roadmap Filter + per-row project counts, artifacts "updated"
  timestamps, an initiatives "Roadmap view" shortcut, Command Center shows who's
  asking, an inbox "Mark read" (M), and the new-API-key dialog recaps the key
  details behind an "I've saved it" confirm.
- **Connections** now open a **detail page** (Configure/Connect → its own page).
- **Inviting members** is now a multi-recipient composer — paste a list, see
  who's valid / already a member, pick a role, add a note, send in one go.
- **Plugin** detail pages are organized into Overview / Permissions /
  Configuration / Activity tabs.
- Two new **interactive backgrounds** in Appearance — a cursor-reactive dot grid
  and a drifting particle field (both respect Reduced Motion).
- **Project** overview now has a Properties / Progress / Contributors side rail,
  and the **Inbox** gained an agent-queue + "agents online" side rail.
- **Chat** rail now shows the conversation's members and any linked issue
  alongside the connection status; **Plans** has a templates + status-legend side
  rail; the **add-agent wizard** uses step dots with per-provider setup previews.

## [2026-05-24] — Choose your background, richer agent & plan cards, plugin pages

### Added

- **Background style is now yours to pick** (Settings → Appearance):
  **Grid** (default), **Glow** (a drifting ember bloom over a dot field),
  **Dots**, or **None**. Applies instantly and follows you across workspaces.
- **Agent cards** now show provider, runtime, connection, heartbeat, capabilities,
  and a workload bar at a glance, with an **Infrastructure** panel for the wiring.
- **Plugin pages** — each plugin now has its own detail page (scopes explained,
  skills, webhooks, events) with approve / suspend / rotate-secret / remove —
  groundwork for first-class integrations like a GitHub bridge.
- **More signal on cards**: projects show a progress bar + initiative; initiatives
  list their projects with done/total; plans show a step strip + owner; goals and
  Command Center show step progress.

### Fixed

- The ambient **grid background no longer stutters** on long pages and now always
  fills the full height of scrollable pages (it's one fixed layer behind the app
  instead of a per-page layer that lagged or cut off mid-scroll).

## [2026-05-24] — Settings, redesigned

### Added

- **Agents** now show as one card per agent with provider, runtime, connection,
  and last heartbeat inline, a workload bar, and a collapsible **Infrastructure**
  panel — no more hopping between Agents, Runtimes, and Integrations to see how
  an agent is wired.
- **Plugins** gained a **Permission reference** explaining what each scope grants,
  so you can approve the smallest set that does the job.
- Settings pages across the board now **group related controls**, put **help text
  under fields** instead of in tooltips, teach you what a feature does when a list
  is empty, and isolate destructive actions in a clearly-marked **danger zone**.
- **Workspace · General** got a sticky **save bar** that appears only when you
  have unsaved changes (with a pending-count and ⌘S).

### Changed

- **Members**, **Statuses**, **Labels**, **Dispatch rules**, **Saved views**,
  **Recurring**, **Templates**, **Data export/import**, **Admin**, and the
  **account** pages were reorganized for less clutter and more breathing room.

## [2026-05-24] — More signal on the planning & work screens

### Added

- **Issues list now groups by status** with sticky section headers (count per
  status), Linear-style — plus inline label chips and a comment-count on each
  row. Select-all, bulk actions, and previews all still work.
- **Sprint summary** shows a four-up breakdown — Scope / Done / In progress /
  Remaining — instead of three numbers.
- **Goal cards** gained a step-ladder, a budget meter (turns amber as you near
  the cap), and the owning crew at a glance.
- **Roadmap** bars show the project key and a clearer legend; active sprints are
  tinted more strongly than planned ones.
- **Artifacts** can be filtered by type and searched.
- **Dashboard** "By status" rows now draw a proportional bar so you can eyeball
  the mix.
- **Command Center** live-goal cards show budget used vs cap.
- A **"+" on each board column** to add an issue straight into that column, and
  a live presence dot in the chat conversation header.

## [2026-05-24] — Settings cleanup: one home for agents, a clearer Connections page

### Added

- **Connections** (Settings → Connections) — a focused page for systems that
  talk *to* Forge or receive events *from* it: GitHub, Slack, email-to-issue,
  custom webhooks, split into Inbound and Outbound. Replaces the old
  Integrations page.
- **Add-an-agent gallery + provider matrix** on Settings → Agents — pick a
  provider recipe (Hermes, Claude, Codex, Custom) to start onboarding with the
  right connection and runtime preset, and see at a glance which connection
  mode each provider uses.
- A **drifting glow-grid background** style (warm ambient lights moving through
  a dot grid; respects Reduced Motion).

### Changed

- **Agents is now the one place to configure agents** — provider, runtime, and
  connection all live here instead of being scattered across Agents, Runtimes,
  and Integrations.
- **Integrations was renamed Connections** and scoped to external I/O only.
  Old `/settings/integrations` links redirect automatically.

### Removed

- The standalone **Runtimes** entry in the settings sidebar — runtime setup now
  happens during agent onboarding (the advanced runtime editor is still
  reachable for power users).

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
- **On-demand presence now reads correctly on every surface** —
  execution-plan step dots, the crew rosters (crew page + plan/goal
  cockpits), the chat @-mention list, the agent timeline, the dashboard
  agent-activity tile, and agent hover cards no longer show a managed
  app-server agent as "offline."
- **Persistent mode is gated by the attached runtime, not the provider.**
  A Claude or Codex agent can be persistent when hosted on a managed
  runtime (the Codex app server or the Forge local daemon); the wizard no
  longer blocks persistent Claude outright or restricts persistent Codex to
  the app server alone.

### Changed

- **Managed agents now show true online/offline.** An agent hosted on the
  Forge local daemon goes **online** while the daemon is heartbeating and
  flips to **offline** when it stops — instead of always reading "on-demand."
- **Codex app-server presence is health-checked.** Forge now periodically
  pings the Codex app server; its agent reads **online** when the server
  answers and **offline** when it doesn't, so a dead bridge is visible at a
  glance instead of failing only when you message it.
- **New workspaces auto-offline idle agents by default.** The agent idle
  timeout now defaults to **15 minutes** (was off), so a heartbeat agent whose
  runtime goes quiet flips to offline on its own — true presence works out of
  the box. Existing workspaces keep their current setting; `0` still disables.

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
