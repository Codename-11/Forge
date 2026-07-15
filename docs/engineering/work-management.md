# Work Management and Delivery Policy

Forge and Codex Desktop are work surfaces. GitHub `origin` is the shared source
of truth for code; Forge is the source of truth for ownership and delivery
state. The same rules apply to humans, agents, and outside contributors.

## One issue, one active delivery session

Before changing code:

1. Start from current `origin/main`.
2. Check the issue's **Delivery** card for active ownership.
3. Claim one work session with the repository, branch, base branch, and isolated
   worktree path.
4. If a session already exists, continue it or explicitly abandon it. Do not
   create a competing branch.

Branch names include the issue key and owner namespace, for example
`codex/axi-123-short-description` or `bailey/axi-123-short-description`.
Never work directly in `main` or in the production checkout.

## During implementation

- Refresh the work-session heartbeat at meaningful phase changes and after
  commits. Mechanical tool traces do not replace a heartbeat or semantic status.
- Push early and open a PR early when overlap is likely.
- Link implementation PRs with Forge's native GitHub relation and kind
  `IMPLEMENTS`; never use a generic link attachment for a PR.
- GitHub owns PR state, reviews, checks, mergeability, and merge state. Forge
  mirrors those facts into the delivery lifecycle.
- Resolve file overlap in the PR. Do not move uncommitted patches between
  worktrees or share one worktree between tasks.

## Delivery lifecycle

```text
Claimed → In progress → PR open → In review → Ready to merge → Merged
        → Released → Deployed → Verified
```

`Verified` is the terminal success state. `Abandoned` explicitly releases the
ownership lease. A stale session remains a lease and raises a shared action
request; it must be resumed or abandoned before replacement work starts.

Release, deploy, and verification transitions require workspace admin authority.
Feature work may run in parallel, but merges and production delivery are
serialized.

## Pull requests

- Every code change lands through a PR, including agent work and hotfixes.
- CI must be green on the current head.
- Address unresolved review threads before merge.
- Refresh from `origin/main` when the base changed materially.
- Squash-merge, delete the remote branch, then remove the local worktree.
- The issue is not done merely because an agent stopped or a PR opened.

## Collision-sensitive changes

Take extra care around Prisma schema/migrations, package versions, changelog,
shared routers, foundational UI, and deployment configuration.

- Prisma migrations use timestamped names (`YYYYMMDDHHMMSS_description`) so
  concurrent contributors cannot allocate the same sequence number.
- Feature PRs do not independently cut competing releases. A designated release
  owner assembles release notes, bumps the version, tags the exact merged SHA,
  and deploys it.
- Never silently resolve a schema or migration conflict by dropping another
  contributor's migration.

## Production

Production builds an exact tag or commit from a dedicated clean checkout. The
development checkout is never a deployment source. A deploy is accepted only
when:

- the target commit is on `origin/main`;
- the checkout is clean;
- CI/local release gates passed;
- the deployment lock is held;
- migrations complete;
- smoke checks pass; and
- the running build reports the expected SHA.

Record release, deployment, and live verification separately in Forge so an
operator can distinguish “merged” from “actually available.”

## Cleanup

After merge or abandonment, remove the worktree and prune the branch. Review
stale sessions rather than deleting them automatically: an old worktree may
contain unpushed work. Preserve or recover that work before cleanup.
