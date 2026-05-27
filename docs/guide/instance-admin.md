# Instance Admin

`/admin` is the instance-operator surface — the controls that span
*every* tenant on a Forge instance, rather than one workspace. It renders
in its own graphite shell (distinct from the warm-paper workspace shell)
to make it obvious you've stepped up a level.

## Who can access it

The `/admin` area is gated on `User.instanceRole === INSTANCE_ADMIN`.
There are exactly two instance roles:

| `InstanceRole` | Grants |
|---|---|
| `INSTANCE_ADMIN` | The `/admin` shell + every `instanceAdmin.*` procedure |
| `MEMBER` | Default; no instance-level access |

This is **orthogonal to workspace roles**. Being `OWNER` of a workspace
doesn't make you an instance admin, and an instance admin isn't
automatically a member of every workspace. A bootstrap `ADMIN_EMAIL`
fallback lets the first operator in before any role is set.

::: warning Last-admin guard
You cannot demote the last remaining instance admin — `setInstanceRole`
refuses it. There is always at least one `INSTANCE_ADMIN`.
:::

## The pages

The admin shell has a fixed set of pages, each backed by an
`instanceAdmin.*` query:

### Overview / System (`/admin/system`)

Build identity and instance-wide rollups. Reports the running
`version`, `buildSha`, and `buildTime` (baked into the Docker image as
`FORGE_GIT_SHA` / `FORGE_BUILD_TIME` — the same source as
`system.buildInfo` and the Settings → About line), plus counts:
tenants, users, admins, runtimes, profiles, connections, and runs in
the last 24h.

### Tenants (`/admin/tenants`)

Every non-deleted workspace with rollup stats — member count, issue
count, owner, and runs in the last 24h. Instance admins can also
**create a tenant** here (mirrors `workspace.create` — seeded statuses,
labels, and the first sprint — with the creating admin set as `OWNER`
so they can manage it immediately).

### Users (`/admin/users`)

Every user on the instance, with their instance role, workspace count,
and handle. Promote or demote a user's `instanceRole` inline, and
invite a new user (optionally as an instance admin). This is the only
place instance role is set.

### Runtimes (`/admin/runtimes`)

Every runtime across the instance — not just the caller's. Shows kind,
adapter, owner, bound-agent count, whether it's `instanceShared` or
disabled, and an online pip (online = enabled, heartbeat within the
last 5 minutes). This is the instance-wide view; the per-workspace
runtime surface lives under `/settings/runtimes`. See
[Runtimes](/agents/runtimes.html).

### Audit (`/admin/audit`)

A cross-workspace, cursor-paginated feed of `ActivityEvent` rows —
every tenant's activity in one stream, with the actor and originating
workspace stamped on each row. Distinct from a workspace's own
`admin.*` observability view, which is scoped to that tenant.

## Related: pending agent-profile approvals

Instance admins also own the **profile-request approval** flow. When a
member requests an agent profile, it lands as a pending request only an
instance admin can approve or reject (`agentProfile.listPending` →
`approve` / `reject`), and only instance admins can mark a profile
`instanceShared` or force-disable one. See
[Agent profiles & bindings](/agents/profiles-and-bindings.html#requesting-a-profile).

## Where to next

- [Mission Control](/guide/mission-control.html) — the cross-workspace
  *user* home (read-only), separate from this operator surface.
- [Agent profiles & bindings](/agents/profiles-and-bindings.html) — the
  approval + instance-sharing flow admins govern.
- [Runtimes](/agents/runtimes.html) — the compute hosts the instance
  runtimes page lists.
