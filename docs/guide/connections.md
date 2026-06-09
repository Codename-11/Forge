# Connections

A **Connection** is an external account you've authorized Forge to act
through — your GitHub login, a Google identity, a Slack auth, or any
generic OpenID-Connect provider. Connections are **owned by you, not by
a workspace**: you authorize once at the account level, then *map* the
connection into the workspaces that should use it.

This split mirrors the rest of Forge's tenancy model: identities live
globally; workspaces decide what those identities point at.

## Where they live

- **`/settings/connections`** — your global connections. Add, configure,
  Authorize / Re-authorize, and disconnect. This is account-level, not
  workspace-scoped.
- **`/w/[slug]/settings/connections`** — per-workspace **mappings**:
  wire a connection to a concrete repo, channel, or webhook for *this*
  workspace, with optional default labels.

## Providers

| Provider | Shape |
|---|---|
| `GITHUB` | GitHub App installation for repo import/link/sync; generic OAuth remains available for account auth experiments |
| `GOOGLE` | First-party Google OAuth |
| `SLACK` | First-party Slack auth |
| `OIDC` | Any OpenID-Connect IdP via discovery (Authelia, Authentik, Keycloak, Okta, …) |
| `CUSTOM` | Freeform / manual identity, no live token |

The generic-first posture matches Forge's SSO: rather than a hardcoded
vendor list, an `OIDC` connection takes your IdP's issuer (or explicit
`authUrl` / `tokenUrl` / `userinfoUrl`), a `clientId`, and an optional
`clientSecret`. Forge resolves the rest by discovery.

## Authorizing

A connection starts `DISCONNECTED`. To bring it live:

1. Create the connection with a label, the provider, and (for OIDC /
   generic OAuth) the issuer or endpoints + `clientId` + `clientSecret`.
   The client secret is encrypted at rest the moment you save it and is
   **never** returned to the client — the UI only ever shows
   `hasToken`.
2. Click **Authorize**. Forge runs an authorization-code + PKCE flow:
   `/api/connections/[id]/authorize` resolves the provider's endpoints,
   stashes a signed `state` + PKCE verifier in a short-lived HttpOnly
   cookie, and redirects you to the provider.
3. The provider redirects back to `/api/connections/[id]/callback`,
   Forge exchanges the code for tokens, encrypts the token blob
   (AES-256-GCM), and flips the connection to `CONNECTED`.

::: info Token health
A connection's `status` is `CONNECTED` / `DEGRADED` / `DISCONNECTED`.
Expiring or expired tokens surface a human-readable `error`
("token expires in 7d") and show as `DEGRADED`. Re-authorize from the
same screen — the flow is identical to the first authorize.
:::

`CUSTOM` connections carry no live token; they're a place to record an
identity you manage out-of-band.

### GitHub App

GitHub repository sync uses the **Install GitHub App** action on
`/settings/connections` or `/w/[slug]/settings/connections`. The install
callback creates or updates a `Connection(provider = GITHUB)` whose
`config.authKind` is `github_app_installation` and whose `config.installationId`
identifies the GitHub App installation. Forge stores installation metadata, not
installation access tokens.

After installation, map repositories from
`/w/[slug]/settings/connections`. A GitHub repo mapping can configure:

- auto-create Forge issues when GitHub sends `issues.opened`;
- default labels, project, priority, queue behavior, and assigned agent for
  imported GitHub issues;
- title sync for SOURCE links;
- optional GitHub comment mirroring into Forge system comments;
- local Forge status transitions for issue closed/reopened, PR ready/merged,
  review changes requested, and failed checks.

The mapping menu also has **Import issue** for one-off creation from a GitHub
issue number. Existing Forge issues can link GitHub issue/PR URLs from the
issue detail rail.

::: warning GitHub writeback
This integration is inbound/read-only against GitHub in the current phase.
Forge can create/update local Forge issue context from GitHub state, but it does
not post GitHub comments, close/reopen GitHub issues, edit PRs, or apply GitHub
labels.
:::

## Mapping into a workspace

A bare connection does nothing on its own. A **mapping** binds it to a
concrete target *for one workspace* (the mapping always carries its own
`workspaceId`, so nothing leaks across tenants). Each mapping has:

| Field | What it is |
|---|---|
| `kind` | `repo` \| `channel` \| `webhook` |
| `target` | The repo full-name, channel name, or webhook URL |
| `direction` | `inbound` \| `outbound` \| `inbound+outbound` (default) |
| `labelIds` | Default labels applied to inbound work from this mapping |
| `routeTo` | Where inbound events route (display: "Issue · auto-create", "Chat · @victor", …) |
| `status` | `active` \| `paused` |
| `config` | Provider-specific policy; GitHub stores repo sync/import/status rules here |

So one GitHub connection can map to `acme/api` in one workspace and
`acme/web` in another, each with its own default labels and direction.
A Slack connection maps to a `#channel`; a generic `webhook` mapping
points at an outbound URL.

::: tip Default labels
`labelIds` is the cleanest way to make inbound work self-organize —
e.g. tag everything that comes in from the `acme/api` repo mapping with
a `backend` label automatically.
:::

## Permissions

Creating and authorizing connections is **per-user** (you can only map
your own connections). Creating, editing, pausing, or deleting a
*mapping* is **admin-gated** within the target workspace — so a
workspace admin decides what a connection does there, but only the
connection's owner controls the identity itself.

## Where to next

- [Workspaces](/guide/workspaces.html) — the tenant boundary mappings
  live under.
- [Settings](/guide/settings.html) — the full settings map.
- [Instance admin](/guide/instance-admin.html) — instance-wide identity
  and SSO posture.
