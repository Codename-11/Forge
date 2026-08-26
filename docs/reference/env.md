# Environment

The env vars Forge reads at boot. Grouped by purpose. Anything marked
**required** must be set or the app will refuse to start.

## Database & Redis

| Var            | Required | Notes                                          |
| -------------- | -------- | ---------------------------------------------- |
| `DATABASE_URL` | Yes      | Postgres connection string.                    |
| `REDIS_URL`    | Yes      | Redis URL for pub/sub, rate limit, and BullMQ. |

```bash
DATABASE_URL="postgresql://forge:forge@db:5432/forge?schema=public"
REDIS_URL="redis://redis:6379"
```

::: tip
Postgres connection pooling is via Prisma's built-in pooler; no PgBouncer
required for typical deployments. If you front the DB with a pooler in
transaction mode, append `?pgbouncer=true&connection_limit=1` to
`DATABASE_URL`.
:::

## Auth (NextAuth v5)

| Var                           | Required | Notes                                                                                                                   |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `AUTH_URL`                    | Yes      | Public app URL (e.g. `https://forge.example`).                                                                          |
| `AUTH_SECRET`                 | Yes      | JWT secret. Generate with `openssl rand -base64 32`. Also keys the AES-256-GCM encryption of stored SSO client secrets. |
| `AUTH_TRUST_HOST`             | No       | Set to `true` if proxied behind a load balancer.                                                                        |
| `ADMIN_EMAIL`                 | Yes      | Environment-backed bootstrap and break-glass instance administrator.                                                    |
| `ADMIN_PASSWORD`              | Yes      | Password for the bootstrap/break-glass operator. It is not a normal user's durable local password.                      |
| `ADMIN_NAME` / `ADMIN_HANDLE` | No       | Display name / handle for the bootstrap admin.                                                                          |

```bash
AUTH_URL="https://forge.example"
AUTH_SECRET="..."
AUTH_TRUST_HOST="true"
ADMIN_EMAIL="admin@forge.example"
ADMIN_PASSWORD="..."
```

Normal local accounts do not use environment variables. Forge stores a
versioned scrypt password hash in `LocalCredential`, attached to the same
canonical `User` as any linked OIDC, GitHub, or Google login. `ADMIN_EMAIL` and
`ADMIN_PASSWORD` remain outside that account-managed credential set so an
instance administrator can use `/signin/local` when external identity is
unavailable. Keep them unique, protected, and available to the operator; do not
reuse a person's normal password.

After configuring these variables, create and activate a dedicated instance
administrator with the same email and designate it under **Identity & sign
in**. Recovery uses `/signin/local?breakGlass=1`; the ordinary local form never
accepts the environment credential implicitly. See [Instance Admin → Reverse
proxy requirements for OIDC](/guide/instance-admin.html#reverse-proxy-requirements-for-oidc)
for callback bypass and header-buffer requirements.

Authentication mode, registration, automatic provider redirect, password
minimum length, reset expiry, and lockout thresholds are runtime database
settings under **Identity & sign-in**. They are intentionally not environment
variables.

### SSO providers (optional bootstrap)

Sign-in providers (OIDC / GitHub / Google) are configured at runtime in
**Identity & sign-in** and stored in the `SsoProvider` table — not
in env. The vars below are **optional one-time bootstrap**: if set and no
provider row of that type exists yet, a row is seeded from them on first
boot, then managed in the UI. Leave them blank to manage everything from
the UI.

| Var                  | Required | Notes                        |
| -------------------- | -------- | ---------------------------- |
| `AUTH_GITHUB_ID`     | No       | Seeds a GitHub provider row. |
| `AUTH_GITHUB_SECRET` | No       | "                            |
| `AUTH_GOOGLE_ID`     | No       | Seeds a Google provider row. |
| `AUTH_GOOGLE_SECRET` | No       | "                            |

::: warning
Rotating `AUTH_SECRET` invalidates all active sessions (users are signed out
on the next request) **and** the encrypted SSO client secrets — re-enter each
provider's secret in Identity & sign-in after a rotation.
:::

### Account email delivery

Account invitations/setup, password reset, password-change notices, and
workspace invitations share the outbound email configuration below. Public
password-reset requests return the same response for known and unknown email
addresses. Production delivery fails closed when no transport is configured.

| Var              | Required | Notes                                                                           |
| ---------------- | -------- | ------------------------------------------------------------------------------- |
| `EMAIL_FROM`     | Yes      | Sender used for account and workspace identity mail.                            |
| `EMAIL_SERVER`   | No       | Compact SMTP URL. Use this or the expanded `SMTP_*` fields or `RESEND_API_KEY`. |
| `SMTP_HOST`      | No       | SMTP hostname when not using `EMAIL_SERVER`.                                    |
| `SMTP_PORT`      | No       | SMTP port; defaults to `587`.                                                   |
| `SMTP_SECURE`    | No       | `true` for implicit TLS.                                                        |
| `SMTP_USER`      | No       | SMTP username.                                                                  |
| `SMTP_PASSWORD`  | No       | SMTP password.                                                                  |
| `RESEND_API_KEY` | No       | Resend transport alternative to SMTP.                                           |

## GitHub App integration

The preferred setup is **Workspace Settings → GitHub Apps**. Forge stores that
App's PEM and webhook secret encrypted, uses it for native issue/PR sync, and
mints short-lived installation tokens just in time for runtime git access.
Installation access tokens are not stored.

The variables below are an optional legacy/instance-wide fallback for
installations that have not moved to workspace-managed Apps. They are no longer
required when the matching installed Workspace GitHub App has realtime sync
enabled.

| Var                         | Required | Notes                                                               |
| --------------------------- | -------- | ------------------------------------------------------------------- |
| `GITHUB_APP_ID`             | No       | Legacy instance App id used for JWT signing.                        |
| `GITHUB_APP_SLUG`           | No       | Legacy App slug for `/api/connections/github/install` redirects.    |
| `GITHUB_APP_PRIVATE_KEY`    | No       | Legacy PEM private key. Newlines may be literal or escaped as `\n`. |
| `GITHUB_APP_WEBHOOK_SECRET` | No       | Legacy HMAC fallback used to verify `/api/ingest/github`.           |

```bash
GITHUB_APP_ID="123456"
GITHUB_APP_SLUG="forge"
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_APP_WEBHOOK_SECRET="..."
```

Configure the GitHub App with:

- Setup URL: `https://forge.example/api/connections/github/setup`
- Webhook URL: `https://forge.example/api/ingest/github`
- Webhook events: `issues`, `issue_comment`, `pull_request`,
  `pull_request_review`, `check_suite`, `check_run`, `status`
- Read permissions for issues, pull requests, and commit statuses.
- **Read and write** permission for checks. GitHub requires write-level Checks
  permission to deliver the `requested`/`rerequested` check-suite and check-run
  actions Forge uses to invalidate a cached CI aggregate when a rerun starts.
  Forge otherwise reads check data and does not create check runs.
- Repository metadata access for repository selection/listing.

Existing workspace Apps can enable or rotate the signed endpoint from
**Workspace Settings → GitHub Apps → Enable realtime sync**. Operators can run
the same action inside the worker container without exposing the generated
secret:

```bash
pnpm maintenance:github-webhook -- --id=<github-app-row-id>
```

To review and migrate legacy generic GitHub issue/PR attachments into native
relations, dry-run first and then execute a bounded batch:

```bash
pnpm maintenance:github-links -- --dry-run --limit=25
pnpm maintenance:github-links -- --limit=25
```

## Storage (MinIO / S3)

Forge stores attachments in any S3-compatible object store. The split between
`S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` lets the server talk to MinIO over the
docker bridge while the browser hits a public hostname for presigned URLs —
this is the difference between "`PUT` works server-side" and "`PUT` works
from the browser".

| Var                   | Required | Notes                                                             |
| --------------------- | -------- | ----------------------------------------------------------------- |
| `S3_ENDPOINT`         | Yes      | Internal endpoint (e.g. docker bridge IP).                        |
| `S3_PUBLIC_ENDPOINT`  | Yes      | Public hostname presigned URLs are signed against.                |
| `S3_REGION`           | Yes      | Usually `us-east-1`.                                              |
| `S3_ACCESS_KEY`       | Yes      | Credentials.                                                      |
| `S3_SECRET_KEY`       | Yes      | Credentials.                                                      |
| `S3_FORCE_PATH_STYLE` | No       | `true` for MinIO; `false` for AWS S3.                             |
| `S3_GLOBAL_BUCKET`    | No       | Instance-global account-media bucket; defaults to `forge-global`. |

```bash
S3_ENDPOINT="http://minio:9000"
S3_PUBLIC_ENDPOINT="https://minio.example"
S3_REGION="us-east-1"
S3_ACCESS_KEY="forge"
S3_SECRET_KEY="..."
S3_FORCE_PATH_STYLE="true"
S3_GLOBAL_BUCKET="forge-global"
```

Workspace attachments remain in workspace-scoped buckets. User-uploaded
avatars are account-global and live in `S3_GLOBAL_BUCKET` under user-scoped
keys, because the same profile follows a person across workspaces. Forge
creates the bucket lazily, validates PNG, JPEG, GIF, or WebP content (maximum
5 MiB), and serves it through the stable `/api/avatar/<user-id>` route. Removing
a local avatar restores the last provider-supplied profile image when one was
recorded.

## AI providers

Optional unless the workspace has `aiEnabled = true`. Set only the variables
matching the chosen `aiProvider`.

### `aiProvider = hermes`

| Var                           | Notes                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HERMES_GATEWAY_URL`          | Hermes gateway base URL.                                                                                                                                         |
| `HERMES_GATEWAY_TOKEN`        | Bearer token for the gateway.                                                                                                                                    |
| `HERMES_GATEWAY_ALLOW_UNAUTH` | Set to `1` only for an intentionally unauthenticated local gateway; otherwise Forge requires a token or runtime secret before showing Hermes Runs as chat-ready. |

### `aiProvider = openai`

| Var               | Notes                                                  |
| ----------------- | ------------------------------------------------------ |
| `OPENAI_API_KEY`  | OpenAI API key.                                        |
| `OPENAI_BASE_URL` | Optional override (Azure, OpenAI-compatible gateways). |

### `aiProvider = anthropic`

| Var                 | Notes              |
| ------------------- | ------------------ |
| `ANTHROPIC_API_KEY` | Anthropic API key. |

### `aiProvider = custom`

| Var                 | Notes                                |
| ------------------- | ------------------------------------ |
| `FORGE_AI_BASE_URL` | OpenAI-compatible endpoint base URL. |
| `FORGE_AI_API_KEY`  | Bearer token.                        |

::: info
The provider is chosen per workspace via `Workspace.aiProvider`. The env vars
are the credentials Forge uses when that provider is selected — switching
provider does not require restart, but does require the corresponding env to
be set.
:::

## Plugin runtime

| Var                 | Required | Notes                                                          |
| ------------------- | -------- | -------------------------------------------------------------- |
| `PLUGIN_JWT_SECRET` | Yes      | HS256 secret for delegated plugin calls (`runtime: "plugin"`). |

```bash
PLUGIN_JWT_SECRET="..."
```

This is the secret Forge signs with when calling out to plugins running as
external services. Plugins verify with the same secret. Rotating it
invalidates any in-flight skill JWTs (5-minute lifetime) but does not affect
already-completed calls.

## Dev-only conveniences

| Var                       | Notes                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `AUTH_URL_DEV`            | Local auth/app origin (default `http://localhost:3000`).              |
| `FORGE_PROD_SSH_HOST`     | Remote SSH host used only by `pnpm dev:refresh`.                      |
| `FORGE_PROD_ENV_FILE`     | Env path read only by the remote refresh shell; never copied locally. |
| `FORGE_PROD_DB_CONTAINER` | Remote Postgres container read by `pg_dump` during refresh.           |

```bash
AUTH_URL_DEV="http://localhost:3000"
FORGE_PROD_SSH_HOST="docker-server.local"
FORGE_PROD_ENV_FILE="/home/bailey/docker/forge/.env"
```

::: tip
`pnpm dev` loads the gitignored `.env.local`, then hard-validates the database,
Redis, S3, and container targets against the fixed local docker contract. A
production-like override is rejected rather than silently used. Production
env is consulted only by the remote shell during an explicit, confirmed
`pnpm dev:refresh`.
:::

## Boot order

The Next.js instrumentation hook (`src/instrumentation.ts`) boots the BullMQ
worker in-process on app start. That means `pnpm dev` is enough during
development — webhooks deliver, scheduled watchdogs fire, no separate worker
process needed.

In production, run `pnpm worker` as a sidecar process so worker concurrency
scales independently of web concurrency, and so a deploy of the web app
does not interrupt long-running deliveries:

```bash
# Process 1: web
pnpm start

# Process 2: worker (separate container / process)
pnpm worker
```

The instrumentation hook is a no-op when it detects an external worker is
already serving the queue — workers coordinate via Redis, so it is safe to
leave the in-process boot enabled even with a sidecar.

### Worker outbound networking

Managed runtime handshake checks, self-tests, periodic health sweeps, and
`/v1/runs` dispatch execute in the worker. The reference production topology is
`docker/docker-compose.production.example.yml`: the worker joins the internal
data network and a dedicated non-internal egress bridge, publishes no ports,
and does not join the public reverse-proxy network. A manual runtime diagnostic
is queued to that worker rather than executed from the web container, so its
result reflects the same DNS, routing, and firewall plane that dispatches real
work.

## Cross-references

- [/guide/architecture.html](/guide/architecture.html) — how these pieces
  fit together at runtime.
