# Environment

The env vars Forge reads at boot. Grouped by purpose. Anything marked
**required** must be set or the app will refuse to start.

## Database & Redis

| Var            | Required | Notes                                              |
|----------------|----------|----------------------------------------------------|
| `DATABASE_URL` | Yes      | Postgres connection string.                        |
| `REDIS_URL`    | Yes      | Redis URL for pub/sub, rate limit, and BullMQ.     |

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

| Var               | Required | Notes                                              |
|-------------------|----------|----------------------------------------------------|
| `AUTH_URL`        | Yes      | Public app URL (e.g. `https://forge.example`).     |
| `AUTH_SECRET`     | Yes      | JWT secret. Generate with `openssl rand -base64 32`. Also keys the AES-256-GCM encryption of stored SSO client secrets. |
| `AUTH_TRUST_HOST` | No       | Set to `true` if proxied behind a load balancer.   |
| `ADMIN_EMAIL`     | Yes      | Bootstrap admin login **and** the instance admin who manages SSO providers (Settings → Authentication). |
| `ADMIN_PASSWORD`  | Yes      | Password for the `ADMIN_EMAIL` credential login.   |
| `ADMIN_NAME` / `ADMIN_HANDLE` | No | Display name / handle for the bootstrap admin. |

```bash
AUTH_URL="https://forge.example"
AUTH_SECRET="..."
AUTH_TRUST_HOST="true"
ADMIN_EMAIL="admin@forge.example"
ADMIN_PASSWORD="..."
```

### SSO providers (optional bootstrap)

Sign-in providers (OIDC / GitHub / Google) are configured at runtime in
**Settings → Authentication** and stored in the `SsoProvider` table — not
in env. The vars below are **optional one-time bootstrap**: if set and no
provider row of that type exists yet, a row is seeded from them on first
boot, then managed in the UI. Leave them blank to manage everything from
the UI.

| Var                  | Required | Notes                          |
|----------------------|----------|--------------------------------|
| `AUTH_GITHUB_ID`     | No       | Seeds a GitHub provider row.   |
| `AUTH_GITHUB_SECRET` | No       | "                              |
| `AUTH_GOOGLE_ID`     | No       | Seeds a Google provider row.   |
| `AUTH_GOOGLE_SECRET` | No       | "                              |

::: warning
Rotating `AUTH_SECRET` invalidates all active sessions (users are signed out
on the next request) **and** the encrypted SSO client secrets — re-enter each
provider's secret in Settings → Authentication after a rotation.
:::

## GitHub App integration

Required only when enabling GitHub issue/PR import, linking, and webhook sync.
Forge uses a GitHub App installation as durable repo auth and mints short-lived
installation tokens just in time. Installation access tokens are not stored.

| Var                         | Required | Notes |
|-----------------------------|----------|-------|
| `GITHUB_APP_ID`             | Yes      | Numeric GitHub App id used for JWT signing. |
| `GITHUB_APP_SLUG`           | Yes      | App slug for `/api/connections/github/install` redirects. |
| `GITHUB_APP_PRIVATE_KEY`    | Yes      | PEM private key. Newlines may be literal or escaped as `\n`. |
| `GITHUB_APP_WEBHOOK_SECRET` | Yes      | HMAC secret used to verify `/api/ingest/github`. |

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
  `pull_request_review`, `check_suite`, `check_run`
- Read permissions for issues and pull requests. Repository metadata access is
  needed for repository selection/listing.

## Storage (MinIO / S3)

Forge stores attachments in any S3-compatible object store. The split between
`S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` lets the server talk to MinIO over the
docker bridge while the browser hits a public hostname for presigned URLs —
this is the difference between "`PUT` works server-side" and "`PUT` works
from the browser".

| Var                    | Required | Notes                                              |
|------------------------|----------|----------------------------------------------------|
| `S3_ENDPOINT`          | Yes      | Internal endpoint (e.g. docker bridge IP).         |
| `S3_PUBLIC_ENDPOINT`   | Yes      | Public hostname presigned URLs are signed against. |
| `S3_REGION`            | Yes      | Usually `us-east-1`.                               |
| `S3_ACCESS_KEY`        | Yes      | Credentials.                                       |
| `S3_SECRET_KEY`        | Yes      | Credentials.                                       |
| `S3_FORCE_PATH_STYLE`  | No       | `true` for MinIO; `false` for AWS S3.              |

```bash
S3_ENDPOINT="http://minio:9000"
S3_PUBLIC_ENDPOINT="https://minio.example"
S3_REGION="us-east-1"
S3_ACCESS_KEY="forge"
S3_SECRET_KEY="..."
S3_FORCE_PATH_STYLE="true"
```

## AI providers

Optional unless the workspace has `aiEnabled = true`. Set only the variables
matching the chosen `aiProvider`.

### `aiProvider = hermes`

| Var                    | Notes                                                       |
|------------------------|-------------------------------------------------------------|
| `HERMES_GATEWAY_URL`   | Hermes gateway base URL.                                    |
| `HERMES_GATEWAY_TOKEN` | Bearer token for the gateway.                               |
| `HERMES_GATEWAY_ALLOW_UNAUTH` | Set to `1` only for an intentionally unauthenticated local gateway; otherwise Forge requires a token or runtime secret before showing Hermes Runs as chat-ready. |

### `aiProvider = openai`

| Var               | Notes                                                            |
|-------------------|------------------------------------------------------------------|
| `OPENAI_API_KEY`  | OpenAI API key.                                                  |
| `OPENAI_BASE_URL` | Optional override (Azure, OpenAI-compatible gateways).           |

### `aiProvider = anthropic`

| Var                 | Notes                                                          |
|---------------------|----------------------------------------------------------------|
| `ANTHROPIC_API_KEY` | Anthropic API key.                                             |

### `aiProvider = custom`

| Var                | Notes                                                           |
|--------------------|-----------------------------------------------------------------|
| `FORGE_AI_BASE_URL`| OpenAI-compatible endpoint base URL.                            |
| `FORGE_AI_API_KEY` | Bearer token.                                                   |

::: info
The provider is chosen per workspace via `Workspace.aiProvider`. The env vars
are the credentials Forge uses when that provider is selected — switching
provider does not require restart, but does require the corresponding env to
be set.
:::

## Plugin runtime

| Var                  | Required | Notes                                                  |
|----------------------|----------|--------------------------------------------------------|
| `PLUGIN_JWT_SECRET`  | Yes      | HS256 secret for delegated plugin calls (`runtime: "plugin"`). |

```bash
PLUGIN_JWT_SECRET="..."
```

This is the secret Forge signs with when calling out to plugins running as
external services. Plugins verify with the same secret. Rotating it
invalidates any in-flight skill JWTs (5-minute lifetime) but does not affect
already-completed calls.

## Dev-only conveniences

| Var             | Notes                                                                     |
|-----------------|---------------------------------------------------------------------------|
| `PROD_ENV_FILE` | Path used by `pnpm dev` / `pnpm dev:live` to source env from a deployed env file. |
| `DEV_HOST`      | Pass to `pnpm dev:host` to expose the dev server on the LAN.              |
| `AUTH_URL_DEV`  | Overrides `AUTH_URL` in dev (so dev auth callbacks don't fight prod).     |

```bash
# .env.local
PROD_ENV_FILE="/home/bailey/docker/forge/.env"
DEV_HOST="0.0.0.0"
AUTH_URL_DEV="http://localhost:3000"
```

::: tip
`pnpm dev` reads env from the deployed compose env file referenced by
`PROD_ENV_FILE` so local dev uses the same Postgres, Redis, and MinIO data as
the live app. Use `pnpm dev:isolated` when you explicitly want the local
`docker/docker-compose.yml` services.
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

## Cross-references

- [/guide/architecture.html](/guide/architecture.html) — how these pieces
  fit together at runtime.
