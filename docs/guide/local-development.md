# Local development

How to run Forge on your machine for fast UI iteration, how to get data
into your local database, and how to move a workspace between instances.

## Two dev modes

Forge ships two `next dev` entry points. Both give you Hot Module
Reload — the difference is *which database they talk to*.

| Command          | Database / services            | Use it for |
| ---------------- | ------------------------------ | ---------- |
| `pnpm dev:local` | **Isolated** local docker stack | Rapid UI work in a safe sandbox. Auto-boots Postgres/Redis/MinIO, migrates, and seeds demo data. |
| `pnpm dev`       | **Deployed** (live) data        | Iterating against real production data. Edits are real. |

`pnpm dev` is an alias for the live-data server (`scripts/dev-live.sh`),
which resolves the deployed container IPs at boot and points `next dev` at
them. It's the fastest way to reproduce something against real data, but
**every write hits production** — use it deliberately.

`pnpm dev:local` (`scripts/dev-local.sh`) is the isolated loop:

```bash
pnpm dev:local            # boot stack → migrate → seed-if-empty → HMR dev
pnpm dev:local --fresh    # drop & recreate the schema first, then reseed
pnpm dev:local --no-seed  # skip seeding (e.g. right after db:clone-prod)
```

It brings up `docker/docker-compose.yml` (Postgres on `:55432`, Redis on
`:56379`, MinIO on `:59000` / console `:59001`), applies migrations,
seeds rich demo fixtures into an empty database, and starts the dev
server at `http://localhost:3000`.

Sign in with the bootstrap credentials it prints:

```
owner@forge.local / forge-dev
```

(Override via `ADMIN_EMAIL` / `ADMIN_PASSWORD` env vars before running.)

::: tip
The seed (`prisma/seed.ts`) is idempotent. Re-running `pnpm dev:local`
on a populated database **skips** seeding so you don't get duplicates;
use `--fresh` when you actually want a clean slate.
:::

## What the seed gives you

`pnpm prisma:seed` (run automatically by `dev:local` on an empty DB)
creates a realistic workspace so the UI isn't empty:

- Workspace **Forge** (`FRG`) with time-tracking and capability-match
  auto-dispatch enabled, plus three members.
- Six statuses, seven labels, two initiatives, three projects.
- Two sprints (one active, one planned) and two agents (`victor`, `mizu`).
- ~24 issues spread across statuses, priorities, projects, and sprints,
  with assignees, labels, relations, and a few comment threads.

## Getting real data locally

Two paths, depending on whether you want an exact replica or a portable
slice.

### Full replica — `pnpm db:clone-prod`

Clones the deployed database into the local docker stack at the Postgres
level — every table, every row, correct foreign keys:

```bash
pnpm db:clone-prod
pnpm dev:local --no-seed   # iterate against the cloned data
```

It `pg_dump`s the live container straight into the local one
(`--clean --if-exists --no-owner --no-acl`) and then applies any newer
local migrations. `pg_dump` is read-only, so **production is never
written**.

::: warning
Attachment **bytes** live in MinIO and are *not* copied. FILE attachment
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

A common loop is: export your production workspace, spin up `pnpm
dev:local`, then import the JSON into the fresh local workspace.

## Running the worker

The Next dev server boots the BullMQ workers in-process via
`src/instrumentation.ts`, so webhook delivery, presence sweeps, and SLA
checks already run under `pnpm dev` / `pnpm dev:local`. To run the worker
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

## Where to next

- [Quickstart](/guide/quickstart.html) — first-run product walkthrough.
- [Architecture](/guide/architecture.html) — how the pieces fit.
- [Settings](/guide/settings.html) — every settings surface, including
  Data export / import.
- [Environment](/reference/env.html) — the full env-var reference.
