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
