# App Flow Enhancements Audit
## Agents · Runtimes · Profiles · Connections · Access · MCP Clients

**Scope:** Instance Admin → Mission Control → Workspace settings flow for Agents, Runtimes, Agent Profiles, Connections, Access/API keys, and MCP/session clients.
**Operator concern:** Adding and managing ephemeral clients (Claude Code, Codex CLI) is confusing; edit/remove flows are unclear; blocked/runtime diagnostics lack actionable UI.

---

## Executive Summary

Forge's agent/runtime surface is architecturally correct but navigationally fragmented. The mental model is sound — global profile definition, workspace binding, runtime host, API key — but operators cannot discover or traverse it without prior knowledge. Ephemeral MCP clients (Claude Code, Codex CLI) exist in the adapter and key models but are never surfaced as manageable connection instances. Self-test diagnostics are available but buried. The result is a first-run experience that requires reading docs, trying multiple settings screens, and inferring the correct creation order. The fix is not a rewrite: it is a unified "Add agent/client" wizard, a first-class Agent Clients surface, and global promotion of runtime health signals.

---

## Current IA Map

```
Account Settings (/settings/…)
├── Agents                  global profile definitions, provider/runtime/bindings display
│   └── [id]                prompt/template editing only; definition fields display-only
├── Runtimes                (rail item — points to workspace scope)
├── Connections             (rail item — points to workspace scope)
└── Developer Access        /settings/access
    ├── Provider cards      Hermes · Claude · Codex · Custom
    ├── Registered Agents   register-agent wizard (Provider/Scopes/Context/Review)
    ├── Personal Access Tokens
    ├── Session Keys        ephemeral one-off tasks
    └── Key reveal          MCP integration blocks + Test MCP

Workspace Settings (/w/[slug]/settings/…)
├── Automation → Agents     Definition → Binding → Instance policy; unbind row action
├── Connections             GitHub Apps · Plugins
├── Runtimes                managed runtime CRUD; self-test/edit/disable/archive per row
│   └── [id]                self-test detail · RuntimeSelfTestNotice · Fix in Chat
│                           Runtime env/version metadata · Codex Docker bridge panel
│                           Provisioning section → /settings/access + provision script
└── Developer (account-level nav item, redirects to /settings/access)

Instance Admin (/admin/…)
├── Agents                  pending approval · instance sharing · force disable (policy only)
└── Runtimes                instance-wide runtime health/self-test/info (read-only)
```

**Key router mounts (`src/server/routers/_app.ts`)**

| Router | Mount line |
|--------|-----------|
| `access` | 61 |
| `agents.profiles.*` (global) | 66 |
| `agents.bindings.*` (workspace policy) | 67 |
| `instanceAdmin` | 72 |
| `runtime` | 108 |

**Nav config sources**

- Account settings rail prepends global Agents/Runtimes/Connections before account items: `src/components/settings/settings-rail.tsx:200-232`
- Workspace settings puts Agents under Automation, Connections/GitHub Apps/Plugins under Connections: `src/components/settings/settings-nav.ts:119-160`
- Developer Access is account-level: `settings-nav.ts:221-224`
- Instance Admin has Agent policy and Runtimes: `src/components/admin-shell/admin-shell.tsx:17-27`

---

## User Journeys

### J1 — "I want to connect Claude Code to Forge"

1. Operator lands on Mission Control. No entry point visible.
2. Navigates to Workspace → Runtimes. Sees "Add managed runtime". Clicks it. Adapter list is managed-only (`runtime.ts:509-519`). Claude Code is not there. Dead end.
3. Navigates to `/settings/access`. Reads provider cards. Clicks Claude. Registers an agent. Gets a key. Key reveal shows MCP snippets for Claude Code (`mcp-integration-blocks.tsx:42-140`).
4. Copies config manually. No indication whether it worked. No session row appears anywhere.
5. Operator never knows if the Claude Code client is connected, when it last connected, or which workspace it touches.

### J2 — "I want to create a new persistent agent"

1. Navigates to `/settings/agents`. Topbar says profiles are global identities (`agents-content.tsx:53-56`).
2. Sees "New profile" label. It is a non-clickable span, not a button (`agents-content.tsx:59-78`). Admin-gated but no feedback for non-admins.
3. Navigates to workspace Agents page. Reads Definition → Binding → Instance policy explanation (`w/[slug]/settings/agents/page.tsx:114-135`). Empty catalog points to `/settings/agents` (`agents/page.tsx:248-260`).
4. Non-admin uses Request flow: collects name/profileKey/provider/runEngine/capabilities (`request-profile-dialog.tsx:74-162`). No runtime or key fields. Request submitted. Waits for admin approval.
5. Admin approves via `/admin/agents`. No provisioning step linked from the approval action.
6. Agent appears in workspace catalog. Operator binds it. Still no key or runtime assigned.

### J3 — "A runtime is failing; I need to fix it"

1. Operator notices stalled AgentRuns in Mission Control. No runtime health signal is present there.
2. Navigates to Workspace → Runtimes. Finds the row. Clicks self-test. Sees detail in `[id]/page.tsx:301-350`. `RuntimeSelfTestNotice` offers Fix in Chat, Edit runtime, Run self-test (`runtime-self-test.tsx:174-260`).
3. Fix in Chat opens a draft with health/self-test data (`runtimes/[id]/page.tsx:651-675`). Useful, but requires knowing to navigate here first.

### J4 — "I want to revoke a session client"

1. Operator cannot list active MCP session clients anywhere. Keys are visible in `/settings/access` but only as rows without last-used, workspace, or setup status.
2. Revoke exists on the key row. No way to know if the key is attached to an active Claude Code session or which workspace it belongs to.

---

## Findings (Severity Order)

### SEV-1 — No unified "Add agent/client" entry point

**Impact:** Every operator journey requires knowing the correct primitive order before starting. Managed runtimes, session clients, profile definitions, workspace bindings, and API keys are created in four separate settings surfaces with no cross-linking at creation time.

**Files:** `settings-rail.tsx:200-232`, `settings-nav.ts:119-160`, `access/page.tsx:680-845`, `agents/page.tsx:248-260`

---

### SEV-1 — Ephemeral clients are keys, not first-class connection instances

**Impact:** Claude Code, Codex CLI, and Claude Desktop are `managed: false` adapters with `autoProvisionable: true` (`adapters.ts:250-307`). After key creation they vanish from the UI. Operators cannot see which ephemeral clients are active, when they last connected, which workspace they touch, or revoke them with context. There is no "Clients" or "Sessions" list.

**Files:** `src/server/runtimes/adapters.ts:250-307`, `access/page.tsx:603-674`, `mcp-integration-blocks.tsx:42-140`

---

### SEV-1 — Runtime create UI excludes session adapters silently

**Impact:** The Runtimes page and "Add managed runtime" modal title imply completeness. The adapter list comes from `managedAdapters()` only (`runtime.ts:509-519`). Claude Code/Codex CLI operators look here and find nothing, with no redirect or explanation.

**Files:** `src/app/(app)/w/[slug]/settings/runtimes/page.tsx:1185-1191`, `src/server/routers/runtime.ts:509-519`

---

### SEV-2 — Global agent profile has no create/edit/delete UI

**Impact:** "New profile" is a non-clickable span (`agents-content.tsx:59-78`). Profile detail edits only prompt/template markdown (`agent-detail-content.tsx:205-260`); definition, provider, and runtime fields are display-only (`agent-detail-content.tsx:151-202`). Admin creation path is via the approval queue, not direct create.

**Files:** `src/app/(app)/settings/agents/agents-content.tsx:59-78`, `src/app/(app)/settings/agents/[id]/agent-detail-content.tsx:151-260`

---

### SEV-2 — Request flow missing runtime/key/provisioning fields

**Impact:** Non-admin profile request collects name/profileKey/provider/runEngine/capabilities (`request-profile-dialog.tsx:74-162`) but no runtime, key kind, or provisioning context. Admin approvals arrive with incomplete information. Runtime provisioning section tells operators to visit `/settings/access` separately after the fact (`runtime-provisioning.tsx:1-75`).

**Files:** `src/app/(app)/w/[slug]/settings/agents/request-profile-dialog.tsx:74-162`, `src/components/settings/runtime-provisioning.tsx:1-75`

---

### SEV-2 — Runtime health not surfaced in Mission Control or Dashboard

**Impact:** Blocked runtimes only appear after navigating Workspace → Runtimes → row → detail. No actionable health signal exists in Mission Control, Command Center, or the dashboard. `RuntimeSelfTestNotice` with Fix in Chat is unreachable until the operator already knows a runtime is unhealthy (`runtime-self-test.tsx:174-260`).

**Files:** `src/app/(app)/w/[slug]/settings/runtimes/[id]/page.tsx:301-350`, `src/components/settings/runtime-self-test.tsx:174-260`

---

### SEV-3 — Instance Admin / Settings hierarchy is unclear

**Impact:** Instance Admin has Agents (governance) and Runtimes (observability). Account Settings has Agents (global definitions). Workspace Settings has Agents (bindings) and Runtimes (managed hosts). The three-layer split is architecturally correct but the rail labels and nav groupings give no signal about which layer owns creation vs. governance vs. policy.

**Files:** `admin-shell.tsx:17-27`, `settings-rail.tsx:200-232`, `settings-nav.ts:119-160`

---

### SEV-3 — "Fix in Chat" is the only guided recovery path; no inline remediation

**Impact:** Fix in Chat drafts a message with runtime health data (`runtimes/[id]/page.tsx:651-675`). Common failures (missing env var, wrong endpoint, expired key) could be resolved with inline form actions rather than dropping into a chat flow.

**Files:** `src/app/(app)/w/[slug]/settings/runtimes/[id]/page.tsx:651-675`, `src/components/settings/runtime-self-test.tsx:174-260`

---

## Product Model Recommendation

### Layer responsibilities (clarified, not restructured)

| Layer | Owns | Does NOT own |
|-------|------|-------------|
| Instance Admin | Profile approval, instance sharing, force-disable, global runtime observability | Creation of any primitive |
| Account Settings — Agents | Global profile definitions (create/edit/delete for admins) | Workspace binding, key creation |
| Account Settings — Agent Clients *(new)* | MCP/session clients: Claude Code, Codex CLI, Claude Desktop, Hermes key, custom HTTP | Managed runtimes |
| Account Settings — Developer Access | API keys, personal tokens, session keys, register-agent wizard | Agent Clients surface |
| Workspace Settings — Agents | Workspace binding and policy (Definition → Binding → Instance) | Profile definition |
| Workspace Settings — Runtimes | Managed runtime hosts: create/edit/self-test/disable/archive | Session adapters |

### New: Agent Clients surface (`/settings/clients`)

Each row is one MCP/session client derived from an access key. Columns:

- Provider (Claude Code / Codex CLI / Claude Desktop / Hermes / Custom)
- Key kind (SESSION / PERSONAL / AGENT)
- Expiry / TTL remaining
- Linked agent (profileKey if linked)
- Scopes
- Last used (from key audit log or runtime heartbeat)
- Setup status (never connected / connected / stale)
- Actions: Revoke · Copy config · Rerun MCP test · Convert/bind to workspace

Entry points: Mission Control sidebar, Account Settings rail (between Agents and Developer Access), Workspace Settings → Agents empty state, key reveal flow after creation.

### New: Unified "Add agent/client" wizard

Reachable from: Mission Control, Workspace Settings → Agents, Account Settings → Agents, Account Settings → Developer Access, Runtime detail.

**Step 1 — Intent**

| Choice | Creates |
|--------|---------|
| Persistent hosted agent | Profile definition → workspace binding → managed runtime (if needed) → AGENT key |
| Ephemeral session client | SESSION or PERSONAL key → MCP snippet → Agent Clients row |
| Chat-capable managed runtime | Runtime row (managed adapter) → key → bindings |
| Webhook / custom | Profile definition → AGENT key → webhook config |

**Step 2–N** — collects only the fields the chosen path needs, with inline breadcrumbs showing which primitives have been created. No dead ends; each step links to the relevant settings page if the operator exits early.

---

## Proposed UI/UX Flow

```
Mission Control
└── [Runtime health banner] — degraded runtimes with inline "View" / "Fix in Chat"
└── Sidebar → "Add agent or client" → unified wizard

Account Settings
├── Agents          — list + "New profile" (admin: opens create form; non-admin: opens request)
├── Agent Clients   — list of MCP/session clients with status, last-used, revoke, copy config
└── Developer Access — keys, tokens, register-agent (links to wizard for intent)

Workspace Settings
├── Agents          — binding table; empty catalog links to wizard, not /settings/agents raw
└── Runtimes        — managed hosts only; non-managed callout with link to Agent Clients

Instance Admin
├── Agents          — approval queue + share/disable (no create)
└── Runtimes        — global health table (read-only, links to workspace runtime detail)
```

**Runtime self-test UX improvement:** `RuntimeSelfTestNotice` gains a "Common fixes" inline accordion per failure type (missing env var, endpoint unreachable, key expired, version mismatch). Fix in Chat remains as the escalation path, not the first-resort path.

---

## Phased Implementation Plan

### Phase 1 — Foundational clarity (no schema changes)

1. **Rename "Add managed runtime" modal** to "Add runtime host" and add a callout: "For ephemeral clients (Claude Code, Codex CLI) use Developer Access → Add session client" with a link to `/settings/access`.
   - `runtimes/page.tsx:1185-1191`

2. **Make "New profile" clickable** for admins (opens create modal) and for non-admins (opens request dialog). Non-admin dialog adds runtime and key kind fields to the request payload.
   - `agents-content.tsx:59-78`, `request-profile-dialog.tsx:74-162`

3. **Add Agent Clients tab** to `/settings/access` (or a new `/settings/clients` route). Reads from existing key rows filtered by kind=SESSION and PERSONAL keys with linked MCP snippets. Adds last-used column from key audit log. Adds Revoke and Copy config actions. No new backend required in Phase 1.

4. **Surface runtime health in Mission Control.** Add a collapsed banner above the run list when any workspace runtime is in a failed/stale self-test state. Banner items link directly to `runtimes/[id]`. Reuses existing `runtime.list` + `selfTest` fields.

### Phase 2 — Unified wizard

5. **Build unified "Add agent/client" wizard.** Modal with Intent step → conditional field steps → confirmation with breadcrumb of created primitives. Calls existing tRPC mutations in sequence. Entry points added to Mission Control, workspace agents empty state, and developer access header.

6. **Inline common-fix accordion in `RuntimeSelfTestNotice`.** Map self-test error codes to fix steps (missing env var → show var name; endpoint unreachable → show curl command; key expired → link to revoke+reissue). Fix in Chat remains as overflow.
   - `runtime-self-test.tsx:174-260`

### Phase 3 — Agent Clients as first-class instances

7. **Extend `ApiKey`** with `lastSeenAt`, `remoteAddr`, `setupConfirmedAt` columns. Populate from MCP auth middleware on each authenticated call. Enables accurate setup status and last-used display.

8. **Convert-to-workspace-binding flow.** From an Agent Clients row, operator picks a workspace and the wizard creates a binding for the linked agent in that workspace.

9. **Auto-provision flow for SESSION keys.** After SESSION key creation, show an inline terminal snippet (`forge provision --key <KEY> --workspace <SLUG>`) that calls the runtime provisioning script referenced in `runtime-provisioning.tsx:1-75`. Track provision status.

### Phase 4 — Global diagnostics

10. **Instance Admin Runtimes → actionable.** Add per-row self-test re-run and link-to-workspace-detail to `admin-runtimes.tsx`. Currently read-only.
    - `src/components/admin-shell/admin-runtimes.tsx:1-140`

11. **Dashboard health widget.** Counts of online/degraded/offline runtimes and active/stale clients. Links to Runtimes and Agent Clients surfaces.

---

## Open Questions

1. **Agent Clients as tab vs. new route?** Putting it inside `/settings/access` keeps keys and clients co-located but the page is already long (`access/page.tsx:465-1128`). A dedicated `/settings/clients` route is cleaner but adds a nav item.

2. **`lastSeenAt` source of truth.** MCP auth middleware (accurate, write-on-read), runtime heartbeat (coarser, 60s), or a separate audit event? Decision affects Phase 3 schema and write volume.

3. **Non-admin profile create scope.** Should workspace admins create profiles scoped to their workspace? Requires either workspace-scoped profiles or a binding-with-inline-definition pattern — neither exists today.

4. **Wizard as modal vs. page.** A modal works for simple intents (ephemeral client) but multi-step wizard flows for persistent agents with runtime provisioning benefit from more vertical space and bookmark-ability.

5. **"Fix in Chat" routing.** Fix in Chat currently drafts to the agent assigned to the runtime's workspace. Should it route to a specific support agent (e.g. Victor) or the first ONLINE agent in the workspace? Needs a routing decision before Phase 2.

6. **Admin direct-create gap.** `agents.profiles.create` tRPC procedure needs to be confirmed as admin-accessible at `_app.ts:66` before Phase 1 ships the admin create modal.
