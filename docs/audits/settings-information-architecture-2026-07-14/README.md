# Forge settings information architecture review

Date: 2026-07-14  
Status: code-based review complete; screenshot-backed product audit blocked  
Scope: Instance Admin, cross-workspace Mission Control/global settings, per-workspace settings

## Executive decision

Forge should keep its three ownership levels, but present them as one settings system with an explicit scope switcher:

1. **Personal** — follows the signed-in person across workspaces.
2. **Workspace** — affects members and work inside one named workspace.
3. **Instance** — affects every workspace and is visible only to instance administrators.

Mission Control should not be a fourth settings scope. It should remain the cross-workspace operating home. The floating in-workspace panel should be called **Activity**, and its gear should open **Activity preferences**.

The recommended first implementation slice is navigation and naming, not a route rewrite: add a shared scope header and settings overview, fix the two functional dead ends, rename conflicting entries, and preserve the existing URLs behind the new structure.

## Evidence and audit limit

The Product Design audit workflow requires screenshots captured and inspected during the current run. No screenshot was accepted in this run:

- The Codex in-app Browser (`iab`) was not exposed to this task.
- The permitted fallback, the user's existing Chrome session, could not be attached because Chrome remote debugging was disabled and no `DevToolsActivePort` was available.
- Playwright was not substituted because the workflow requires explicit user permission before using it as a browser replacement.
- Figma was not used or offered, matching the explicit product-design preference.

Therefore, this document is **not a screenshot-backed visual or WCAG audit**. It is a code-grounded information-architecture, discoverability, permission, and likely-accessibility review. Visual hierarchy, actual focus order, contrast, zoom/reflow, screen-reader output, and touch behavior still require a browser walkthrough.

Current-run capture log: [screenshots/README.md](screenshots/README.md)

## User goal and target

An operator should be able to answer these questions before changing anything:

- Who will this setting affect: me, this workspace, or the whole Forge instance?
- Do I have permission to change it?
- Where do I go back to after saving it?
- Is this a definition, a workspace binding, or an instance policy?
- If a setting inherits a broader default, what is the effective value here?

The target is a keyboard-accessible, responsive settings experience with explicit scope, predictable navigation, role-aware editability, and no duplicate names for different concepts.

## Current architecture inventory

### 1. Mission Control and global shell

| Surface | Route | Actual responsibility | Current issue |
|---|---|---|---|
| Mission Control home | `/` | Cross-workspace read-only operating overview | Correct responsibility, but shares its name with the in-workspace floating panel. |
| Global inbox | `/inbox` | Cross-workspace mentions and assignments | Operational, not configuration. |
| Global activity | `/activity` | Cross-workspace live run feed | The intended name for activity already exists, while the floating activity panel is still called Mission Control. |
| Global Settings entry | `/settings/agents` | Opens global agent profiles | There is no global settings overview; “Settings” unexpectedly starts with Agents. |
| Floating “Mission Control” | mounted in each workspace | Live, queue, agents, chat, sound, and default-tab preference | Duplicates the name of `/`; its generic gear looks like another app settings entry. |

Code anchors:

- `src/components/global-shell/global-shell.tsx:112-116` names `/` Mission Control and `/activity` Activity.
- `src/components/global-shell/global-shell.tsx:277-286` sends the global Settings entry directly to `/settings/agents`.
- `src/components/mission-control/mission-control.tsx:622-705` still labels the floating panel and collapse action “Mission Control.”
- `src/components/mission-control/settings-popover.tsx:34-143` mixes browser-local sound with per-user and per-workspace default-tab preferences.

### 2. Personal and cross-workspace settings

The bare `/settings/*` rail contains nine entries in one group labeled **Account**, even though they have four different ownership and permission models.

| Current label | Route | Real scope / owner | Recommended label and home |
|---|---|---|---|
| Agents | `/settings/agents` | User-owned profile definitions; creation/approval is instance-admin governed | **My agent profiles** under Personal; approval/share/disable under Instance → Agent governance |
| Agent Clients | `/settings/clients` | User-owned MCP sessions and keys | **Developer clients** under Personal → Developer tools |
| Runtimes | `/settings/runtimes` | Cross-workspace inventory of user-owned hosts, but mutation is workspace-scoped | **Runtime inventory** under Operations, with a canonical detail route |
| Connections | `/settings/connections` | User-owned OAuth identities | **Connected accounts** under Personal → Integrations |
| Profile | `/settings/account` | User profile, regional preferences, theme, Pomodoro | **Profile & regional** under Personal |
| Appearance | `/settings/appearance` | User UI preferences | **Appearance** under Personal |
| Developer access | `/settings/access` | Workspace API keys plus external-agent setup presented in a global shell | Split into **Personal tokens** and **Workspace API access** based on the key's real scope |
| Authentication | `/settings/auth` | Whole-instance sign-in providers, instance-admin-only | Move to **Instance → Identity & sign-in** |
| Workspaces | `/settings/workspaces` | Workspace directory, creation, switching, archive/delete | **Workspaces** as a global directory; keep creation policy explicit |

Key structural problems:

- Instance-wide authentication appears inside a rail labeled “Account” (`src/components/settings/settings-nav.ts:202-240`).
- Global resources are prepended to that same Account group without subgroups (`src/components/settings/settings-rail.tsx:193-249`).
- The account settings shell always returns to Mission Control, even when entered from a workspace (`src/app/(app)/settings/layout.tsx:5-30`).
- Workspace-scoped redirect stubs erase the originating workspace and return context.

### 3. Workspace settings

The workspace settings inventory is coherent at the route level, but the grouping and permission language are inconsistent.

| Group | Current entries | Actual responsibility | Recommendation |
|---|---|---|---|
| Workspace | General, Members | Workspace identity, cadence, storage, issue defaults, agent SLA, budgets, lifecycle, AI, danger zone; member access | Split the overloaded General page into Workspace profile, Issue lifecycle, Reliability & safety, and AI & triage. |
| Workflow | Statuses, Labels, Templates, Saved views, Recurring | Issue planning configuration | Rename group **Work management**; show “Read only” or “Admin” based on the caller's role. |
| Automation | Agents, Dispatch rules | Agent bindings, per-workspace policy, routing, engagement modes | Rename **Agents & automation**; add Dispatch & routing and make the effective fall-through mode editable. |
| Connections | Connections, GitHub Apps, Plugins, Webhook deliveries | OAuth mappings, runtime GitHub auth, extensions, outbound delivery queue | Rename **Integrations** and distinguish Connected account, Mapping, GitHub runtime access, and Webhook delivery. |
| Admin | Admin portal, Data import/export | Workspace audit/events/deliveries and portability | Rename **Data & governance**; “Admin portal” is too easily confused with Instance Admin. |

The workspace overview then appends the Account group directly beneath workspace groups (`src/app/(app)/w/[slug]/settings/page.tsx:54-74`). That creates a scope jump without a scope control. A person can click Appearance while inside AXI settings and land in a different shell whose only back link is Mission Control.

The General page is also too broad. It combines at least these concepts:

- identity and danger zone;
- sprint cadence;
- time tracking and attachment quota;
- default issue assignee;
- agent liveness, acknowledgements, SLA and review timeouts;
- token, cost and time budgets;
- assignment, review and completion transitions;
- completion automation;
- AI provider and Coach behavior.

This makes “General” a catch-all rather than a useful destination.

### 4. Instance Admin

| Route | Current label | Responsibility | Recommended label / placement |
|---|---|---|---|
| `/admin` | Overview | Instance health and totals | Keep **Overview** |
| `/admin/tenants` | Workspaces | All tenants | Keep **Workspaces** |
| `/admin/move-issues` | Move issues | Cross-workspace data operation | Place under **Workspaces → Move data** or **Data operations** |
| `/admin/users` | Users | Users and instance roles | **Users & roles** |
| `/admin/agents` | Agent policy | Share, disable, approve global profiles | **Agent governance** |
| `/admin/runtimes` | Runtimes | Instance-wide runtime inventory/policy | **Runtime governance** |
| `/admin/audit` | Audit log | Cross-workspace audit | Keep **Audit log** |
| `/admin/system` | System | Build and instance totals | **System & backup** once backup is functional |

Instance Admin is the clearest of the three current shells because it has a persistent instance-scope warning and a distinct visual tone. Preserve that safety signal inside the unified settings frame. The main gap is that instance configuration is split: sign-in providers live in Account settings, while users, agents, runtimes, audit, and system live under `/admin`.

## What is working

- The data model already distinguishes user, workspace/binding, and instance policy. The IA can align to real ownership instead of inventing new concepts.
- Workspace settings navigation and the workspace overview share one source of truth, preventing simple inventory drift.
- The account rail has search and a `/` shortcut.
- Workspace agent copy already teaches the useful **definition → binding → instance policy** model.
- The Instance Admin shell visibly warns that writes affect every tenant.
- Old workspace account routes redirect, reducing broken bookmarks during migration.

## Code-derived journey health

These health labels describe route and interaction structure found in code; they
do not replace the blocked screenshot walkthrough.

1. **Mission Control → Settings — at risk.** The persistent entry is easy to
   find, but it opens Agent profiles instead of a settings overview, and the
   floating panel exposes a second generic Settings gear.
2. **Personal/global settings — poor.** Nine destinations with different
   ownership and permissions appear under one Account heading; Authentication
   is actually instance-wide.
3. **Workspace settings overview — mixed.** The workspace groups share a single
   source of truth, but account links are appended inside the workspace index
   and cause an unexplained shell/scope jump.
4. **Agent, Runtime, and Connection configuration — poor.** The underlying
   definition/binding/governance model is sound, but repeated generic labels and
   a broken possible runtime-detail hop obscure it.
5. **Instance Admin — generally healthy, with one serious split.** The shell,
   warning, and gate are clear; sign-in provider configuration lives elsewhere
   and breaks the instance boundary.
6. **Switching scope and returning — poor.** There is no scope switcher, account
   settings always returns to Mission Control, and the originating workspace is
   lost.
7. **Mobile, keyboard, and assistive technology — unverified / at risk.** The
   code includes focus styles and some shortcuts, but active-state semantics,
   popover behavior, the 16rem mobile settings rail, reflow, and announcements
   require browser testing.

## Highest-impact findings

### P0 — functional and safety gaps

1. **Auto-dispatch fall-through cannot be changed from the UI it points to.**  
   Dispatch Rules renders the current `autoDispatchMode` read-only and tells the operator to change it under Settings → Workspace (`dispatch-rules/page.tsx:670-710`). `workspace.update` does not accept `autoDispatchMode` (`workspace.ts:273-314`), and the Workspace page has no control for it. This is a functional dead end. Put the editable master toggle and mode in **Workspace → Agents & automation → Dispatch & routing**.

2. **A global runtime card can link to a workspace where its detail is guaranteed to 404.**  
   The global inventory prefers `workspacesInUse[0]` over the runtime's home workspace (`settings/runtimes/page.tsx:125-155`), while `runtime.byId` requires `Runtime.workspaceId === ctx.workspaceId` (`runtime.ts:208-230`). Create `/settings/runtimes/[id]` with owner/admin authorization, or always link to `homeWorkspace` until Runtime is truly globalized.

3. **Instance-wide authentication is presented as personal Account configuration.**  
   A high-impact write that changes sign-in for every tenant should not sit beside theme and Pomodoro. Move the route into the Instance scope and preserve `/settings/auth` as an instance-admin redirect.

4. **The UI does not consistently expose effective scope before a write.**  
   The workspace overview mixes workspace and account destinations, while account settings drops workspace context. Add an always-visible scope chip/switcher and a page-level “Affects …” line before expanding functionality.

### P1 — navigation, naming, and missing controls

1. **Mission Control names two different products.** Keep Mission Control for `/`; rename the in-workspace panel and its actions to Activity / Activity preferences. This also completes the intent recorded in `docs/plans/multiws-restructure.md`.
2. **Global Settings starts on Agents.** Add `/settings` as a Personal settings overview or redirect to `/settings/account`; never make an operational resource the implicit settings home.
3. **The account rail is not actually an Account group.** Break it into Personal, Developer tools, and Cross-workspace resources; render Instance as a separate scope for authorized users.
4. **Notification preferences exist in the router and schema but have no UI.** Add Personal → Notifications with global defaults and workspace overrides. Fold Activity sound/default-tab preferences into it, while retaining a quick popover shortcut.
5. **Workspace General is overloaded.** Split lifecycle, reliability/safety, and AI into named pages. Keep identity/cadence/storage/default assignee in Workspace profile.
6. **The same nouns mean different levels.** Use Agent profiles / Workspace agent roster / Agent governance; Runtime inventory / Workspace runtime access / Runtime governance; Connected accounts / Integration mappings.
7. **Admin badges understate edit restrictions.** Many workspace settings use `adminProcedure`, but the rail marks only Members, Webhook deliveries, Admin portal, and Data as admin-only. Show effective access consistently: Admin, Read only, or Personal.
8. **Project completion policy is a hidden lower-scope override.** Project edit supports inherit/off/recommend/auto, but the settings system has no inheritance map. Workspace lifecycle settings should link to projects with overrides and show the effective resolution chain.

### P2 — polish and resilience

1. Add settings search keywords and synonyms, not just label/description substring matching.
2. Preserve a `returnTo` context when crossing scopes so Back returns to the originating workspace.
3. Add route breadcrumbs that include scope: `Settings / AXI / Dispatch & routing`.
4. Put destructive workspace actions in a separate Danger zone route or a collapsed final section with explicit workspace identity.
5. Replace remaining visually inconsistent native selects where the shared Combobox improves search/keyboard behavior, without sacrificing native semantics.
6. Show inherited values inline: `Workspace default: Recommend`, `Project override: Auto when safe`, `Effective: Auto when safe`.
7. Add a “Why can't I edit this?” permission explanation instead of discovering authorization only after submitting.

## Proposed settings hierarchy

### Shared settings frame

Every settings page should use the same structural frame:

- Header: **Settings**
- Scope control: **Personal · Workspace: AXI · Instance**
- Page breadcrumb: `Settings / Workspace: AXI / Dispatch & routing`
- Scope description: `Changes affect everyone in AXI.`
- Role state: `Workspace admin` or `Read only`
- Left rail: only the selected scope's groups
- Return link: preserve the surface from which settings was opened

The Instance option is omitted for non-instance-admins. Its selected state retains the distinct graphite tone and “affects every workspace” warning.

### Personal

1. **Profile & regional** — name, avatar, timezone, locale, time format.
2. **Appearance** — theme, density, text size, motion, background.
3. **Notifications** — browser push, event delivery matrix, Activity sound, global default Activity tab, workspace overrides.
4. **Connected accounts** — user OAuth identities.
5. **Developer tools**
   - Developer clients
   - Personal access tokens
   - MCP setup
6. **My agent profiles** — definitions owned/requested by the user.
7. **Workspaces** — directory, switch, create; workspace archive/delete remains in that workspace's scope.

### Workspace: {name}

1. **Workspace**
   - Overview — identity, cadence, time tracking, storage, issue defaults
   - Members & roles
2. **Work management**
   - Statuses
   - Labels
   - Templates
   - Saved views
   - Recurring issues
3. **Agents & automation**
   - Agent roster — bind profiles, capabilities, capacity, approval policy
   - Dispatch & routing — rules, master toggle, fall-through mode, assignment engagement
   - Issue lifecycle — assignment/start, review, completion recommendations and status mapping
   - Reliability & safety — no-ack, stale/quiet, SLA, review fallback, run budgets
   - AI & triage — provider, model, triage, Coach
4. **Integrations**
   - Integration mappings — repos/channels/webhooks mapped from connected accounts
   - GitHub runtime access — GitHub Apps used to mint runtime tokens
   - Plugins
   - Webhook delivery
5. **Data & governance**
   - Audit & activity
   - Import / export
   - Danger zone

### Instance

1. **Overview** — health, version, license, totals.
2. **Workspaces** — directory, creation policy, ownership, move data.
3. **Users & roles** — access and instance-admin role.
4. **Identity & sign-in** — OIDC, GitHub, Google providers.
5. **Agent governance** — requests, approvals, instance sharing, force-disable.
6. **Runtime governance** — instance-shared hosts, disable, ownership, health.
7. **Audit log** — cross-workspace events.
8. **System & backup** — build, regions, backup and restore readiness.

## Ownership rules for ambiguous resources

| Resource | Definition | Workspace use | Instance policy |
|---|---|---|---|
| Agent | Personal **Agent profile** | **Agent roster binding** with capability/capacity/engagement policy | **Agent governance** with approval/share/disable |
| Runtime | Owner-visible **Runtime inventory** | **Runtime access/config** only where the runtime is authorized | **Runtime governance** for instance sharing/disable |
| Connection | Personal **Connected account** | **Integration mapping** to repo/channel/webhook | Instance sign-in providers are separate and named **Identity & sign-in** |
| Completion | Workspace lifecycle default | Project-level override with explicit inheritance | No instance override |
| Notifications | Personal global default | Per-workspace override | Instance only configures delivery infrastructure, not personal choices |

## Interaction and accessibility risks to verify in-browser

These are code-indicated risks, not screenshot-confirmed failures:

- Settings search uses placeholder text without a programmatic label (`settings-rail.tsx:87-100`). Add an accessible name.
- Active settings, global, workspace, and admin links do not expose `aria-current="page"`; color alone appears to carry active state.
- The Activity settings button has a `title` but no explicit `aria-label`, `aria-haspopup`, or `aria-expanded`.
- The Activity popover is a plain positioned `div`, not a menu/dialog; it has no Escape handler, focus management, or focus return.
- Mobile settings navigation is a persistent top region capped at 16rem (`settings-rail.tsx:73-74`) rather than a drawer. Verify that it does not obscure the page, trap two independent scroll regions, or make later settings hard to reach.
- Dense admin and settings rail links appear shorter than the recommended mobile touch target; verify actual rendered size.
- Admin/read-only state is inconsistently communicated. Keyboard and screen-reader users may reach controls that fail only after activation.
- Thirty-seven native `<select>` elements remain across settings surfaces. Native selects are not inherently inaccessible, but label association, error association, and consistent focus styling should be tested.
- Scope changes and mutations announce success mainly through toasts; verify live-region behavior and that errors are attached to their fields.
- Reduced-motion code exists, but persistent Activity and status animations must be checked with OS and in-app reduced-motion settings.

### Required browser walkthrough

When browser access is available, capture and inspect at least these steps at desktop (1440×900), tablet (768×1024), mobile (390×844), 200% zoom, keyboard only, and reduced motion:

1. Open Mission Control and locate global Settings.
2. Open Personal settings and switch among profile, notifications, connected accounts, and developer tools.
3. Enter AXI Workspace settings from a workspace page and verify scope/return context.
4. Traverse Workspace profile, agent roster, dispatch, lifecycle, integrations, audit, and danger zone.
5. Cross from Connected accounts to an Integration mapping and back.
6. Cross from a global runtime card to its canonical detail.
7. Enter Instance settings, edit sign-in provider state, and verify the instance warning.
8. Switch scopes using keyboard only and verify focus placement/announcement.
9. Search settings with synonyms and no results.
10. Verify read-only/member and admin experiences separately.

## Migration plan

### Phase 0 — close dead ends and establish language

- Make auto-dispatch master/mode editable in Dispatch & routing.
- Fix global runtime detail routing.
- Rename the floating panel Activity and its gear Activity preferences.
- Move Authentication into Instance navigation; keep a compatibility redirect.
- Add `/settings` overview/redirect and stop defaulting Settings to Agents.
- Add a settings scope vocabulary test so nav labels cannot regress to ambiguous “Agents,” “Runtimes,” or “Admin portal.”

### Phase 1 — shared frame without URL churn

- Build `SettingsScopeHeader` and a shared scope switcher.
- Reuse current canonical routes: `/settings/*`, `/w/[slug]/settings/*`, `/admin/*`.
- Preserve `returnTo` and selected workspace across scope changes.
- Add permission metadata to the nav model and page header.
- Add Personal → Notifications using the existing preference router.

### Phase 2 — split overloaded workspace pages

- Extract lifecycle, reliability/safety, and AI from Workspace General.
- Consolidate all dispatch controls into Dispatch & routing.
- Rename resource pages according to definition/binding/governance.
- Add inheritance/effective-value components for workspace and project policy.

### Phase 3 — canonical cross-scope resources

- Finish Runtime globalization or explicitly keep a home workspace; do not maintain the current hybrid.
- Create canonical global detail pages for owner-scoped resources.
- Separate personal OAuth identities, workspace integration mappings, runtime GitHub Apps, and instance sign-in providers in copy and routes.

### Phase 4 — validate and retire aliases

- Run the screenshot walkthrough above with member, workspace-admin, and instance-admin accounts.
- Add Playwright coverage for scope switching, back behavior, role state, and responsive settings navigation.
- Keep old routes as redirects for at least one release, then remove undocumented aliases.

## Recommended next implementation slice

Implement one reviewable slice that proves the model without moving every page:

1. Add a settings overview at `/settings`.
2. Add the Personal / Workspace / Instance scope control to all three shells.
3. Rename the floating Mission Control panel to Activity.
4. Move Authentication to the Instance rail through a compatibility redirect.
5. Rename Agents and Connections at each scope.
6. Fix auto-dispatch mode and global runtime detail routing.
7. Add `aria-current`, a search label, and proper Activity-preferences popover semantics.

Acceptance criteria:

- A user can tell the effective scope on every settings page without reading the URL.
- Entering Personal settings from AXI and pressing Back returns to AXI.
- Non-instance-admins never see Instance scope or instance sign-in controls.
- Workspace members see a clear read-only state before interacting with admin-gated controls.
- “Mission Control” refers only to the cross-workspace home.
- Agent, Runtime, and Connection labels state definition, workspace use, or governance.
- Auto-dispatch mode can be changed where it is explained.
- Every runtime inventory link opens a valid, authorized detail.
- Keyboard focus and current-page state are programmatically exposed.

## Files reviewed

- `src/components/settings/settings-nav.ts`
- `src/components/settings/settings-rail.tsx`
- `src/app/(app)/settings/layout.tsx`
- `src/app/(app)/w/[slug]/settings/layout.tsx`
- `src/app/(app)/w/[slug]/settings/page.tsx`
- `src/app/(app)/w/[slug]/settings/workspace/page.tsx`
- `src/app/(app)/w/[slug]/settings/dispatch-rules/page.tsx`
- `src/app/(app)/settings/agents/*`
- `src/app/(app)/settings/runtimes/page.tsx`
- `src/app/(app)/settings/connections/page.tsx`
- `src/app/(app)/w/[slug]/settings/agents/page.tsx`
- `src/app/(app)/w/[slug]/settings/runtimes/*`
- `src/app/(app)/w/[slug]/settings/connections/*`
- `src/components/global-shell/global-shell.tsx`
- `src/components/admin-shell/admin-shell.tsx`
- `src/components/mission-control/mission-control.tsx`
- `src/components/mission-control/settings-popover.tsx`
- `src/server/routers/workspace.ts`
- `src/server/routers/runtime.ts`
- `src/server/routers/notification.ts`
- `src/server/routers/instance-admin.ts`
- `src/server/routers/agent-profile.ts`
- `prisma/schema.prisma`
- `docs/plans/multiws-restructure.md`
