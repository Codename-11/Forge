# Work Management and Delivery Policy

Forge and Codex Desktop are work surfaces. GitHub `origin` is the shared source
of truth for code; Forge is the source of truth for ownership and delivery
state. The same rules apply to humans, agents, and outside contributors.

## One issue, one active delivery session

Before changing code:

1. Read the repository's `AGENTS.md` and `RELEASE.md`, then start from its
   declared integration branch (`origin/main` for Forge, `origin/dev` for
   Hermes Relay).
2. Check the issue's **Delivery** card for active ownership.
3. Claim one work session with the repository, branch, base branch, and isolated
   worktree path.
4. If a session already exists, continue it or explicitly abandon it. Do not
   create a competing branch.

Branch names include the issue key and owner namespace, for example
`codex/axi-123-short-description` or `bailey/axi-123-short-description`.
Never work directly in a long-lived integration/release branch or in the
production checkout.

The lease is owned by a concrete execution connection, not merely an Agent
Profile. Two MCP clients, or an MCP client and a managed runtime, remain
distinct participants even when they act as the same logical agent. One
connection is primary; additional connections must explicitly join as a
contributor or reviewer, or receive an audited handoff before changing the
branch or advancing delivery state.

Agent connection ids are opaque stable identifiers. Callers and typed action
payloads must not assume they are Prisma CUIDs: historical managed-runtime and
webhook connections used deterministic `ac_*` ids. Data migrations may
normalize storage keys, but must preserve the immutable `legacyId` alias and update
relational plus actionable embedded references atomically.

Delivery provenance records separate facts: actor/profile, invocation source,
connector/transport, and execution runtime. MCP client identity comes from the
negotiated MCP `clientInfo`; missing identity is displayed as an unidentified
client rather than guessed as Codex Desktop or CLI. A runtime is shown only
when an output-producing `AgentRun` carries both a runtime connection and an
external run id. Direct MCP or UI work does not imply runtime execution.

## Project branch contract

Branch topology is project configuration, not an Axiom-wide constant. Every
maintained repository declares these seven facts in `AGENTS.md` or
`RELEASE.md`:

| Fact               | Meaning                                                 |
| ------------------ | ------------------------------------------------------- |
| Integration branch | Normal feature/fix PR target                            |
| Release branch     | Durable released-code history                           |
| Tag source         | Branch/commit from which immutable release tags are cut |
| Staging source     | Exact branch SHA or tag deployed to staging             |
| Production source  | Exact tag/SHA accepted by production                    |
| Hotfix base        | Ref used to begin an emergency fix                      |
| Back-merge target  | Branches that must receive the hotfix afterward         |

Supported shapes include trunk-based (`feature → main → tag`), an integration
train (`feature → dev → release PR → main → tag`), upstream-tracking forks, and
an external maintainer's contribution model. A staging environment does not by
itself require a `dev` branch: staging can deploy an exact `main` SHA. Add a
long-lived integration branch only when the project needs multi-change
integration, scheduled stabilization, or an upstream convention.

## During implementation

- Refresh the work-session heartbeat at meaningful phase changes and after
  commits. Mechanical tool traces do not replace a heartbeat or semantic status.
- Push early and open a PR early when overlap is likely.
- Link implementation PRs with Forge's native GitHub relation: `IMPLEMENTS`
  for delivered behavior or `FIXES` for closing/fixing semantics. Bare issue
  references are `RELATES_TO`; release assembly PRs use `RELEASES` to mean the
  release contains the implementation. Never use a generic link attachment.
- GitHub owns PR state, reviews, checks, mergeability, and merge state. Forge
  mirrors those facts into the delivery lifecycle.
- Check aggregation counts suites that contain executable check runs. GitHub
  App suites explicitly reporting zero check runs are diagnostic installation
  artifacts, not pending CI; suites with real or unknown run counts remain
  fail-closed until GitHub reports a terminal result.
- One issue/resource pair has one native relation. Re-linking reclassifies the
  relation instead of duplicating status cards.
- Resolve file overlap in the PR. Do not move uncommitted patches between
  worktrees or share one worktree between tasks.
- If dispatch discovers an existing primary connection, park a second execute
  or review attempt and ask an authorized operator to join or cancel it.
  Execute attempts may also be handed off by a workspace admin. Never infer
  that two connections are the same owner from a shared Agent Profile or API
  key.
- Apply the same ownership authorization at every provider-start boundary,
  including assignment dispatch and unbacked-run recovery. A blocked candidate
  run remains parked until the typed conflict request is resolved. Contributor
  and handoff decisions may resume a queued execute run; reviewer preserves or
  converts it to review; a queued review can never escalate to execution.
  Session owners or admins may join/cancel, handoff is admin-only, and cancel
  abandons only that candidate run and never the existing primary connection's
  work. Stale requests offer safe dismissal instead of permanent queue noise.

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
- Refresh from the declared integration branch when the base changed
  materially.
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
- A cohesive patch may carry its version and curated changelog in its primary
  implementation PR only when an operator assigns the release version, release
  owner, and release authority before implementation. Otherwise, or when
  batching multiple changes, use a separate release issue and `RELEASES` PR.
- Never silently resolve a schema or migration conflict by dropping another
  contributor's migration.

## Production

Production builds an exact tag or commit from a dedicated clean checkout. The
development checkout is never a deployment source. A deploy is accepted only
when:

- the target commit is contained in the repository's declared release branch;
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
