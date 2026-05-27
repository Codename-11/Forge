# Forge Release Workflow

> Canonical release policy for Forge. **GitHub Flow** — one long-lived branch
> (`main`), short-lived feature branches, ship continuously to the single
> self-hosted instance.

## Branch Model

```
main      ← the only long-lived branch; always deployable AND deployed; releases tagged here
feat/*    ← short-lived feature branches from main → PR → squash-merge → main
fix/*     ← bugfix branches from main
chore/*   ← maintenance branches from main
docs/*    ← documentation branches from main
```

**Rules:**
- `main` is always deployable. Every merge to `main` can ship.
- Work lands via PR (review surface for humans + agents). Branch protection isn't
  available on this plan, so this is convention — keep it anyway.
- Branches are short-lived — open the PR within a day or two of branching; delete
  merged branches immediately.
- No long-lived `dev`/`staging` branch. Reintroduce one only if/when a separate
  **staging deploy target** exists (then: `feat/* → PR → dev (staging) → PR → main (prod)`).

## Versioning

[Semantic Versioning 2.0.0](https://semver.org/). Pre-1.0 (`0.x`): MINOR is the
"feature" bump, PATCH is fixes; breaking changes are allowed within `0.x`.

| Bump | When |
|------|------|
| **MAJOR** (`X.0.0`) | (post-1.0) breaking API/schema/UX changes |
| **MINOR** (`x.Y.0`) | New features, MCP tools, UI surfaces, additive schema |
| **PATCH** (`x.y.Z`) | Bug fixes, perf, security, docs |

`package.json` `version` must match the tag you cut.

## Release Process

### 1. Land the work
- Open a PR `feat/* → main`. CI (`.github/workflows/ci.yml`: lint · typecheck · unit ·
  Playwright e2e) must be green. **Squash-merge** with a clean message.
- Update `CHANGELOG.md` under a heading `## [YYYY-MM-DD] — vX.Y.Z · Short title` — the
  bracket date drives the in-app "unseen" dot + ordering; the `— vX.Y.Z · Title` tail is
  the release name shown in What's New. Group items under `### Added/Changed/Fixed/Removed`.
  Bump `package.json` `version` to match the tag. (Draft with `pnpm changelog`, then curate.)

> CI note: GitHub-hosted Actions require billing to be enabled. If Actions are
> unavailable, gate the release on the equivalent local run
> (`pnpm lint && pnpm typecheck && pnpm test` + `pnpm test:e2e` against the
> `docker/docker-compose.yml` stack) and record that in the release notes.

### 2. Tag the release
```bash
git checkout main && git pull origin main
git tag vX.Y.Z && git push origin vX.Y.Z
```
(Or trigger `.github/workflows/release.yml` — manual version bump + tag + GitHub Release —
once Actions billing is restored.)

### 3. Deploy (Docker-Server)
Prod builds the working tree at `main`, stamped with the commit:
```bash
cd /home/bailey/forge && git checkout main && git pull
cd ~/docker/forge
GIT_SHA=$(git -C /home/bailey/forge rev-parse --short HEAD) \
BUILD_TIME=$(date -u +%FT%TZ) docker compose build forge forge-worker
docker compose up -d                  # entrypoint runs `prisma migrate deploy`
# run any one-time data backfill explicitly (prod image has no tsx — copy a .cjs + `node`)
```

### 4. Smoke test
`forge.axiom-labs.dev` loads · sign-in works · core flows (issue create, agent dispatch,
MCP health) · `system.buildInfo` reports the deployed SHA · `docker compose logs forge`
clean.

### 5. Close the loop
Update `DEVLOG.md`; mark issues done; note state in the project log if it changed.

## Hotfix
Same as a normal change — branch `fix/*` from `main`, PR, squash-merge, tag a PATCH,
deploy. (No back-merge needed; `main` is the only long-lived branch.)
</content>
