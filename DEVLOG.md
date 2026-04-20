# Forge DEVLOG

> Append-only session log. Read at session start. Update at session end.

## 2026-04-20 — Big push wrap-up (Phase 3 landed)

All eight work packages from the coordinated multi-agent build are in.
Final state on `master`:

| # | Commit | Phase | What |
|---|---|---|---|
| 1 | `ec94cb9` | — | Pre-migration snapshot (first-ever git commit in this repo). |
| 2 | `f96557f` | 1A | Schema additions (cycles/initiatives/relations/time/polymorphic attachments/granular ApiKey scopes/workspace settings) + FRG→AXI rekey + PER/WRK seed. |
| 3 | `af45433` | 2B | Routers: cycle, initiative, relation, timeEntry (+ 23 tests). |
| 4 | `cf2adec` | 2H | Docs sweep — SYSTEM.md, CLAUDE.md, Hermes skill runbook, Obsidian vault, memory files. Mizu/Lumin correction. |
| 5 | `b3555bf` | 2E | UI shell — workspace switcher, `/w/[slug]/*` URL scheme, workspace settings pages. |
| 6 | `bae90b9` | 2C | MinIO service + attachment router + granular ApiKey scopes enforcement + blocker-aware claim. |
| 7 | `6650e07` | 3F | Cycles / initiatives / roadmap / relations panel UI + list-view filter chips. |
| 8 | `22fb3cb` | 3G.wip | Salvaged inbox + pin routers from a stalled agent run. |
| 9 | `271eedc` | 3D | MCP surface: 38 tools (10 existing + 28 new), narrowing-aware. 14 new tests. |
| 10 | `3dcb589` | 3G | Attachments drag/drop + paste, inbox page, pins strip, time tracker widget. |

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
scope *and* be narrowed to a project / label / initiative subset, so a
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
  sidebar's `g i`/`g s`/… labels now *actually* work — press `g` then
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
  + color swatches + emoji icon). Key auto-suggested from name initials.
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
  scope set. API keys issued to a plugin can only *narrow*, never widen.
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

### Known gaps / TODOs in code
- `auth.ts` assumes `nodemailer` provider; install and configure SMTP.
- `worker.ts` webhook delivery job: enqueue is currently manual — add a
  transactional outbox step that enqueues when `WebhookDelivery` rows are
  written.
- `trpc-provider.tsx` — superjson transformer on `httpBatchLink` works in
  trpc v11; double-check when installing.
- `audit.ts` fire-and-forget pub/sub — acceptable because deliveries are
  durable via `WebhookDelivery` rows, but add a retry guard in prod.
