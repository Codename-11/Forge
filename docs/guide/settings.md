# Settings

Forge has two settings scopes: **workspace** (admin-gated, per-tenant) and
**user** (per-account, follows you across workspaces). This page maps the
settings UI for both.

## Workspace settings

URL: `/w/<slug>/settings`. Most panels are admin-only; the section below
notes which require `OWNER` or `ADMIN`.

### Workspace

The top-level identity panel.

- **Name** — display name. Mutable.
- **Key** — issue prefix. **Immutable** after creation; see
  [Workspaces](/guide/workspaces.html) for why.
- **Avatar** — display image.
- **Sprint defaults** — `cycleLengthDays`, `cycleCooldownDays`.
- **Time tracking** — `timeTrackingEnabled` toggle.
- **AI features** — `aiEnabled`, `aiTriageOnCreate`, `aiCoachEnabled`,
  `aiProvider`, `aiModel`.
- **SLA / stall / noack** — `assignmentSlaMinutes`,
  `agentIdleTimeoutMinutes`, `requiredAckSeconds`,
  `autoRedispatchOnStall`, `autoRedispatchOnNoack`,
  `slaEnforcementEnabled`.
- **Ephemeral agent cleanup** — `ephemeralAgentIdleMinutes` (0 = off):
  auto-archive an EPHEMERAL (session/CLI) agent that hasn't heartbeated for
  this long, so abandoned session rows don't pile up. Reversible; PERSISTENT
  agents (Hermes, etc.) are never touched.

The full table of knobs lives in
[Workspaces → Workspace knobs](/guide/workspaces.html).

### Agents

CRUD for first-class agent members.

- Create new agents (provider/runtime, name, `profileKey`, capabilities,
  optional webhook URL + secret, `maxConcurrent`).
- Edit existing agents.
- Archive agents (reversible). Archived agents don't show in dispatch
  candidate lists or assignment pickers.
- See live presence: `ONLINE` / `BUSY` / `OFFLINE`, last heartbeat,
  current assignment count, webhook health (last delivery + last error).

See [Agents → Overview](/agents/overview.html) for the agent model.

### Labels

Workspace-scoped labels for tagging issues.

- Create with name + color.
- Reorder by drag (sets `position`).
- Delete (cascade-removes label-on-issue rows; doesn't delete the issues).

### Statuses

Workspace-scoped statuses, each in a fixed category (`BACKLOG`, `TODO`,
`IN_PROGRESS`, `IN_REVIEW`, `DONE`, `CANCELED`).

- Create within a category.
- Reorder within a category.
- Set the workspace default (used for fresh issues with no explicit
  status).
- Configure agent lifecycle targets for **In Progress**, **In Review**, and
  **Done**. New workspaces select the first status in each matching category.
  An explicit MCP `EXECUTE` run applies In Progress when it opens and In Review
  when it completes; research, review, and discussion runs never move issue
  status automatically.

### Templates

Two kinds of templates: **issue templates** and **project templates**.

- Issue template — pre-fills title, description, labels, priority, status.
  Use from the quick-create dialog.
- Project template — pre-fills name, description, icon, color, and
  optionally creates a starter set of issues on instantiation.

### Dispatch rules

Custom rules layered on top of `autoDispatchMode`. Each rule has a
matcher (label, priority, project) and a target (specific agent, capability
set). Rules are ordered; the first match wins.

- CRUD rules.
- Reorder by drag.
- Toggle individual rules on/off without deleting them.

See [Agents → Auto-dispatch](/agents/auto-dispatch.html) for how rules
interact with the dispatch mode.

### Members

Invite, remove, and manage members.

- Invite — send an expiring, single-use email link for `ADMIN`, `MEMBER`, or
  `GUEST`. Existing users authenticate as the invited email. When local
  registration is enabled, a new recipient can instead create the canonical
  user, verified email, password, and membership atomically from that exact
  invitation. `OWNER` remains transfer-only.
- Invitations — pending invites appear before accepted, expired, and revoked
  history. Resend rotates the bearer token only after the replacement email is
  accepted by the configured provider; revoke disables the pending token.
- Add existing user — the compatibility API can still add a known Forge user
  directly by email or handle.
- Remove — keeps audit history; the row stays attributable.
- Role change — `OWNER` / `ADMIN` / `MEMBER` / `GUEST`. Only an owner can
  promote to owner; admins can manage other admins and below.

::: warning
Production invitation delivery fails closed unless `EMAIL_SERVER` or
`SMTP_HOST` (plus any credentials), or `RESEND_API_KEY`, is configured with
`EMAIL_FROM`. Invite attempts never grant membership by themselves.
:::

### Plugins

The plugin manifest panel.

- Register a manifest (paste JSON or upload).
- Re-submit the same slug to update version, scopes, skills, or webhook URL.
- Download a plugin backup before removal; paste that backup back into the
  install dialog to restore the registration. Backups intentionally exclude raw
  API keys, key hashes, webhook secrets, and the plugin signing secret, so
  restored plugins require review and fresh API keys.
- Approve, suspend, or remove.
- Issue API keys for an installed plugin (admin-gated). Keys can be
  scoped further by `projectIds`, `labelIds`, `initiativeIds`,
  `linkedAgentId`.

See [Automation → Plugins](/automation/plugins.html) and
[Automation → API keys](/automation/api-keys.html).

### Admin

Engineering-flavored controls.

- **Webhook DLQ** — inspect failed `WebhookDelivery` rows, retry
  individually, or replay in bulk.
- **Audit log** — search across the workspace's `AuditLog`.

### Data export / import

URL: `/w/<slug>/settings/data`. **Admin only.** Move a workspace's core
content between instances as portable JSON.

- **Export** downloads settings, statuses, labels, initiatives, projects,
  sprints, agents, and issues (with assignees, labels, and relations) plus
  comments. Infra rows — API keys, webhooks, the audit log, and attachment
  bytes — are excluded.
- **Import** loads a snapshot into the current workspace. It is _additive_:
  config rows are matched by natural key and reused, issues are created
  fresh with new numbers, relations and comments are rewired onto them, and
  unknown authors fall back to you. Nothing is deleted.

For a full-fidelity copy of a deployed instance locally, use
`pnpm db:clone-prod` instead — see
[Local Development](/guide/local-development.html).

### Views

Saved filter presets for the Issues list. Each saved view captures a query
shape (status, priority, label, assignee, sprint) and a sort order. Views
are workspace-shared.

### Integrations

Third-party integrations (where present): Slack, Discord, GitHub, etc.
Each integration is its own panel; common operations are connect,
disconnect, and configure event mapping.

### Project templates

Authoring surface for the project templates referenced in **Templates**.
Same forms, surfaced separately for teams that want a cleaner authoring
flow.

### Recurring

Recurring issue schedules. Pick an issue template, a cadence (cron-like
or simpler interval), a target project/sprint, and the schedule fires
fresh issues on the cadence. Useful for weekly reports, monthly
maintenance, etc.

## User settings

URL: `/settings`. These follow the user across all workspaces.

### Account

- **Profile picture** — upload one PNG, JPEG, GIF, or WebP image up to 5 MiB.
  It is global to your Forge account, not copied into each workspace. Removing
  it restores the last linked-provider picture when available.
- **Email** — the case-insensitive canonical address shared by every login
  method attached to this account.
- **Handle** — your `@handle`, used in mentions and the activity feed.
- **Name** — display name.

### Security & sign-in

URL: `/settings/security`. A Forge account is one canonical `User`; local and
external login methods can be added to or removed from that same account.

- **Local password** — add or change a durable password. Changing it revokes
  existing sessions. Removing it requires another linked login method and is
  forbidden while the instance is in local-only mode.
- **Linked login methods** — attach enabled OIDC, GitHub, or Google identities,
  or unlink one after another login method exists. Linking proves control of
  the provider account; unlinking revokes existing Forge sessions.
- **Sessions** — sign out all devices. Password, login-method, lifecycle, and
  role changes also increment the account authorization version so existing
  JWT sessions stop authorizing.

The sign-in screen exposes **Forgot password** when local credentials are
available. Reset requests are enumeration-safe, rate-limited, expire according
to instance policy, and consume a single-use emailed token. Administrators can
also send a reset for a non-deleted account with a local password from
`/admin/users`; suspension still prevents sign-in until an administrator
reactivates the account.

::: info Login identity is not an integration connection
An Auth.js `Account` row proves who you are when signing into Forge. An
**Integration account** under `/settings/connections` authorizes operations
against GitHub or another external system and may be mapped into workspaces.
Linking or unlinking a GitHub login never creates, changes, or deletes a GitHub
integration connection.
:::

### Appearance

- **Theme** — `light`, `dark`, or `system`.
- **Density** — `compact` or `comfortable`. Cascades onto
  `<html data-density="…">` and is read by the density-aware text
  utilities (`.text-id`, `.text-meta`, etc).
- **Text size** — `default` or `larger`. Same cascade mechanism via
  `data-textsize`.
- **Locale** — date/time formatting.
- **Timezone** — display timezone for timestamps. Storage is always UTC.

### Access

- **Personal API keys** — keys issued under your account, scoped by the
  same `PluginScope[]` ceiling and narrowing arrays as plugin keys. Use
  these for personal scripts; use plugin keys for shared automation.

See [Automation → API keys](/automation/api-keys.html).

### Workspaces

- **Memberships** — every workspace you belong to, with role.
- **Default workspace** — which workspace opens when you sign in.
- **Leave** — leave a workspace (audit trail preserved).

### Authentication

URL: `/settings/auth`. **Instance-admin only** — gated by
`User.instanceRole === INSTANCE_ADMIN` (with `ADMIN_EMAIL` as the bootstrap
fallback), because sign-in policy and providers apply to the whole instance.

Configure how people sign in, without a redeploy:

- **Local only** — present and accept durable Forge passwords. External
  providers are not loaded.
- **External only** — present enabled OIDC/OAuth providers. Forge refuses this
  mode until at least one external provider is usable. The protected
  environment-backed operator may still use `/signin/local` when break glass
  is enabled.
- **Hybrid** — present local passwords and any enabled external providers.
- **Automatic redirect** — select one enabled provider to redirect normal
  sign-in visits automatically, or leave it unset for the provider chooser.
  Manual and error-return visits bypass automatic redirect to avoid loops.
- **Registration** — `DISABLED` requires an administrator-created principal;
  `INVITE_ONLY` accepts first-time external sign-in or atomic local account
  creation only from an exact invitation; `OPEN` additionally exposes local
  email verification/setup and permits eligible external identities to create
  their canonical account. Administrator-created local users also activate
  through a one-time setup link.
- **Password policy** — configure minimum length, reset-link expiry, failed
  attempt threshold, and lockout duration. Passwords are stored as versioned
  scrypt hashes; raw passwords and raw reset/setup tokens are never persisted.
- **Break glass** — keeps only the `ADMIN_EMAIL` / `ADMIN_PASSWORD` operator
  credential available through the explicit `/signin/local?breakGlass=1`
  recovery flow. Select one active instance administrator whose email matches
  `ADMIN_EMAIL`; Forge audits recovery sign-ins and protects that account from
  lifecycle changes until recovery is reassigned or disabled. Use a dedicated
  local administrator rather than a person's normal OIDC identity.
- **Add a provider** — pick a type:
  - **OpenID Connect (OIDC)** — the generic, discovery-based type. Covers
    any OIDC IdP: self-hosted **Authelia**, Authentik, Keycloak, or hosted
    Okta / Azure AD / Auth0. You supply an **Issuer URL**; Forge discovers
    the endpoints from `<issuer>/.well-known/openid-configuration` (use
    **Test** to verify reachability before saving).
  - **GitHub** / **Google** — first-party OAuth.
- **Client secret** is encrypted at rest (AES-256-GCM, keyed off
  `AUTH_SECRET`) and never shown again — leave the field blank on edit to
  keep the stored value. Rotating `AUTH_SECRET` invalidates stored secrets;
  re-enter them here afterward.
- **Callback / redirect URI** — each row shows the exact
  `/api/auth/callback/<id>` URL to register in your IdP.
- **Link accounts by email** — opt-in per provider; only enable when you
  trust the IdP to assert verified emails.
- **Enable / disable** toggles take effect within ~30s, no restart.

Forge prevents policy/provider changes that would select a missing automatic
redirect target or leave external-only mode without an enabled provider.
Disabling, archiving, or deleting an automatic redirect provider clears that
selection.

Existing `AUTH_GITHUB_*` / `AUTH_GOOGLE_*` env vars (if set) are seeded into
this table once on first boot, then managed here — see
[Reference → Environment](/reference/env.html#auth-nextauth-v5).

## Where to next

- [Workspaces](/guide/workspaces.html) — the configurability principle and
  the full knob table.
- [Keyboard](/guide/keyboard.html) — shortcuts, including settings
  navigation.
- [Automation → API keys](/automation/api-keys.html) — keys and scopes.
- [Automation → Plugins](/automation/plugins.html) — the manifest format.
