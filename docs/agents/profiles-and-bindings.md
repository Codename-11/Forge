# Agent Profiles & Bindings

An agent in Forge isn't a single row. It's a **three-tier** model:

1. A global **profile** — the agent's definition (who it is, what it
   can do), owned by a user, independent of any workspace.
2. A per-workspace **binding** — a workspace adopting that profile,
   with its own _policy_ (capacity, capability overrides, dispatch
   eligibility, engagement mode, approval gate).
3. **Instance policy** — the instance admin's governance layer:
   sharing a profile to every workspace, or force-disabling it.

This is why the same `victor` can work in three workspaces with
different capacity and dispatch rules in each, while staying one
identity everywhere.

## Tier 1 — Profiles (the definition)

A **profile** (`AgentProfile`) is the source of truth for an agent's
identity and execution: its `profileKey` (the stable cross-system handle,
matching the Hermes profile directory name), name, avatar, `provider`,
`runEngine`, zero-or-one primary `runtimeId`, `baseCapabilities`, role, and
template. It's owned by a user and lives outside any workspace.

`profileKey` is **unique per owner**, so two different users can each
own a `victor` without colliding.

Manage profiles in **Mission Control → Agents** at **`/agents`**. Its detail
view reports runtime, workspace-binding, MCP-client readiness, and recent work;
it is the primary place to create, edit, connect, bind, archive, or safely
remove an identity. The former `/settings/agents` and
`/settings/agents/[id]` routes redirect here so bookmarks remain valid.

Updating a profile synchronizes its identity and execution fields into every
active workspace binding. Binding policy such as capacity and capability
overrides is deliberately preserved.

## Tier 2 — Bindings (the policy)

A **binding** is an `Agent` row: a workspace adopting a profile via
`Agent.profileId`. Binding copies the profile's definition into the
workspace, then layers per-workspace **policy** on top:

| Binding policy            | Column                       | What it does                                                                             |
| ------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| Capacity                  | `maxConcurrent`              | Cap on simultaneously-claimed issues (0 = unlimited)                                     |
| Capability overrides      | `capabilities`               | Per-workspace tags (default: the profile's `baseCapabilities`) — feed `CAPABILITY_MATCH` |
| Auto-dispatch eligibility | `autoDispatchEligible`       | When false, never auto-picked here — manual assignment only                              |
| Engagement mode           | `engagementMode`             | Per-binding default; null = inherit `Workspace.assignmentEngagementMode`                 |
| Approval gate             | `requireApprovalBeforeStart` | Per-binding override of the workspace approval gate                                      |

Bind and unbind from a profile's **Workspace bindings** section in Mission
Control. The workspace selector only offers workspaces where the caller is an
owner or admin, and the server repeats that authorization check before every
write. Workspace settings at **`/w/[slug]/settings/agents`** retain only
workspace policy: capacity, capability overrides, routing eligibility,
engagement mode, and approval gates.

::: tip Unbind vs Delete
**Unbind** archives the binding (reversible) — runs, chats, and history are
preserved, and re-binding the same profile reuses the archived row. Workspace
admins can unbind but cannot delete the global identity.
:::

## Tier 3 — Instance policy

Two governance levers belong to the instance admin (see
[Instance admin](/guide/instance-admin.html)):

- **`instanceShared`** — when set, the profile appears in _every_
  workspace's bind-catalog, not just the owner's. This is how a shared
  fleet agent becomes adoptable org-wide.
- **`disabledAt`** — a force-disable. A disabled profile (and all its
  bindings) refuses dispatch and chat. Distinct from `archivedAt`
  (deletion).
- **Approve or reject** — pending profile requests remain instance-governed.

Instance Admin → Agent governance intentionally does not duplicate routine
profile management. Each row links to Mission Control, where an instance admin
gets the safe **Remove profile** action (`agents.profiles.remove`): it deletes a
profile no workspace has bound, and archives one that still has bindings so
agents and history are not orphaned. Profile owners who are not instance admins
get **Archive profile** instead.

## Requesting a profile

Defining a _new_ profile from scratch is instance-admin-only — but any
member can **request** one:

1. A member calls `agentProfile.request` (the **Request profile** action in
   Mission Control → Agents) with a `profileKey`, name, and
   base capabilities. This creates a **pending** profile
   (`requestedById` = the requester, `approvedAt` = null).
2. A pending profile is **not bindable** — it's hidden from every
   bind-catalog until approved.
3. An instance admin reviews pending requests
   (`agentProfile.listPending`) and either **approves** (`approvedAt`
   set → now bindable) or **rejects** (archived).

Profiles created directly by an instance admin skip this — they're
pre-approved at creation (`requestedById` stays null).

## MCP clients (the connection credentials)

MCP clients are **not execution runtimes**. A profile has at most one primary
runtime, while each workspace binding may have any number of linked `ApiKey`
credentials for Codex, Claude, Hermes, or other trusted MCP clients.

Create, inspect, rotate, revoke, and remove those credentials at
**`/w/[slug]/settings/access`**. Mission Control aggregates the linked clients by
binding and deep-links into Agent access with the correct workspace agent
preselected. The former `/settings/clients` and
`/w/[slug]/settings/clients` inventory routes redirect to Agent access.

## How this composes with the rest

- **Engagement mode** — a binding's `engagementMode` sets the default
  _intent_ (Execute / Research / Review / Discuss) for work dispatched
  to that agent in that workspace; null inherits the workspace default.
  See [Engagement modes](/agents/engagement-modes.html).
- **Runtimes** — a profile points at zero-or-one primary `runtimeId` (the
  execution host); every active binding inherits profile execution changes.
  See [Runtimes](/agents/runtimes.html).
- **MCP clients** — each binding can hold zero-or-many linked credentials;
  these authenticate clients but do not replace the primary execution runtime.
- **Auto-dispatch** — `autoDispatchEligible` and the binding's
  `capabilities` feed the workspace dispatcher; `autoDispatchMode`
  (which agent gets picked) is a different axis from engagement mode
  (what the picked agent is asked to do). See
  [Auto-dispatch](/agents/auto-dispatch.html).

## Cross-references

- [Engagement modes](/agents/engagement-modes.html) — the per-binding
  `engagementMode` default.
- [Runtimes](/agents/runtimes.html) — the compute host a profile binds to.
- [Auto-dispatch](/agents/auto-dispatch.html) — eligibility +
  capabilities in dispatch.
- [Instance admin](/guide/instance-admin.html) — instance sharing,
  disabling, and request approval.
- [Mission Control](/guide/mission-control.html) — the cross-workspace
  view of your profiles and their bindings.
