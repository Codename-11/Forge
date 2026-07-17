# GitHub Support Integration - Implementation Plan

> Status: **implemented for phases 1-4** - Author: Codex planning session 2026-06-09
> Scope: phases 1-4 of GitHub support. GitHub writeback is explicitly deferred.

## Goal

Implement GitHub App-backed support so Forge can import, link, sync, and act on
GitHub issues and pull requests as first-class external work context.

The implementation should let operators:

- Install the Forge GitHub App and map repositories into workspaces.
- Create Forge issues from GitHub issues.
- Link GitHub issues and PRs to existing Forge issues.
- Keep GitHub issue/PR state visible and synced into Forge.
- Use linked PR state to drive Forge review/done workflows.
- Expose linked GitHub context through `github.*` MCP tools and
  `agent.context.bundle`.

No part of this plan posts comments to GitHub, edits GitHub issues, closes
GitHub issues, applies GitHub labels, or otherwise writes back to GitHub. That
is Phase 5 and remains deferred.

## Goal Prompt

Use this as the Codex goal objective when implementation starts:

```text
Implement GitHub App-backed GitHub support phases 1-4 in /home/bailey/Github-Support per docs/plans/github-support-integration.md: durable external resource/link models, manual GitHub issue/PR link and import, GitHub App repository mappings with inbound webhook sync, PR-aware Forge workflow, and github.* MCP/context support. Defer all GitHub writeback.
```

## Current Fit

Forge already has most of the substrate:

- `ConnectionProvider.GITHUB` and generic account-level `Connection` rows.
- Per-workspace `ConnectionMapping(kind="repo")` for repository targets.
- Issue create/update paths that already handle status defaults, labels,
  agent assignment, auto-watch, auto-dispatch, AI triage, audit, and events.
- `Attachment(kind=LINK)` for visible external URLs.
- `IssueRelation` for Forge-to-Forge dependency links.
- Durable `ActivityEvent` and webhook fan-out through `recordChange()`.
- MCP issue/comment/attachment tools and `agent.context.bundle`.

The missing piece is durable external-resource identity and sync state. A plain
link attachment is useful UI, but it cannot provide idempotent import, webhook
dedupe, repo mapping policy, PR state, or sync history.

## Design Decisions

1. **Native integration, not a plugin.** GitHub support becomes a first-party
   connection surface because it affects issue identity, status workflow, MCP
   context, and dispatch. Plugins can still consume the resulting Forge events.
2. **GitHub App is primary auth.** User OAuth may remain useful for ad hoc
   search/import later, but durable repo sync uses a GitHub App installation.
   Installation access tokens are minted just-in-time from app credentials and
   are not stored.
3. **External resource model is provider-generic.** Name the DB concepts around
   external resources rather than GitHub-only rows, while shipping only the
   GitHub provider in this pass.
4. **Inbound sync mutates Forge; outbound GitHub writeback does not exist.**
   GitHub webhooks can create/update Forge rows according to mapping policy.
   Forge must not call GitHub mutation endpoints in this plan.
5. **Use existing MCP scopes.** `READ_ISSUES` gates read/list/preview. `WRITE_ISSUES`
   gates import/link/sync actions that create or mutate Forge issue context.
   Admin-only installation and mapping controls stay in tRPC/UI, not MCP.
6. **Settings-driven policy.** Per-repo routing, label mapping, queue behavior,
   and status-transition rules live in `ConnectionMapping.config`, not hardcoded
   handlers.

## Non-goals

- Posting Forge comments back to GitHub.
- Closing/reopening GitHub issues from Forge.
- Applying GitHub labels/assignees/milestones from Forge.
- Full GitHub Projects sync.
- Cloning repositories or indexing code.
- Mirroring every GitHub comment by default.
- Treating GitHub users as Forge users beyond best-effort display/mapping.

## Schema

Add a small generic external-resource layer. Suggested names are intentionally
provider-neutral.

### `ExternalResource`

Workspace-scoped snapshot of a provider object such as a GitHub issue or PR.

```prisma
model ExternalResource {
  id                  String   @id @default(cuid())
  workspaceId         String
  provider            String   // "GITHUB" in this plan
  connectionMappingId String?
  resourceType        String   // "ISSUE" | "PULL_REQUEST"
  repoFullName        String   // owner/name
  externalId          String?  // GitHub numeric id as string
  externalNodeId      String?  // GitHub node_id
  number              Int
  url                 String
  apiUrl              String?
  title               String
  state               String   // open | closed | merged | draft | unknown
  authorLogin         String?
  labels              Json?
  assignees           Json?
  metadata            Json?
  externalCreatedAt   DateTime?
  externalUpdatedAt   DateTime?
  lastSyncedAt        DateTime?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, provider, repoFullName, resourceType, number])
  @@index([workspaceId, provider, repoFullName])
  @@index([workspaceId, provider, externalNodeId])
}
```

`metadata` should stay bounded and stable: PR merge state, draft flag, base/head
refs, review decision, check summary, linked GitHub issue numbers, milestone, and
raw webhook timestamps are fine. Do not store full unbounded payloads.

### `ExternalResourceLink`

Join between a Forge issue and an external resource.

```prisma
model ExternalResourceLink {
  id                 String   @id @default(cuid())
  workspaceId        String
  issueId            String
  externalResourceId String
  kind               String   // SOURCE | IMPLEMENTS | FIXES | RELEASES | REVIEWS | RELATES_TO
  createdById        String?
  createdAt          DateTime @default(now())

  workspace        Workspace        @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  issue            Issue            @relation(fields: [issueId], references: [id], onDelete: Cascade)
  externalResource ExternalResource @relation(fields: [externalResourceId], references: [id], onDelete: Cascade)
  createdBy        User?            @relation(fields: [createdById], references: [id], onDelete: SetNull)

  @@unique([issueId, externalResourceId, kind])
  @@index([workspaceId, issueId])
  @@index([workspaceId, externalResourceId])
}
```

Link semantics:

- `SOURCE` - Forge issue was created from this GitHub issue.
- `IMPLEMENTS` - PR is intended to resolve or implement the Forge issue.
- `FIXES` - PR uses explicit fix/close/resolve semantics for the Forge issue.
- `RELEASES` - release assembly PR contains an already-separate implementation.
- `RELATES_TO` - contextual reference without implementation semantics.
- `REVIEWS` - PR/review context requires attention for the Forge issue.
- `RELATES_TO` - soft context link.

### `ExternalWebhookEvent`

Idempotency and replay diagnostics for GitHub webhooks.

```prisma
model ExternalWebhookEvent {
  id                  String   @id @default(cuid())
  workspaceId          String?
  provider             String
  deliveryId           String
  event                String
  action               String?
  repoFullName         String?
  externalResourceId   String?
  status               String   // RECEIVED | PROCESSED | SKIPPED | FAILED
  error                String?  @db.Text
  receivedAt           DateTime @default(now())
  processedAt          DateTime?

  @@unique([provider, deliveryId])
  @@index([workspaceId, status, receivedAt])
  @@index([provider, repoFullName])
}
```

Persist the row before processing after signature validation. Re-deliveries
with the same `X-GitHub-Delivery` return success without applying side effects
again.

### Connection Metadata

Use the existing `Connection` and `ConnectionMapping` tables, with GitHub App
metadata in `config`.

`Connection.config` for a GitHub App installation:

```json
{
  "authKind": "github_app_installation",
  "installationId": 123456,
  "accountLogin": "acme",
  "accountType": "Organization",
  "repositorySelection": "selected",
  "permissions": { "issues": "read", "pull_requests": "read", "contents": "read" },
  "events": ["issues", "pull_request", "issue_comment", "pull_request_review", "check_suite"]
}
```

Do not store installation access tokens. Store app credentials through env or a
future instance-admin credential surface:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_WEBHOOK_SECRET`
- optional `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` if the install
  flow needs OAuth identity association later.

`ConnectionMapping.config` for a mapped repo:

```json
{
  "github": {
    "autoCreateIssues": false,
    "syncTitle": true,
    "syncDescription": false,
    "syncComments": false,
    "defaultProjectId": null,
    "defaultLabelIds": [],
    "labelMap": { "bug": "lbl_..." },
    "defaultPriority": "NONE",
    "queueOnCreate": false,
    "assignedAgentId": null,
    "claimedById": null,
    "statusRules": {
      "issueClosedStatusId": null,
      "issueReopenedStatusId": null,
      "prOpenedStatusId": null,
      "prReadyForReviewStatusId": null,
      "prChangesRequestedStatusId": null,
      "prMergedStatusId": null,
      "checksFailedStatusId": null
    }
  }
}
```

Every status and routing value is optional and workspace-specific. When absent,
the handler updates only the external snapshot and link panel.

## Services

Add provider-specific services under `src/server/services/github/`.

- `app-auth.ts`
  - Build GitHub App JWT.
  - Mint installation access tokens just-in-time.
  - Cache installation tokens until expiration minus a small skew.
- `client.ts`
  - Small REST/GraphQL wrapper.
  - Central timeout, user-agent, rate-limit error shape.
  - Read-only methods only in this plan.
- `url.ts`
  - Parse supported GitHub issue/PR URLs.
  - Normalize repo full name and number.
  - Reject non-GitHub or unsupported paths cleanly.
- `resource-sync.ts`
  - `upsertGitHubIssueResource`
  - `upsertGitHubPullRequestResource`
  - `linkResourceToIssue`
  - `importGitHubIssue`
  - `syncLinkedResource`
- `webhook.ts`
  - Verify `X-Hub-Signature-256`.
  - Deduplicate by `X-GitHub-Delivery`.
  - Resolve installation/repo to active workspace mappings.
  - Route event handlers.
- `mapping-policy.ts`
  - Convert mapping config into Forge create/update inputs.
  - Apply label maps, default labels, default project, queue/assignment.
  - Resolve configured status transitions.

Keep issue creation through a shared server-side helper rather than copying the
router body. If no helper exists yet, extract one from `issue.create` before the
GitHub import path lands, so API, MCP, UI, and ingest share audit/auto-watch/
dispatch behavior.

## API Routes

### GitHub App install

Add routes for installation setup and callback. Exact naming can follow the
connections route style, for example:

- `GET /api/connections/github/install`
- `GET /api/connections/github/setup`

Responsibilities:

- Require a signed-in user.
- Start GitHub App installation.
- On setup callback, create or update a `Connection(provider=GITHUB)` row with
  `config.authKind = "github_app_installation"`.
- Redirect back to `/settings/connections`.

### GitHub webhook receiver

Add:

```text
POST /api/ingest/github
```

Responsibilities:

- Read raw body.
- Verify `X-Hub-Signature-256` with `GITHUB_APP_WEBHOOK_SECRET`.
- Read `X-GitHub-Delivery`, `X-GitHub-Event`, and payload `action`.
- Persist `ExternalWebhookEvent` before side effects.
- Resolve installation id + repo full name to active `ConnectionMapping` rows.
- Process each matched workspace mapping independently.
- Return `2xx` for recognized duplicate deliveries.

This route is the inbound analogue of `/api/ingest/email`, but with idempotency
and provider-specific signature headers.

## tRPC Surface

Add a workspace-scoped `github` router for UI and command surfaces:

- `github.parseUrl({ url })`
- `github.preview({ mappingId?, url })`
- `github.listLinked({ issueId })`
- `github.link({ issueId, url, kind })`
- `github.importIssue({ mappingId, repoFullName, number, projectId?, labelIds?, queue? })`
- `github.sync({ externalResourceId })`
- `github.search({ mappingId, query, type })`

Admin-only:

- `github.listInstallations()`
- `github.listInstallationRepos({ connectionId })`
- `github.testMapping({ mappingId })`

Where a mutation touches an issue, call `recordChange()` in the same
transaction. Use existing event kinds:

- `ISSUE_CREATED` with payload `{ source: "github", externalResourceId, repo, number }`.
- `ISSUE_UPDATED` with payload `{ source: "github", change: "external-resource-linked" | "github-sync", ... }`.
- `COMMENT_CREATED` only when `syncComments` is enabled.

Avoid new `EventKind` values unless the UI genuinely needs a separate event
subscription category.

## MCP Surface

Expose the same core operator/agent actions through `github.*` MCP tools:

| Tool                 | Scope          | Notes                                                         |
| -------------------- | -------------- | ------------------------------------------------------------- |
| `github.parseUrl`    | `READ_ISSUES`  | Normalize a GitHub URL into repo/type/number.                 |
| `github.listLinked`  | `READ_ISSUES`  | Return linked resources for a Forge issue.                    |
| `github.link`        | `WRITE_ISSUES` | Link issue/PR URL to a Forge issue with a relation kind.      |
| `github.importIssue` | `WRITE_ISSUES` | Create or return the Forge issue sourced from a GitHub issue. |
| `github.sync`        | `WRITE_ISSUES` | Refresh one linked resource and apply mapping policy.         |
| `github.search`      | `READ_ISSUES`  | Search mapped repo issues/PRs for linking/import.             |

Add linked GitHub resources to `agent.context.bundle({ issueId })`:

```json
{
  "externalResources": [
    {
      "provider": "GITHUB",
      "type": "PULL_REQUEST",
      "repo": "acme/api",
      "number": 42,
      "title": "Fix queue dispatcher",
      "state": "open",
      "url": "https://github.com/acme/api/pull/42",
      "linkKind": "IMPLEMENTS",
      "metadata": {
        "draft": false,
        "merged": false,
        "reviewDecision": "CHANGES_REQUESTED",
        "checks": { "state": "failure", "failed": 1, "total": 9 }
      },
      "lastSyncedAt": "2026-06-09T00:00:00.000Z"
    }
  ]
}
```

Agents should not scrape GitHub pages when this context exists.

## UI

### Global Settings -> Connections

- Add GitHub App install affordance beside the existing OAuth-style GitHub card.
- Show installation account, repository selection, permission summary, and
  connection health.
- Keep user OAuth language separate from GitHub App installation language.

### Workspace Settings -> Connections

For GitHub repo mappings:

- Pick installation.
- Pick repository.
- Set direction: inbound, outbound, inbound+outbound. For this plan, outbound
  means "Forge displays and can refresh context," not "Forge writes to GitHub."
- Configure defaults: project, labels, priority, queue-on-create, assignee,
  agent assignment.
- Configure status rules for GitHub issue/PR events.
- Toggle `autoCreateIssues`, `syncTitle`, `syncDescription`, `syncComments`.

### Issue Detail

Add a GitHub panel or tab:

- Linked GitHub issues and PRs.
- State chips: open/closed/merged/draft, review decision, check summary.
- Last synced timestamp and manual refresh.
- Link existing GitHub URL.
- Import GitHub issue from mapped repo.
- Open in GitHub.

Also render compact GitHub chips in issue rows where linked PR state materially
matters, especially "PR open", "changes requested", "checks failing", and
"merged".

## Workflows

### Manual Link

1. Operator pastes a GitHub issue or PR URL on a Forge issue.
2. Server parses URL and resolves an active repo mapping.
3. Server fetches the GitHub object read-only.
4. `ExternalResource` is upserted.
5. `ExternalResourceLink` is created with selected kind.
6. A LINK attachment may also be created for visible compatibility, but the
   external-resource link is the canonical row.
7. `recordChange()` emits `ISSUE_UPDATED`.

### Import GitHub Issue

1. Operator selects repo + issue number or URL.
2. Server upserts the GitHub issue resource.
3. If a `SOURCE` link already exists, return the existing Forge issue.
4. Otherwise create a Forge issue using shared issue-create service:
   title from GitHub title, description with source attribution and body,
   defaults from mapping config, labels from label map/default labels.
5. Create `ExternalResourceLink(kind="SOURCE")`.
6. Optionally create visible LINK attachment.
7. Return Forge issue key/id.

### GitHub Issue Webhook Sync

Supported events:

- `issues.opened`
- `issues.edited`
- `issues.labeled` / `issues.unlabeled`
- `issues.assigned` / `issues.unassigned`
- `issues.closed`
- `issues.reopened`

Behavior:

- Always update `ExternalResource` snapshot for active mappings.
- If `autoCreateIssues=true`, `issues.opened` imports a Forge issue.
- If a `SOURCE` link exists, apply configured title/status/label policy.
- If `syncComments=true`, `issue_comment.created` creates a Forge `SYSTEM`
  comment that attributes the GitHub author and links back to the source
  comment. Default is off.

### Pull Request Sync

Supported events:

- `pull_request.opened`
- `pull_request.edited`
- `pull_request.ready_for_review`
- `pull_request.converted_to_draft`
- `pull_request.synchronize`
- `pull_request.closed`
- `pull_request.reopened`
- `pull_request_review.submitted`
- `check_suite.completed` or `check_run.completed`

Behavior:

- Upsert PR as `ExternalResource(resourceType="PULL_REQUEST")`.
- Link PR to a Forge issue when:
  - Operator linked it manually.
  - PR title/body contains a Forge issue key (`ABC-123`).
  - PR references an imported GitHub issue that has a `SOURCE` Forge link.
- Apply configured status rules to linked Forge issues:
  - PR opened/ready -> In Review-style status if configured.
  - changes requested -> configured review-blocked status if configured.
  - checks failed -> configured failing-checks status if configured.
  - merged -> configured done status if configured.
- Never close or mutate the GitHub PR from Forge.

## Security

- Verify GitHub webhook signatures against the raw body.
- Reject unconfigured or inactive mappings.
- Treat repo full names case-insensitively for matching but preserve display
  casing from GitHub.
- Use installation access tokens only for repos granted to that installation.
- Do not expose app private key, webhook secret, installation token, or raw
  token errors to clients.
- Keep webhook processing idempotent by delivery id.
- Cap stored metadata and comments to avoid unbounded payload growth.

## Testing

Unit tests:

- URL parser accepts issue/PR URLs and rejects unsupported paths.
- Mapping policy produces expected create/update inputs.
- Webhook signature verifier accepts valid and rejects invalid signatures.
- External-resource upsert idempotency.
- PR link detection from Forge issue keys.

Router/service tests:

- Manual link creates resource + link + audit event.
- Import creates a Forge issue once and returns existing on repeat.
- Cross-workspace mapping is rejected.
- `github.sync` respects mapping policy and scopes.
- MCP tools enforce `READ_ISSUES` / `WRITE_ISSUES`.
- `agent.context.bundle` includes linked resources.

Webhook integration tests:

- Duplicate `X-GitHub-Delivery` does not duplicate side effects.
- `issues.opened` auto-creates only when mapping config enables it.
- `issues.closed` applies configured status only to linked/imported issues.
- `pull_request.closed` with merged state applies configured done status.
- Failing checks update PR metadata and optional configured status.

Follow the repo rule: no mocks in integration tests. Use fixtures plus the
Postgres/Redis service containers for DB/event behavior. Network calls to
GitHub should be isolated behind service functions and tested with deterministic
fixtures at unit level.

## Phased Execution

### Phase 0 - Shared Issue Create Helper

Extract the core of `issue.create` into a server-side service so GitHub import
can reuse existing semantics:

- default status
- cross-tenant guards
- labels/assignees/agent assignment
- auto-watch
- `recordChange`
- manual dispatch reason
- `maybeAutoDispatch`
- AI triage rules

Acceptance:

- Existing issue create behavior and tests stay green.
- GitHub import can call the helper without duplicating router logic.

### Phase 1 - Durable Models + Manual Link/Import

- Add `ExternalResource`, `ExternalResourceLink`, `ExternalWebhookEvent`.
- Add GitHub URL parser.
- Add read-only GitHub App client skeleton.
- Add `github.link`, `github.importIssue`, `github.listLinked`, `github.sync`.
- Add issue-detail GitHub panel with manual link/import.

Acceptance:

- Pasting a GitHub issue URL can create a Forge issue.
- Pasting a GitHub PR URL can link it to a Forge issue.
- Re-importing the same GitHub issue returns the existing Forge issue.
- Linked resources render on issue detail and in MCP context.

### Phase 2 - GitHub App Installation + Repo Mapping

- Add GitHub App install/setup routes.
- Store installation metadata as a GitHub `Connection`.
- Extend workspace repo mapping UI for GitHub config.
- Add repo listing/test connection actions.
- Add app auth token minting.

Acceptance:

- A workspace admin can map an installed GitHub repo to a workspace.
- Mapping config is persisted and admin-gated.
- Installation tokens are minted just-in-time and not stored.

### Phase 3 - Inbound Webhook Sync

- Add `/api/ingest/github`.
- Verify signature and delivery id.
- Resolve installation/repo to active mappings.
- Process `issues` and optional `issue_comment` events.
- Apply import/update/status policy through shared services.

Acceptance:

- GitHub issue opened can auto-create a Forge issue when enabled.
- GitHub issue updates refresh external snapshot.
- GitHub issue closed/reopened can move linked Forge issues only when status
  rules are configured.
- Duplicate deliveries are idempotent.

### Phase 4 - PR-aware Workflow + MCP Completion

- Process pull request, review, and check events.
- Detect Forge issue keys in PR title/body.
- Link PRs to imported GitHub issues when GitHub references are available.
- Surface PR review/check state on issue detail and MCP context.
- Add `github.search`.
- Document `github.*` MCP tools.

Acceptance:

- Linked PR state is visible on Forge issues.
- PR merged can move linked Forge issue to configured Done status.
- Changes requested/check failure can move linked Forge issue to configured
  review-blocked/failing status.
- Agents receive linked GitHub resources in `agent.context.bundle`.
- No GitHub mutation endpoints are called.

## Deferred Phase 5 - GitHub Writeback

Only after phases 1-4 are stable, consider explicit opt-in writeback:

- Post Forge link/comment to GitHub.
- Mirror selected Forge comments.
- Apply GitHub labels.
- Close/reopen GitHub issues.

This future work needs separate config, audit language, loop-prevention
markers, and clear operator confirmation. It is not part of this plan.

## Open Questions Before Implementation

- Should GitHub App credentials be env-only for the first pass, or should
  instance admin get an encrypted credential UI immediately?
- Should GitHub App installation `Connection` rows be owned by the installing
  user, or should `Connection.ownerId` become nullable for app installations in
  a later schema cleanup?
- Should `syncComments` stay off-only in v1, with no UI toggle until the
  SYSTEM comment rendering is validated against real support threads?
- Which default status rules should the setup wizard suggest, if any, without
  hardcoding workflow assumptions?

## Shipping Checklist

Before shipping:

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm test:e2e` if UI flows changed enough to warrant browser coverage
5. Update `docs/reference/mcp.md`, `docs/guide/connections.md`, and
   `docs/reference/events.md` as surfaces land
6. Append `DEVLOG.md`
7. Commit
