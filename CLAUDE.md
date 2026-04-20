# Forge — Claude Code Context

> Read before working on this repo. Project-specific; inherits from `~/CLAUDE.md`.

## What Forge is

A Linear-style project management platform. Fast, minimalist, keyboard-driven.
Extensible via a plugin/skill/MCP system. Built for humans and agents equally.

## Stack

Next.js 15 · TypeScript · Prisma 6 / Postgres · tRPC 11 / Zod · NextAuth v5 ·
Redis (pub/sub + rate limit + BullMQ) · Tailwind (warm-earthy tokens) ·
Vitest + Playwright.

## Where things live

| What                        | Where                                    |
|-----------------------------|------------------------------------------|
| DB schema                   | `prisma/schema.prisma`                   |
| tRPC routers                | `src/server/routers/`                    |
| Plugin runtime + MCP        | `src/server/services/`                   |
| API route handlers          | `src/app/api/`                           |
| App pages (RSC + client)    | `src/app/(app)/`                         |
| Design tokens               | `src/app/globals.css`, `tailwind.config.ts` |
| Sample plugin               | `plugins/issue-triage/`                  |
| DevLog                      | `DEVLOG.md` — update at session end      |

## Primitives

All tenant-scoped on `workspaceId`.

- **Workspace** — tenant. Short `key` (e.g. `AXI`, `PER`, `WRK`) is the
  issue-id prefix (`AXI-42`) and is **immutable after create** — changing
  it means a data migration (see Phase 1 of 2026-04-20 in `DEVLOG.md`
  for the pattern). Slug/name can change freely.
- **Project** — groups issues. Optionally belongs to an Initiative.
- **Issue** — the unit of work. Optional `projectId`, optional `cycleId`.
- **Cycle** — time-boxed iteration (default length from
  `Workspace.cycleLengthDays`). Issues move in/out of cycles.
- **Initiative** — higher-level bucket above projects (quarterly bets,
  themes). Projects nest under initiatives via nullable `initiativeId`.
- **IssueRelation** — directed, typed link between issues
  (blocks / duplicates / related / …). Cascade-deleted from either end.
- **TimeEntry** — per-user duration rows against issues. Only active when
  `Workspace.timeTrackingEnabled`.
- **Attachment** — polymorphic via `targetType` + `targetId`. Can hang
  off any entity (issue/comment/project/initiative/…). Backed by MinIO.

## Configurability

Bailey's system-wide value: **prefer settings-driven values over
hardcoded defaults.** Every workspace-level knob should surface as a
column on `Workspace` (or a row in a settings table) — no magic numbers
baked into handlers. Current knobs: `cycleLengthDays` (7),
`cycleCooldownDays` (0), `timeTrackingEnabled` (false),
`attachmentQuotaMb` (1024).

## Granular ApiKey scopes

`ApiKey` has the usual coarse `PluginScope[]` ceiling *plus* three
narrowing arrays: `projectIds`, `labelIds`, `initiativeIds`. Empty =
unrestricted within the declared scopes. Non-empty = key only sees/acts
on rows matching those ids. Currently Victor and Mizu hold FULL scope
and no narrowing; future sub-agents should be narrowed where possible
(e.g., a per-initiative bot gets only that `initiativeId`).

## Conventions

- **Every tenant-scoped row** includes `workspaceId`. Access gated by
  `workspaceProcedure` / `adminProcedure` in `src/server/trpc.ts`.
- **Write audit + event together.** Use `recordChange()` from
  `src/server/audit.ts` — it creates an `AuditLog` and `ActivityEvent` in
  the same transaction and publishes to Redis for SSE fan-out.
- **Scope-gated plugin access.** Manifest `scopes` is the ceiling for any
  API key issued. Enforce in `api-key-auth.ts`.
- **No mocks in integration tests.** Use the Postgres + Redis service
  containers from `docker/docker-compose.yml`.
- **Keep client components small.** Data comes from tRPC queries; RSC is
  used for session resolution and the shell layouts.

## Design style

Nothing-inspired minimalism + Anthropic warm earthy. Tokens in
`globals.css` — do not hardcode colors. Prefer `bg-card/40` and
`text-muted-foreground` over ad-hoc tailwind classes. Mono for identifiers
(issue IDs, keys), sans for everything else.

## What NOT to do

- No pure white or pure black — always warm paper or graphite (see tokens).
- No blocking pub/sub on mutation path. Publish is best-effort; durability
  is in `WebhookDelivery` rows, processed by `src/server/worker.ts`.
- No global `PrismaClient` re-instantiation in dev (already guarded; don't
  add bypass).
- No giant feature commits — DEVLOG each session, then commit.

## Before shipping

1. `pnpm lint && pnpm typecheck && pnpm test`
2. `pnpm test:e2e` (needs Postgres + Redis)
3. Append to `DEVLOG.md`
4. Commit; optional push.
