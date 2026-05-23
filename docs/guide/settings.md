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

Add and remove members; set roles.

- Add — by email or handle. The user must already have a Forge account.
- Remove — keeps audit history; the row stays attributable.
- Role change — `OWNER` / `ADMIN` / `MEMBER` / `GUEST`. Only an owner can
  promote to owner; admins can manage other admins and below.

::: info
Forge does not support self-service joining. Members are added by
admins, by design. See [Workspaces](/guide/workspaces.html#members-and-roles).
:::

### Plugins

The plugin manifest panel.

- Register a manifest (paste JSON or upload).
- Approve, suspend, or revoke.
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

- **Email** — the address NextAuth knows you by. Editable; verification
  required.
- **Handle** — your `@handle`, used in mentions and the activity feed.
- **Name** — display name.
- **Password** — change password (if password auth is enabled in this
  deployment).
- **Sessions** — list of active sessions; revoke individually.

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

URL: `/settings/auth`. **Instance-admin only** — gated on the operator
whose email matches `ADMIN_EMAIL`, since sign-in providers are global to
the whole self-hosted instance (auth is per *user*, not per workspace).

Configure how people sign in, without a redeploy:

- **Email + password** is always available (the bootstrap admin
  credential). It can't be removed here.
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
