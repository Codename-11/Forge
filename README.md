# Forge

A minimalist, keyboard-driven project management platform with a pluggable agent surface.
Linear-style issues and projects. Nothing-inspired, warm-earthy UI. First-class MCP.

## Stack

- **Next.js 15** (App Router, server components, typed routes) + **TypeScript**
- **PostgreSQL** + **Prisma 6** (normalized schema with audit log, event stream, metric rollups)
- **tRPC 11** with **Zod** validation (end-to-end type-safe API)
- **NextAuth v5** (GitHub/Google/email magic link, Prisma adapter, DB sessions)
- **Redis** (pub/sub for realtime, rate limiting, BullMQ queues)
- **SSE** for browser realtime; **HMAC-signed webhooks** for plugin delivery
- **Tailwind CSS** with a warm-earthy design token system
- **Vitest** + **Playwright** for unit + E2E; **GitHub Actions** for CI

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Next.js App Router                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Server comps │  │ Client comps │  │ API route handlers│   │
│  │ (RSC data)   │  │ (tRPC react) │  │ (tRPC/mcp/auth)  │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                 │                    │             │
│         └────────┬────────┴────────────────────┘             │
│                  ▼                                            │
│           tRPC routers (Zod-validated)                        │
│                  │                                            │
│   ┌──────────────┼────────────────┬─────────────────────┐    │
│   ▼              ▼                ▼                     ▼    │
│ Prisma       Audit+Event        Realtime        Plugin       │
│ (Postgres)   recorder           pub/sub         runtime      │
│                  │                 │                 │       │
│                  ▼                 ▼                 ▼       │
│            ActivityEvent        Redis         Webhook queue  │
│              table              channels      (BullMQ)       │
└──────────────────────────────────────────────────────────────┘
```

- **Audit vs events**: `AuditLog` is immutable compliance; `ActivityEvent` is
  the product event stream plugins consume.
- **Multi-tenancy**: every tenant-scoped row carries `workspaceId`. Procedures
  enforce membership via the `workspaceProcedure` middleware in `src/server/trpc.ts`.
- **Plugins** come in two flavors: `runtime: "local"` (in-process handler)
  and `runtime: "plugin"` (HTTP webhook delivery with HMAC + JWT).

## Quick start

```bash
# 1. Services
cd docker && docker compose up -d

# 2. Install + bootstrap DB
cp .env.example .env            # fill in values
pnpm install
pnpm prisma:generate
pnpm prisma:migrate             # creates tables
pnpm prisma:seed                # seeds a workspace + issues

# 3. Run
pnpm dev                        # http://localhost:3000
pnpm worker                     # separate process: webhook + metrics workers
```

## Keyboard shortcuts

| Shortcut     | Action            |
|--------------|-------------------|
| `⌘K` / `/`   | Command palette   |
| `C`          | Quick create issue|
| `G` then `I` | Go to Inbox       |
| `G` then `S` | Go to Issues      |
| `G` then `P` | Go to Projects    |
| `G` then `A` | Go to Analytics   |

## MCP

Forge exposes a small MCP-style tool catalog at `/api/mcp`:

```bash
# Describe tools
curl -s -H "Authorization: Bearer $FORGE_KEY" http://localhost:3000/api/mcp/describe

# Create an issue
curl -s -X POST http://localhost:3000/api/mcp/issues.create \
  -H "Authorization: Bearer $FORGE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Investigate 5xx from billing","priority":"HIGH"}'
```

API keys are scoped — a key only exposes the `PluginScope`s declared at
issue time, which must be a subset of the owning plugin's manifest scopes.

## Plugin manifest

See `plugins/issue-triage/manifest.json` for a complete example. The key
idea: declare scopes once in the manifest, and Forge enforces them
everywhere (MCP, webhook delivery, skill invocation).

## Project layout

```
src/
  app/              # App Router pages + API route handlers
  components/       # UI (sidebar, topbar, palette, issue list/board/detail)
  lib/              # utils, trpc client, keyboard, providers
  server/           # db, redis, auth, trpc routers, services
    routers/        # workspace, project, issue, comment, analytics, plugin, status
    services/       # plugin-manifest, plugin-runtime, api-key-auth, mcp
prisma/             # schema + seed
plugins/            # local-runtime plugin handlers
docker/             # dev postgres + redis
tests/              # unit (vitest) + e2e (playwright)
```

## Deployment

- **Vercel**: tRPC, auth, SSE, and MCP routes are all Node-runtime compatible.
  Provide `DATABASE_URL`, `REDIS_URL`, `AUTH_SECRET`, `PLUGIN_JWT_SECRET`.
- **Self-host**: `pnpm build && pnpm start` behind Traefik/Caddy. Run
  `pnpm worker` as a separate process. Postgres + Redis as managed services
  or containers.

## License

MIT.
