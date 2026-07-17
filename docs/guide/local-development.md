# Local development

How to run Forge on your machine for fast UI iteration, how to get data
into your local database, and how to move a workspace between instances.

## Safe workstation commands

`pnpm dev` is deterministic and local-only. It loads the gitignored
`.env.local`, rejects production-like database/S3/Redis/container overrides,
starts only missing local services, waits for all three health checks, applies
only needed local Prisma migration/client work, seeds only an empty verified
local database, and immediately launches host-native `next dev --turbo`.
Containers, volumes, and `.next` Turbopack cache survive restarts.

| Command                                   | Behavior                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm dev`                                | Intelligent local services/schema/seed check, then Turbo HMR.                       |
| `pnpm dev -- --fresh`                     | Confirmed local schema reset, migrate, base seed, start.                            |
| `pnpm dev:reset`                          | Same confirmed reset workflow.                                                      |
| `pnpm dev:services`                       | Verify/start local Postgres, Redis, and MinIO; do not start Next.                   |
| `pnpm dev:app`                            | Verify services are already healthy, then start Next without migration/seed checks. |
| `pnpm dev:scenario -- <name> [--scale N]` | Compose named fixtures on the base seed, then start Next.                           |
| `pnpm dev:refresh [-- --dry-run]`         | Confirmed read-only production snapshot streamed into local Postgres.               |

Every command prints what it started, skipped, migrated, generated, seeded,
or replaced plus the selected local database and endpoints. The TypeScript
orchestrator works when invoked from Windows PowerShell or Git Bash.

Sign in with the stable bootstrap credentials it prints:

Sign in with the bootstrap credentials it prints:

```
owner@forge.local / forge-dev
```

(Override via `ADMIN_EMAIL` / `ADMIN_PASSWORD` env vars before running.)

::: tip
The base seed (`prisma/seed.ts`) is deliberately simple and idempotent.
Re-running `pnpm dev` on a populated database skips it; use `--fresh`
when you want a clean base. Named scenarios are a separate, composable layer.
:::

### Exceptional live-data inspection

Normal workstation commands never target deployed services. If a production
row must be inspected with local UI code, the deliberately alarming command is:

```bash
pnpm dev:live:unsafe
```

It prints a production-write warning and disables in-process workers by
default, leaving the deployed worker authoritative. The even higher-risk
`pnpm dev:live:workers:unsafe` and `dev:live:stack:unsafe` commands are reserved
for short, explicitly authorized worker investigations. They are not part of
the normal local loop.

## What the seed gives you

`pnpm prisma:seed` (run automatically by `pnpm dev` on an empty DB)
creates a realistic workspace so the UI isn't empty:

- Workspace **Forge** (`FRG`) with time-tracking and capability-match
  auto-dispatch enabled, plus three members.
- Six statuses, seven labels, two initiatives, three projects.
- Two sprints (one active, one planned) and two agents (`victor`, `mizu`).
- ~24 issues spread across statuses, priorities, projects, and sprints,
  with assignees, labels, relations, and a few comment threads.

## Composable scenario fixtures

Build focused local states on top of the base demo without adding permanent
complexity to `prisma/seed.ts`:

```bash
pnpm seed:scenarios -- --list
pnpm seed:scenarios -- --scenarios delivery-github,status-freshness
pnpm seed:scenarios -- --scenarios activity-overflow,large-workspace --scale 4
pnpm seed:scenarios -- --scenarios all --scale 2 --dry-run
```

The named scenarios cover Delivery/GitHub provenance, fresh/quiet/stale/waiting
statuses, activity grouping and overflow, cross-tenant isolation, member-invite
and agent-concurrency states, and large-workspace performance. Names compose in
any order. IDs, structural timestamps, issue numbers, and generated content are
stable; freshness and pending-invitation deadlines are derived from each seed
execution so their advertised states do not age out. Each selected scenario
replaces only its own stable CUID-prefixed rows, so re-running is idempotent and
changing scale produces the exact requested size. The runner requires the exact
local Docker credentials and public schema and accepts only `forge`,
`forge_e2e`, and `forge_lifecycle` on `localhost:55432`.

To add a future scenario, add its declarative count/description to
`scripts/scenarios/plan.ts` and its isolated seeder branch in
`scripts/seed-scenarios.ts`; the base demo seed does not need to change.

## Getting real data locally

Two paths, depending on whether you want an exact replica or a portable
slice.

### Full replica — `pnpm db:clone-prod`

Clones the deployed database into the local docker stack at the Postgres
level — every table, every row, correct foreign keys:

```bash
pnpm dev:refresh -- --dry-run # inspect exact source, target, and actions
pnpm dev:refresh              # type the required confirmation phrase
pnpm dev:app                  # iterate against the refreshed local data
```

The command prints and validates the exact destructive target:
`forge-dev-postgres`, `localhost:55432`, database `forge`, schema `public`,
user `forge`. It refuses any mismatch. By default it requires an interactive
confirmation; automation must opt in with `--yes`. The read-only `pg_dump`
runs over SSH on `FORGE_PROD_SSH_HOST` (default `docker-server.local`) and is
streamed directly into local Postgres. The production env and password are
read and expanded only by the remote shell, never copied to or persisted on
the workstation. The dump is never written to disk.

After import, Prisma migrations run with the fixed local `DATABASE_URL` only.
Re-running repeats the same confirmed replacement of the local database, which
is useful for refreshing an older snapshot. It never writes to production.
If either side of the stream fails, treat the local database as partial and
rerun `pnpm dev:refresh` or recover a clean base with `pnpm dev:reset`; the
command reports both stream exit codes and never attempts production repair.

::: warning
Attachment **bytes** live in MinIO and are _not_ copied. FILE attachment
rows will point at objects that don't exist in the local bucket; their
metadata and all LINK attachments are intact. Everything else is a faithful
copy.
:::

### Portable slice — Data export / import

For moving a single workspace between instances (or grabbing a snapshot
without cloning the whole database), use **Settings → Admin → Data export /
import** (admin only):

- **Export** downloads the current workspace's core content as one JSON
  file: settings, statuses, labels, initiatives, projects, sprints,
  agents, and issues (with assignees, labels, relations) plus comments.
  Infra rows — API keys, webhooks, the audit log, attachment bytes — are
  intentionally excluded.
- **Import** loads a snapshot into the current workspace. It is
  **additive**: configuration rows are matched by natural key (status /
  label / sprint name, project key, initiative slug, agent `profileKey`)
  and reused; issues are always created fresh with new numbers; relations
  and comments are rewired onto the new issue ids; unknown authors fall
  back to you. Nothing is deleted.

A common loop is: export your production workspace, spin up `pnpm dev`, then
import the JSON into the fresh local workspace.

## Running the worker

The Next dev server boots the BullMQ workers in-process via
`src/instrumentation.ts`, so webhook delivery, presence sweeps, and SLA
checks already run under `pnpm dev`. To run the worker
as a standalone process (as production does):

```bash
pnpm worker
```

## Before you ship

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e        # needs Postgres + Redis
```

Then append a line to `DEVLOG.md` and commit.

## Measuring issue UI load

Use the local-only benchmark harness with a synthetic issue id:

```bash
node scripts/benchmark-ui-load.mjs \
  --issue-id <local-synthetic-issue-id> \
  --label local \
  --output output/playwright/ui-load-local.json
```

See [UI load performance](/engineering/ui-load-performance.html) for the
captured signals and interpretation guidance. Successful tRPC client operations
stay quiet by default; start Next with `NEXT_PUBLIC_TRPC_VERBOSE=1` when that
diagnostic stream is intentionally needed. Errors continue to log in either
mode.

## Where to next

- [Quickstart](/guide/quickstart.html) — first-run product walkthrough.
- [Architecture](/guide/architecture.html) — how the pieces fit.
- [Settings](/guide/settings.html) — every settings surface, including
  Data export / import.
- [Environment](/reference/env.html) — the full env-var reference.
