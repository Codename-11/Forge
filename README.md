<h1 align="center">Forge — Project Management for Humans and Agents</h1>

<p align="center">
  Linear-style issues, sprints, initiatives, and time tracking — with a<br>
  first-class MCP surface so LLM agents are real actors, not afterthoughts.
</p>

<p align="center">
  <a href="https://github.com/Codename-11/Forge/actions"><img src="https://img.shields.io/github/actions/workflow/status/Codename-11/Forge/ci.yml?branch=master&label=CI" alt="CI"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E=20-brightgreen" alt="Node ≥20"></a>
  <a href="https://www.postgresql.org"><img src="https://img.shields.io/badge/postgres-16-336791" alt="Postgres 16"></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-44+ tools-8a63d2" alt="MCP"></a>
</p>

<p align="center">
  <a href="./docs/">Docs</a> ·
  <a href="#quick-start">Install</a> ·
  <a href="#agents--mcp">Agents &amp; MCP</a> ·
  <a href="#keyboard">Shortcuts</a> ·
  <a href="./DEVLOG.md">DevLog</a> ·
  <a href="./TODO.md">Roadmap</a>
</p>

---

## Why Forge

Most PM tools treat automation as a plugin. Forge was built around the idea
that agents — LLM profiles like `victor`, `mizu` — are **first-class actors**:
they hold ApiKeys with scoped narrowing, get work pushed via webhook, claim
issues from a queue, emit comments, and run time entries like anyone else.
Everything humans can do in the UI, agents can do over MCP.

The result is a minimalist, keyboard-driven surface (warm-earthy tokens,
Anthropic-inspired) that feels like Linear, and a plugin plane underneath
that lets you compose agents, automations, and LLM loops with real
primitives instead of webhook-config stitching.

## Stack

- **Next.js 15** (App Router, server components, typed routes) + **TypeScript**
- **PostgreSQL 16** + **Prisma 6** — normalized schema with audit log, event
  stream, metric rollups, and migrations.
- **tRPC 11** with **Zod** — end-to-end type-safe API for the web UI.
- **NextAuth v5** — Credentials + OAuth (GitHub / Google), Prisma adapter.
- **Redis** — pub/sub for realtime, BullMQ queues, rate limit.
- **MinIO** (S3-compatible) — polymorphic attachment storage.
- **SSE** for browser realtime + **HMAC-signed webhooks** for agent push.
- **Tailwind CSS** with a warm-earthy design-token system.
- **Vitest** + **Playwright**; GitHub Actions for CI.

## Primitives

All tenant-scoped on `workspaceId`.

| Primitive         | What it is                                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workspace**     | Tenant. Short `key` (e.g. `AXI`, `PER`, `WRK`) is the issue prefix and is immutable after create. Slug/name can change freely.                                                                                              |
| **Project**       | Groups issues. Optionally nests under an Initiative.                                                                                                                                                                        |
| **Issue**         | The unit of work. Optional `projectId`, optional `cycleId`, optional human assignees, optional **agent** assignee.                                                                                                          |
| **Sprint**        | Time-boxed iteration. Default length from `Workspace.cycleLengthDays`. Issues move in/out freely. Stored internally as `Cycle`; routes (`/cycles`) and MCP namespace (`cycles.*`) keep the original name for compatibility. |
| **Initiative**    | Umbrella above projects — quarterly bets, themes.                                                                                                                                                                           |
| **IssueRelation** | Directed, typed link (`BLOCKS`, `BLOCKED_BY`, `DUPLICATES`, `RELATES_TO`).                                                                                                                                                  |
| **TimeEntry**     | Per-user duration rows against issues, gated by `Workspace.timeTrackingEnabled`.                                                                                                                                            |
| **Attachment**    | Polymorphic via `targetType` + `targetId`; MinIO-backed.                                                                                                                                                                    |
| **Agent**         | First-class non-human actor. `profileKey` (stable handle), `capabilities[]`, `webhookUrl`, `status`, `maxConcurrent`. Receives dispatch via webhook; authenticates via linked ApiKey.                                       |

## Execution model

Forge is the execution layer: approved work lives as issues, backlog items,
sprints, assignments, blockers, and done history. Durable notes, raw capture,
and private decision logs can stay outside Forge; use issue templates and the
Backlog for proposed work that still needs review. Nothing is auto-promoted
into an active sprint.

Default issue templates cover dev tasks, agent-ready handoffs, personal tasks,
finance follow-ups, side quests, and review items. The agent-ready template
asks for objective, system area, acceptance criteria, safety boundaries, and
verification path. Shared household or couple-specific workflows are deferred;
Forge only ships generic workspace/project/template primitives today.

## Agents &amp; MCP

Forge exposes a dual MCP endpoint at `/api/mcp/rpc` (JSON-RPC 2.0) and
`/api/mcp/:tool` (REST alias). 44 tools cover every primitive:

```bash
# List all tools
curl -s https://forge.example.com/api/mcp/rpc \
  -H "Authorization: Bearer $FORGE_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Claim the next queued issue as this agent
curl -s https://forge.example.com/api/mcp/rpc \
  -H "Authorization: Bearer $FORGE_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"issues.claim","arguments":{}}}'

# See what's currently assigned to me
curl -s https://forge.example.com/api/mcp/rpc \
  -H "Authorization: Bearer $FORGE_KEY" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"issues.assigned","arguments":{}}}'
```

Keys are narrowable: `scopes` (coarse, a subset of the owning plugin's
manifest) plus optional `projectIds` / `labelIds` / `initiativeIds` arrays
that restrict what the key can see or act on. A per-initiative bot gets
only that initiative; a full-trust agent gets no narrowing.

**Auto-dispatch.** A workspace can toggle `autoDispatch` and pick a mode
(`ROUND_ROBIN` / `PRIORITY_MATCH` / `CAPABILITY_MATCH`). Queued issues are
routed to the best-fit agent automatically, with `maxConcurrent` respected
and `AGENT_ASSIGNED` events firing into the webhook stream carrying full
decision provenance (`payload.dispatch.{mode, candidates, chosen, reason}`
— operators can replay _why_ an agent was picked, and which agents were
ineligible, from the event alone).

**Dispatch rules** run _before_ mode-based selection. Admins configure
`(priority, labelId, projectId) → targetAgent` rules at
`/settings/dispatch-rules`; conditions are ANDed with null = wildcard,
first match wins (order-sortable). A matched rule with an ineligible
target falls through to mode-based selection rather than stalling, and
the fallthrough is preserved on the event reason.

**Per-agent issue templates.** If `Agent.templateMarkdown` is set, it is
applied to the issue description on assign _only when the description is
empty_ — agents never overwrite human content. Runs in the same
transaction as the assignment for all four assignment paths (auto, manual,
reassign, initial-create-with-assignee).

**Heartbeat + auto-offline.** Agents ping `agent.heartbeat` to keep
`lastHeartbeatAt` fresh. A BullMQ-scheduled sweep (`maintenance` queue,
every 60s) flips agents to `OFFLINE` when their heartbeat is older than
`Workspace.agentIdleTimeoutMinutes`, emitting `AGENT_STATUS_CHANGED`.

**Notification bridge.** Built-in plugin at `plugins/notification-bridge/`
forwards configurable `EventKind`s to Slack + Discord webhooks with
formatted payloads. Configure per-workspace via `Plugin.manifest.config`;
supports `mentionsOnly` filtering and block-lists noisy internal kinds.

Hermes integration — agents configured via a single YAML block:

```yaml
mcp_servers:
  forge:
    url: "https://forge.example.com/api/mcp/rpc"
    headers:
      Authorization: "Bearer forge_sk_..."
    timeout: 120
    connect_timeout: 60
```

## Quick start

```bash
# 1. Services (Postgres + Redis + MinIO)
cd docker && docker compose up -d
# MinIO console: http://localhost:59001 (forgeminio / forgeminio-dev-password)

# 2. Install + bootstrap DB
cp .env.example .env            # fill in values (S3 vars are pre-filled for the
                                # bundled MinIO; rotate creds before deploying)
pnpm install
pnpm prisma:generate
pnpm prisma:migrate             # applies all migrations
pnpm prisma:seed                # seeds workspaces + issues + labels

# 3. Seed agents (optional — creates Victor + Mizu in AXI)
pnpm seed:agents

# 4. Run
pnpm dev                        # http://localhost:3000
pnpm worker                     # separate process: webhook + metric workers
```

## Keyboard

| Shortcut   | Action                        |
| ---------- | ----------------------------- |
| `⌘K` / `/` | Command palette               |
| `⇧C`       | Quick-create (pathname-aware) |
| `?`        | Keyboard help overlay         |
| `⌘\`       | Collapse sidebar              |
| `G` `I`    | Go to Inbox                   |
| `G` `D`    | Go to Dashboard               |
| `G` `S`    | Go to Issues                  |
| `G` `P`    | Go to Projects                |
| `G` `C`    | Go to Sprints                 |
| `G` `A`    | Go to Analytics               |
| `G` `E`    | Go to Agents                  |
| `⇧A`       | Assign agent (issue detail)   |

Full table lives in `src/lib/shortcuts.ts` and is rendered by the `?`
overlay.

## Project layout

```
src/
  app/              # App Router pages + API route handlers
  components/       # UI (sidebar, topbar, modal primitives, palette)
  lib/              # utils, trpc client, keyboard, providers
  server/           # db, redis, auth, trpc routers, services
    routers/        # workspace, project, issue, cycle, agent, …
    services/       # mcp, dispatcher, api-key-auth, storage (MinIO)
prisma/             # schema + migrations + seed
plugins/            # local-runtime plugin handlers (sample)
scripts/            # seed-agents, etc.
docker/             # dev compose (pg + redis + minio)
tests/              # unit (vitest) + e2e (playwright)
```

## Deployment

- **Self-host** (recommended): `docker compose up -d` behind Traefik/Caddy.
  Entrypoint runs `prisma migrate deploy` on boot. Provide `DATABASE_URL`,
  `REDIS_URL`, `AUTH_SECRET`, `PLUGIN_JWT_SECRET`, S3/MinIO creds.
- **Vercel**: tRPC, auth, SSE, and MCP routes are Node-runtime compatible;
  external Postgres + Redis + S3 required.

## License

MIT.
