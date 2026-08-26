# Instance Admin

`/admin` is the instance-operator surface — the controls that span
_every_ tenant on a Forge instance, rather than one workspace. It renders
in its own graphite shell (distinct from the warm-paper workspace shell)
to make it obvious you've stepped up a level.

## Who can access it

The `/admin` area is gated on `User.instanceRole === INSTANCE_ADMIN`.
There are exactly two instance roles:

| `InstanceRole`   | Grants                                                 |
| ---------------- | ------------------------------------------------------ |
| `INSTANCE_ADMIN` | The `/admin` shell + every `instanceAdmin.*` procedure |
| `MEMBER`         | Default; no instance-level access                      |

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
`version`, `buildSha`, and `buildTime`. The packaged `package.json` version is
canonical when npm lifecycle metadata is unavailable; the Docker image bakes
`FORGE_GIT_SHA` / `FORGE_BUILD_TIME`. These are the same sources used by the
sign-in footer, `system.buildInfo`, MCP metadata, and the Settings → About line.
The page also reports counts for:
tenants, users, admins, runtimes, profiles, connections, and runs in
the last 24h.

### Tenants (`/admin/tenants`)

Every non-deleted workspace with rollup stats — member count, issue
count, owner, and runs in the last 24h. Instance admins can also
**create a tenant** here (mirrors `workspace.create` — seeded statuses,
labels, and the first sprint — with the creating admin set as `OWNER`
so they can manage it immediately).

### Users (`/admin/users`)

Every canonical user on the instance, including lifecycle status, attached
login methods, instance role, workspace count, and handle. Administrators can:

- create an invited user and email a single-use account-setup link;
- resend setup for an invited user or send password reset for a user who has a
  local password;
- promote or demote `instanceRole` and revoke every active session;
- suspend and later reactivate an account; or
- soft-delete and anonymize an account while preserving authored work and
  audit attribution.

Suspension immediately invalidates sessions, revokes personal API keys,
invalidates pending account tokens, disconnects user-owned integration
credentials, and pauses their workspace mappings. Deletion additionally
removes local and linked login credentials, memberships, and the global avatar,
and replaces personal fields with a tombstone. Reactivation restores the Forge
principal but does not restore revoked keys or external credential tokens.

Safety guards refuse demotion, suspension, or deletion of the last active
instance administrator. They also refuse suspension or deletion when the user
is the last active owner of any workspace; transfer ownership first. This is
the only place instance role and account lifecycle are administered.

### Identity & sign-in (`/settings/auth`)

Instance administrators own the singleton authentication policy and the
global OIDC, GitHub, and Google provider registry. The modes are:

| Mode            | Normal sign-in methods                                    |
| --------------- | --------------------------------------------------------- |
| `LOCAL_ONLY`    | Durable Forge passwords                                   |
| `EXTERNAL_ONLY` | Enabled external providers; optional operator break glass |
| `HYBRID`        | Durable passwords plus enabled external providers         |

The policy also controls registration, optional automatic redirect, password
minimum length, reset expiry, and lockout behavior. Provider/client secrets
remain encrypted with `AUTH_SECRET`; the environment operator remains a
separate recovery credential when break glass is enabled.

Break-glass recovery is mapped to one designated, active instance
administrator whose email matches `ADMIN_EMAIL`. Create and activate a
dedicated local administrator under `/admin/users`, select it under **Identity
& sign-in**, and keep it separate from a person's normal OIDC identity. The
recovery form is `/signin/local?breakGlass=1`; successful uses are recorded in
the instance security audit. Forge prevents demotion, suspension, or deletion
of the designated account until recovery is reassigned or disabled.

### Reverse proxy requirements for OIDC

An outer forward-auth layer must not intercept Forge's exact Auth.js callback
paths (`/api/auth/callback/<provider-id>`). The identity provider redirects the
browser directly to Forge so Auth.js can validate the sealed state, PKCE, and
nonce cookies. Keep the rest of the application behind the normal access
policy, but configure the callback path as an explicit bypass in Authelia,
Authentik, nginx `auth_request`, Traefik ForwardAuth, or an equivalent proxy.

The proxy must also:

- preserve the public host and scheme in `X-Forwarded-Host` and
  `X-Forwarded-Proto`, with `AUTH_URL` set to that same public origin;
- allow request and response header buffers large enough for Auth.js's sealed
  PKCE, state, nonce, and session cookies—do not truncate or silently drop
  multiple `Set-Cookie` headers;
- avoid logging cookie values, authorization codes, or callback query strings.

A provider redirect that repeatedly returns to sign-in, reports missing state,
or succeeds only when outer authentication is disabled usually indicates a
callback bypass or header-buffer problem rather than an IdP client-secret
failure.

All identity-policy and account-lifecycle mutations write the instance-wide
security audit ledger with actor, target, request metadata, and timestamp.

::: warning Authorization scope in this release
The identity core enforces existing workspace roles and closes project mutation
paths that previously treated every membership as equivalent. The schema and
management UI for restricted-project grants and per-integration capabilities
(for example GitHub repo read/link/sync/write) remain follow-up work. A login
identity never implies permission to use an Integration Connection.
:::

## Migration and rollback compatibility

The identity migration is additive. It backfills normalized email keys, creates
the policy/credential/token/avatar/audit tables, adds provider archival state,
and seeds `HYBRID + INVITE_ONLY + break glass` to preserve the
pre-policy presentation. Migration aborts if case-insensitive duplicate user
emails already exist, rather than merging people silently.

Do not drop the new tables as a routine rollback. An older Forge binary can
ignore the additive columns, but it cannot authenticate durable
`LocalCredential` passwords or enforce the new lifecycle/policy state. Before
an application rollback, ensure the environment bootstrap operator and a
working external provider are available; local-only users otherwise cannot
sign in until the new version is restored. Keep the migrated data intact and
roll forward after diagnosis.

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

Routine profile management does not live in the graphite admin shell. Each
governance row links to **Mission Control → Agents**, where authorized instance
admins can edit and safely remove a profile. Removal permanently deletes only
an unreferenced profile; otherwise it archives the definition and preserves
workspace bindings and history.

## Where to next

- [Mission Control](/guide/mission-control.html) — cross-workspace operations
  plus the agent fleet control plane, separate from instance governance.
- [Agent profiles & bindings](/agents/profiles-and-bindings.html) — the
  approval + instance-sharing flow admins govern.
- [Runtimes](/agents/runtimes.html) — the compute hosts the instance
  runtimes page lists.
