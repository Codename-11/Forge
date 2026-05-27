# Forge Release Workflow

> Canonical release policy for Forge (PM). Lane B — Platform/Service Deploy per [Axiom Delivery Workflows](https://github.com/Codename-11/forge/blob/main/RELEASE.md).

## Branch Model

```
main              ← production deploy branch; always deployable; tagged releases cut from here
dev               ← integration/staging branch; feature PRs target this
feat/*            ← feature branches from dev
fix/*             ← bugfix branches from dev (or main for hotfixes)
chore/*           ← maintenance branches from dev
docs/*            ← documentation branches from dev
release/vX.Y      ← release preparation branches (optional, for major releases)
```

**Rules:**
- `main` is sacred — it must always be deployable. No direct pushes.
- All work lands via PR. No exceptions, even for repo owners.
- Feature branches are short-lived — open the PR within 24–48 hours of branching.
- Delete merged branches immediately.

## Versioning

[Semantic Versioning 2.0.0](https://semver.org/):

| Bump | When |
|------|------|
| **MAJOR** (`X.0.0`) | Breaking API changes, schema migrations requiring operator action, or significant UX rewrites |
| **MINOR** (`x.Y.0`) | New features, new MCP tools, new UI surfaces, additive schema changes |
| **PATCH** (`x.y.Z`) | Bug fixes, performance improvements, security patches, docs corrections |

Pre-release versions: `v1.2.0-rc.1`, `v1.2.0-rc.2`, etc.

## Release Types

### Stable Release (`vX.Y.Z`)

Cut from `main` after `dev` has been validated.

```
dev  →  PR →  main  →  tag vX.Y.Z  →  deploy  →  smoke
```

### Pre-release / RC (`vX.Y.Z-rc.N`)

Cut from `dev` to stage-test before merging to `main`.

```
dev  →  tag vX.Y.Z-rc.N  →  deploy to staging  →  validate  →  PR dev→main  →  tag vX.Y.Z
```

RCs are **optional** for Forge. Use them when:
- A release contains risky migrations or architectural changes
- You want external/agent validation before production deploy
- You're preparing a public announcement and want a stable target

For routine patches and small features, skip the RC — merge `dev` → `main` and tag directly.

### Hotfix

For production bugs that can't wait for the next scheduled release.

```
main  →  branch fix/critical-bug  →  PR →  main  →  tag vX.Y.Z+1  →  deploy
                ↓
               merge main back into dev
```

## Release Process

### 1. Prepare

- Ensure all intended work is merged to `dev`
- `pnpm lint && pnpm typecheck && pnpm test` passes locally
- `CHANGELOG.md` is updated with the pending release section (this is the app-facing What's New source)
- Version in `package.json` matches the intended tag

### 2. Validate (optional RC)

If doing an RC:
```bash
git checkout dev
git pull origin dev
# Tag and push RC
git tag v1.2.0-rc.1
git push origin v1.2.0-rc.1
```
Deploy the RC tag to staging and run smoke tests.

### 3. Merge to Main

```bash
# Open a PR: dev → main
gh pr create --base main --head dev --title "release: v1.2.0" --body-file .github/release-pr-template.md
```

Wait for CI to pass, then **squash merge** with a clean commit message:
```
release: v1.2.0

- Multi-workspace restructure (AXI-58)
- Agent engagement modes (AXI-53)
- Inbox + activity notifications
```

### 4. Tag the Release

```bash
git checkout main && git pull origin main
git tag v1.2.0
git push origin v1.2.0
```

Or use the GitHub UI: Releases → Draft → choose tag → auto-generate notes.

### 5. Deploy

```bash
# On Docker-Server
cd ~/docker/forge
docker compose pull  # if using registry build
docker compose up -d
# Or rebuild from source:
cd ~/forge && git checkout v1.2.0
cd ~/docker/forge && docker compose up -d --build
```

### 6. Smoke Test

- `forge.axiom-labs.dev` loads
- Login works
- Core flows: issue create, agent dispatch, MCP health
- Check `docker logs forge-app` for errors

### 7. Close the Loop

- Mark Forge issues as done
- Update `DEVLOG.md`
- Update Obsidian project note if state changed
- Announce in `#hermes-agent` if material

## Changelog Policy

Forge maintains **two changelog surfaces**:

1. **`CHANGELOG.md`** (repo root) — **App-facing What's New source.** Date-based entries (`[2026-05-27]`), read by the dashboard's What's New rail at request time. Update this as features ship on `dev`.
2. **GitHub Release notes** — **Semver release history.** Auto-generated from PRs when a tag is pushed. These are the canonical release notes for operators and external consumers.

Do not confuse the two. `CHANGELOG.md` is for users inside the app; GitHub Releases are for the repo's release page and deploy tracking.

## Worktree Guidance

Use a git worktree when:
- Working on a feature while `dev` has unmerged changes
- Running a long-running experiment or migration test
- An agent needs an isolated checkout for parallel work

```bash
cd ~/forge
git worktree add ../forge-feature-name -b feat/feature-name origin/dev
cd ../forge-feature-name
# ... work, commit, push, PR to dev ...
```

Clean up after merge:
```bash
cd ~/forge
git worktree remove forge-feature-name
git branch -D feat/feature-name
```

## CI/CD Integration

- **PR to `dev` or `main`**: lint, typecheck, unit tests, Playwright E2E
- **Merge to `main`**: same + optional deploy trigger (future)
- **Tag push (`v*` )**: Docker image build + GitHub Release creation

See `.github/workflows/ci.yml` and `.github/workflows/release.yml`.

## Rollback

If a release is bad:

```bash
# Immediate: revert to previous tag
cd ~/docker/forge
git -C ~/forge checkout v1.1.9  # previous stable
docker compose up -d --build

# Then: fix forward on dev, re-release
```

## Related

- [Axiom Delivery Workflows](~/obsidian-vault/3. System/Operations/Axiom Delivery Workflows.md)
- [Development Standards](~/obsidian-vault/3. System/Operations/Development Standards.md)
- [Forge Project Note](~/obsidian-vault/3. System/Projects/Forge/Forge.md)
