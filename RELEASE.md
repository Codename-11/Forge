# Forge Release Workflow

> Canonical release policy for Forge. **GitHub Flow** — one long-lived branch
> (`main`), short-lived feature branches, and serialized releases to the single
> self-hosted instance.

## Branch Model

```
main                ← only long-lived branch; always deployable; releases tagged here
codex/<issue>-*     ← Codex/Forge agent work
<contributor>/<issue>-* ← human contributor work
fix/<issue>-*       ← bugfix branches from main
```

**Rules:**

- `main` is always deployable. Every merge to `main` can ship.
- Work lands via PR (review surface for humans + agents). Branch protection isn't
  available on this plan, so this is convention — keep it anyway.
- Branches are short-lived — open the PR within a day or two of branching; delete
  merged branches immediately.
- One Forge issue owns one active work session, isolated worktree/branch, and
  primary implementation PR. Claim it before editing; stale sessions must be
  resumed or abandoned, never silently replaced.
- The checkout used for production is deployment-only. Development happens in
  task-owned worktrees and never in the production or integration checkout.
- No long-lived `dev`/`staging` branch. Staging may deploy an exact `main` SHA;
  an environment does not require a matching branch. Introduce `dev` only if
  Forge needs a genuine integration/stabilization train, then document the new
  PR, release, hotfix, and back-merge rules before using it.

Forge's explicit branch contract:

| Setting                             | Value                                      |
| ----------------------------------- | ------------------------------------------ |
| Integration branch / normal PR base | `main`                                     |
| Release branch / tag source         | `main`                                     |
| Staging source                      | Exact tested `main` SHA                    |
| Production source                   | Immutable `vX.Y.Z` tag contained in `main` |
| Hotfix base                         | Current production tag or `main`           |
| Back-merge target                   | None; `main` is the only long-lived branch |

## Versioning

[Semantic Versioning 2.0.0](https://semver.org/). Pre-1.0 (`0.x`): MINOR is the
"feature" bump, PATCH is fixes; breaking changes are allowed within `0.x`.

| Bump                | When                                                  |
| ------------------- | ----------------------------------------------------- |
| **MAJOR** (`X.0.0`) | (post-1.0) breaking API/schema/UX changes             |
| **MINOR** (`x.Y.0`) | New features, MCP tools, UI surfaces, additive schema |
| **PATCH** (`x.y.Z`) | Bug fixes, perf, security, docs                       |

`package.json` `version` must match the tag you cut.

## Release Process

Use the fast quality gate while iterating and before pushing a release candidate:

```bash
pnpm ci:local:quality
```

The required release gate is GitHub CI on the exact PR head. Its lint,
typecheck, unit/integration, build, and Playwright jobs must finish successfully
before merge. After any new commit, wait for CI to rerun against that new SHA;
results from an earlier head do not qualify the release.

Do not routinely duplicate the complete CI matrix locally. Run the complete
local gate when GitHub Actions is unavailable, when diagnosing a CI failure, or
when a database, migration, browser, concurrency, or environment-sensitive
change warrants local integration evidence:

```bash
pnpm ci:local
```

The TypeScript runner is cross-platform. It starts or verifies the guarded
local services, supplies only the known local development endpoints, generates
the Prisma client, and runs lint, typecheck, and Vitest once. It then serializes
Playwright behind a portable machine-local lock and selects an available port.
`pnpm ci:local:e2e` runs only the E2E phase; add `-- --reuse-e2e-build` only when
the existing production build is known to match the current source. These
local commands provide fast feedback or supplemental evidence; they never
replace exact-head CI when GitHub Actions is available.

### Authorized single-PR patch releases

A small, cohesive patch may include its version bump and curated changelog in
the implementation PR only when the operator authorizes that release and
assigns its version and release owner before implementation begins. The exact
PR head must pass CI; after squash-merge, tag the exact resulting `main` SHA and
follow the normal deploy and verification steps below.

Use a separate release issue/PR when release authority or the version was not
preassigned, when multiple merged changes are being batched, or when release
assembly needs independent review. Never add an uncoordinated version bump to
an ordinary feature PR.

### 1. Land the work

- Open a PR `<owner>/<issue>-* → main`. CI (`.github/workflows/ci.yml`: lint · typecheck · unit ·
  Playwright e2e) must be green. **Squash-merge** with a clean message.
- Update `CHANGELOG.md` under a heading `## [YYYY-MM-DD] — vX.Y.Z · Short title` — the
  bracket date drives the in-app "unseen" dot + ordering; the `— vX.Y.Z · Title` tail is
  the release name shown in What's New. Group items under `### Added/Changed/Fixed/Removed`.
  Bump `package.json` `version` to match the tag. (Draft with `pnpm changelog`, then curate.)
- Only the designated release owner changes the version, assembles final release
  notes, and merges the release commit. Feature PRs must not race independent
  version bumps or tags.

> CI outage fallback: if GitHub Actions is unavailable, gate the release on
> `pnpm ci:local` against the guarded local service stack and record the exact
> command, commit SHA, result, and reason for using the fallback in the release
> notes. A local result is not a substitute merely because CI is slow or queued.

### 2. Tag the release

```bash
git checkout main && git pull origin main
git tag vX.Y.Z && git push origin vX.Y.Z
```

(Or trigger `.github/workflows/release.yml` — manual version bump + tag + GitHub Release —
once Actions billing is restored.)

### 3. Deploy (Docker-Server)

Prod builds an exact tag/commit from a dedicated clean checkout, stamped with
the commit. The deployment lock permits one release at a time:

```bash
flock /tmp/forge-production-deploy.lock
cd /home/bailey/deploy/forge-prod
git fetch origin main --tags
git checkout --detach vX.Y.Z
git status --porcelain # must be empty
cd ~/docker/forge
FORGE_SOURCE_PATH=/home/bailey/deploy/forge-prod \
GIT_SHA=$(git -C /home/bailey/deploy/forge-prod rev-parse --short HEAD) \
BUILD_TIME=$(date -u +%FT%TZ) docker compose build forge forge-worker
docker compose up -d                  # entrypoint runs `prisma migrate deploy`
# run any one-time data backfill explicitly (prod image has no tsx — copy a .cjs + `node`)
```

The deployment Compose must preserve the checked-in
`docker/docker-compose.production.example.yml` network contract. In
particular, `forge-worker` needs the private data network plus a non-internal
egress network so managed-runtime probes and Runs dispatch use the same
reachable execution plane. It must not publish ports or join the public proxy
network. The web app may join the proxy network and must set
`FORGE_DISABLE_IN_PROCESS_WORKER=1` when the sidecar is present.

### 4. Smoke test

`forge.axiom-labs.dev` loads · sign-in works · core flows (issue create, agent dispatch,
MCP health) · `system.buildInfo` reports the deployed SHA · `docker compose logs forge`
clean.

### 5. Close the loop

Update `DEVLOG.md`; mark issues done; note state in the project log if it changed.
Record the exact release, deployed SHA, and live verification in the issue's
Delivery card. “Merged,” “released,” and “verified live” are separate facts.

## Hotfix

Same as a normal change — branch `fix/*` from `main`, PR, squash-merge, tag a PATCH,
deploy. (No back-merge needed; `main` is the only long-lived branch.)
</content>
