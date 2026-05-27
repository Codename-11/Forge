# Agent Profiles & Bindings

An agent in Forge isn't a single row. It's a **three-tier** model:

1. A global **profile** — the agent's definition (who it is, what it
   can do), owned by a user, independent of any workspace.
2. A per-workspace **binding** — a workspace adopting that profile,
   with its own *policy* (capacity, capability overrides, dispatch
   eligibility, engagement mode, approval gate).
3. **Instance policy** — the instance admin's governance layer:
   sharing a profile to every workspace, or force-disabling it.

This is why the same `victor` can work in three workspaces with
different capacity and dispatch rules in each, while staying one
identity everywhere.

## Tier 1 — Profiles (the definition)

A **profile** (`AgentProfile`) is the source of truth for an agent's
identity: its `profileKey` (the stable cross-system handle, matching
the Hermes profile directory name), name, avatar, `provider`,
`runEngine`, default `runtimeId`, `baseCapabilities`, role, and
template. It's owned by a user and lives outside any workspace.

`profileKey` is **unique per owner**, so two different users can each
own a `victor` without colliding.

Manage profiles at **`/settings/agents`** (the global, account-level
agents page). This is also where your profiles surface on
[Mission Control](/guide/mission-control.html#my-agents).

## Tier 2 — Bindings (the policy)

A **binding** is an `Agent` row: a workspace adopting a profile via
`Agent.profileId`. Binding copies the profile's definition into the
workspace, then layers per-workspace **policy** on top:

| Binding policy | Column | What it does |
|---|---|---|
| Capacity | `maxConcurrent` | Cap on simultaneously-claimed issues (0 = unlimited) |
| Capability overrides | `capabilities` | Per-workspace tags (default: the profile's `baseCapabilities`) — feed `CAPABILITY_MATCH` |
| Auto-dispatch eligibility | `autoDispatchEligible` | When false, never auto-picked here — manual assignment only |
| Engagement mode | `engagementMode` | Per-binding default; null = inherit `Workspace.assignmentEngagementMode` |
| Approval gate | `requireApprovalBeforeStart` | Per-binding override of the workspace approval gate |

Bind, set policy, and unbind from the workspace agents page at
**`/w/[slug]/settings/agents`**. The **catalog** there lists the
profiles available to bind (ones you own, plus instance-shared ones)
that aren't already bound. All three actions — `bind`, `setPolicy`,
`unbind` — are workspace-admin-gated.

::: tip Unbinding is non-destructive
Unbinding archives the binding; runs, chats, and history are preserved.
Re-binding the same profile reuses the archived row.
:::

## Tier 3 — Instance policy

Two governance levers belong to the instance admin (see
[Instance admin](/guide/instance-admin.html)):

- **`instanceShared`** — when set, the profile appears in *every*
  workspace's bind-catalog, not just the owner's. This is how a shared
  fleet agent becomes adoptable org-wide.
- **`disabledAt`** — a force-disable. A disabled profile (and all its
  bindings) refuses dispatch and chat. Distinct from `archivedAt`
  (deletion).

## Requesting a profile

Defining a *new* profile from scratch is instance-admin-only — but any
member can **request** one:

1. A member calls `agentProfile.request` (the **Request a profile**
   action on the workspace agents page) with a `profileKey`, name, and
   base capabilities. This creates a **pending** profile
   (`requestedById` = the requester, `approvedAt` = null).
2. A pending profile is **not bindable** — it's hidden from every
   bind-catalog until approved.
3. An instance admin reviews pending requests
   (`agentProfile.listPending`) and either **approves** (`approvedAt`
   set → now bindable) or **rejects** (archived).

Profiles created directly by an instance admin skip this — they're
pre-approved at creation (`requestedById` stays null).

## How this composes with the rest

- **Engagement mode** — a binding's `engagementMode` sets the default
  *intent* (Execute / Research / Review / Discuss) for work dispatched
  to that agent in that workspace; null inherits the workspace default.
  See [Engagement modes](/agents/engagement-modes.html).
- **Runtimes** — a profile points at a default `runtimeId` (the compute
  host); the binding inherits it. See [Runtimes](/agents/runtimes.html).
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
