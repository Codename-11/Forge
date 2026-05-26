# Multi-workspace restructure — three-tier ownership

> Status: **in progress** (Phase 1). Started 2026-05-26 on branch
> `worktree-multiws-restructure`. Driven by the Claude Design handoff
> "Forge Screens Board" + the three design chats (multi-workspace
> architecture redesign). This doc is the canonical brief; the design
> bundle screens are the visual source of truth.

## Goal

Restructure Forge from a strictly workspace-scoped model into a
three-tier ownership model:

1. **Global (user-owned)** — `AgentProfile`, `Runtime`, and `Connection`
   (OAuth identities) are defined once at the user level. `profileKey`
   is the global identity.
2. **Workspace (binding)** — workspaces no longer *define* agents /
   connections; they *bind* and *map*. The existing `Agent` row **is**
   the per-workspace binding; it carries per-workspace policy
   (`maxConcurrent`, capability overrides, auto-dispatch eligibility,
   engagement mode). Connection settings map global identities to
   channels / repos / webhooks.
3. **Instance (admin)** — a new `/admin` shell with its own chrome for
   license, tenants, users, instance-wide runtimes, audit, system info.
   Instance admins mark profiles instance-shared and force-disable.

## Resolved architectural decisions (confirmed with Bailey 2026-05-26)

1. **`Agent` row = the binding (NOT a rename).** We keep the existing
   `Agent` table as the `AgentWorkspaceBinding`. We add a new global
   `AgentProfile` (definition) that `Agent.profileId` references. This
   means **every existing FK keeps working unchanged** —
   `AgentRun.agentId`, `Issue.assignedAgentId`, `ChatThread.agentId`,
   `ApiKey.linkedAgentId`, dispatch, MCP `agents.*`, the `forge` CLI,
   Hermes integration. The profile is the source of truth for the
   *definition*; the binding's columns (provider, runEngine, runtimeId,
   capabilities, avatar, webhook) become *effective/override* values and
   are retained for back-compat during transition.
2. **`profileKey` is unique per owner** — `@@unique([ownerId, profileKey])`.
   Two users can each own a `victor`. Matches a genuine multi-user
   self-hosted instance; `profileKey` stays the per-user stable handle
   that maps to a Hermes profile directory.
3. **Connections = model + mapping + read UI now; generic OAuth.** No
   OAuth-identity model exists today. We add `Connection` (global,
   user-owned) + `ConnectionMapping` (workspace-scoped), modelled on the
   existing `SsoProvider`/`SsoType` generic pattern (OIDC + GitHub /
   Google / Slack / Custom) so operators configure their own IdP
   (Authelia, Authentik, Keycloak, GitHub, Google, …). Token acquisition
   is configurable but the full live OAuth dance is incremental.
4. **Read-only cross-workspace; writes require entering a workspace.**
5. **Three shells** — workspace (existing, warm/dense), global
   (paler "concourse", read-only, workspace switcher), admin (cooler
   graphite, instance-scope warning bar).
6. **Mission Control rename** — the chord-5 overlay becomes **Activity**
   (chord G 5, 7 tabs: Live, Queue, Agents, History, Chat, Admin, Plans);
   the brand name **Mission Control** moves to the new global home `/`.
7. **Drop `/w/[slug]/personal`** — subsumed by global Mission Control.
8. **Instance admin via `User.instanceRole`** (enum), replacing the
   env-only `ADMIN_EMAIL` gate (kept as bootstrap fallback).

## Expand/contract migration strategy (LIVE system)

Prod builds from the working tree and the deploy entrypoint auto-runs
`prisma migrate deploy`. Therefore:

- **Migrations are DDL-only and additive.** New enum, new *optional*
  columns (defaulted / nullable), new tables. Existing code compiles
  and runs unchanged against the new schema before any consumer is
  updated.
- **Data backfill is a separate idempotent script**
  (`prisma/backfill-multiws.ts`), run *explicitly*, never auto-applied
  on deploy. Until it runs, `Agent.profileId` is null and the app
  treats the binding's own columns as the definition (transitional).
- Consumers are updated to prefer `profile.*` with fallback to the
  binding's own columns, so order of operations is safe.

## Phases

- **Phase 1 — Schema foundation (additive)** ← *current*
  - `enum InstanceRole { INSTANCE_ADMIN, MEMBER }`, `User.instanceRole`.
  - `AgentProfile` (global), `Agent.profileId` + binding policy columns
    (`autoDispatchEligible`, `engagementMode`).
  - `Connection` + `ConnectionMapping`, `enum ConnectionProvider`,
    `enum ConnectionStatus`.
  - `instanceAdminProcedure` honors `User.instanceRole` (DB-checked) with
    `ADMIN_EMAIL` fallback; auth bootstrap sets the admin's role.
  - `prisma/backfill-multiws.ts` (idempotent): create one `AgentProfile`
    per (workspace-owner, profileKey); link `Agent.profileId`; backfill
    `Runtime.ownerId` from the workspace owner where null; set
    `instanceRole=INSTANCE_ADMIN` for the bootstrap admin email.
- **Phase 2 — Routers + globalize Runtime**
  - Make `Runtime.workspaceId` nullable (global), `instanceShared`.
  - Split routers: `agents.profiles.*` (global) / `agents.bindings.*`
    (workspace); `runtimes.*` global + workspace views; `connections.*`
    global + `connectionMappings.*` workspace. New `global.*` router for
    Mission Control aggregations; expand `admin.*`.
  - Add `globalProcedure` (session, no workspace; fans out across the
    caller's memberships, read-only).
- **Phase 3 — Shells + global/admin routes**
  - Global shell + Admin shell components; `/` Mission Control,
    `/settings/workspaces|agents|agents/[key]|runtimes|connections|account`,
    `/admin/*`. Workspace switcher (sidebar, ⌘K, picker page).
  - Rename Mission Control overlay → Activity (7 tabs).
- **Phase 4 — Workspace-side surfaces**
  - `/w/[slug]/settings/agents` → binding catalog + per-binding policy
    (Definition → Binding → Instance policy explainer).
  - `/w/[slug]/settings/connections` → mapping page.
  - Dispatch-rules banner (rules target bound agents only).
  - Remove `/w/[slug]/personal`.
- **Phase 5 — Integration + polish**
  - MCP `agents.*` profile/binding awareness; `forge` CLI; seed data;
    CHANGELOG + DEVLOG; vitest + e2e.

## Design bundle (handoff) map — for the UI phases

`$CLAUDE_JOB_DIR/handoff/forge-design-system/project/js/`:
- `global-data.jsx` — the assumed post-restructure data shapes.
- `screens-restructure.jsx` — workspace bindings, connection mappings,
  instance admin overview.
- `screens-global.jsx` — A–G global screens incl. Mission Control.
- `global-shell.jsx` — global + admin shell chrome.
- `screens-activity.jsx` — the 7-tab Activity dock.
- `screens-settings.jsx` — settings surfaces (109 KB).
