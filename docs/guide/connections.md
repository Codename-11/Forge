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
| `GITHUB` | First-party GitHub OAuth |
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
