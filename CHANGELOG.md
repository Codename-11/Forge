# Changelog

All notable changes to Forge are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and dates use
ISO-8601.

The dashboard's **What's New** rail reads this file at request time
(cached by mtime in process memory) and surfaces the most recent
entries. Keep entries terse — one line per item under each version
date, grouped by `Added` / `Changed` / `Fixed` / `Removed`.

## [2026-07-22] — v0.29.5 · Truthful agent handoff

### Changed

- **Waiting work creates a real operator decision.** A blocking run opens one deduplicated Action Request, keeps its human-readable waiting reason stable, and resolves the request automatically when work resumes or terminates.
- **Long live progress remains compact and inspectable.** Workstream traces show bounded progress summaries collapsed by default with an explicit control to reveal the full recorded detail.

### Fixed

- **Managed runtimes can complete through their MCP transport without changing execution identity.** A one-run capability correlates the dispatched runtime with its completion report while shared agent credentials remain insufficient proof.
- **GitHub webhooks preserve explicit delivery meaning.** Generic relation inference can no longer downgrade native `IMPLEMENTS`, `FIXES`, `RELEASES`, `REVIEWS`, or `SOURCE` links.

## [2026-07-20] — v0.29.4 · Balanced operator workspace

### Changed

- **Wide dashboards keep useful work in both rails.** Workspace flow begins directly beneath Focus instead of waiting for a taller Live operations stack, while narrow layouts retain their intentional reading order.
- **Attention queues stay compact without hiding decisions.** Every populated Command Center group previews two items and offers an accessible Show more / Show fewer control instead of mixing unbounded content with clipped nested scrolling.

### Fixed

- **Run recovery remains visibly actionable beside large ask queues.** Independent overflow controls prevent Asks from stretching the shared row or leaving neighboring recovery cards cut off.

## [2026-07-20] — v0.29.3 · Honest delivery provenance

### Changed

- **Workstream cards report recorded execution facts.** Agent Profile configuration, MCP or webhook transport, managed runtime execution, run state, and delivery-session state remain separate instead of inheriting a configured runtime onto direct MCP work.
- **Connection presence describes reachability, not work in progress.** Delivery badges say MCP connected, runtime reachable, or connection online and explain that presence never substitutes for an active AgentRun.

### Fixed

- **Explicit MCP execution advances issue lifecycle.** Opening an `EXECUTE` run applies the workspace's configured In Progress status, and successful completion applies In Review, with tenant-scoped audit and activity evidence for each server-side transition.
- **New workspaces receive complete lifecycle targets.** In Progress, In Review, and Done statuses are selected when a workspace is created, while non-execution modes remain status-neutral and Ready to Close continues to ignore transport presence.

## [2026-07-20] — v0.29.2 · Reliable runtime handoff

### Changed

- **Connection identity stays compatible across upgrades.** Historical runtime and webhook keys are normalized atomically while retaining immutable aliases, and delivery actions treat connection ids as opaque identifiers instead of assuming one storage format.

### Fixed

- **A blocked runtime cannot stall the global dispatch sweep.** Delivery conflicts park only the competing candidate and remain fail-closed even if their operator decision cannot be materialized, so unrelated agent work continues normally.
- **Victor mentions can reach an actionable ownership decision.** Legacy managed-runtime keys no longer invalidate typed delivery-conflict requests before the operator can join, hand off, review, or cancel the candidate run.

## [2026-07-19] — v0.29.1 · Reliable attention recovery

### Changed

- **Every open decision remains independently actionable.** Command Center no longer hides additional same-issue requests behind a combined count, and legacy requests without a reply target provide safe dismissal and issue navigation.

### Fixed

- **Finished delivery collisions leave the attention queue.** Typed and historical conflict requests reconcile after their blocked candidate becomes terminal or the Delivery session ends, while quiet MCP ownership remains protected until the exact connection resumes or an explicit lifecycle transition releases it.

## [2026-07-18] — v0.29.0 · Actionable attention decisions

### Added

- **Attention Queue decisions are typed and outcome-aware.** Cards derive valid actions, permissions, explanations, and readable evidence from current server state, with safe issue-navigation fallbacks when a request has no actionable protocol.
- **Delivery collisions pause for an explicit ownership decision.** Managed runtime attempts can join the active session, transfer primary ownership with admin authority, or cancel only the blocked candidate without disturbing existing MCP or runtime work.

### Fixed

- **Review dispatches cannot escalate into write-capable execution.** Attempted engagement mode, session authority, tenant scope, and run freshness are revalidated atomically before any blocked delivery continues.
- **Stale ownership asks leave the queue cleanly.** Obsolete conflict requests offer safe dismissal instead of permanent disabled actions, while issue detail routes typed decisions to Command Center rather than presenting a misleading generic Accept.

## [2026-07-17] — v0.28.1 · Reliable lifecycle reconciliation

### Changed

- **MCP activity no longer masquerades as runtime execution.** Direct MCP comments update an explicitly opened run without fabricating one, while silent MCP connections become quiet and recoverable instead of being reported as failed managed runtimes.

### Fixed

- **GitHub completion checks settle from executable evidence.** Empty GitHub App check suites no longer hold completed pull requests in verification, while real, unknown, pending, and failed checks remain fail-closed.
- **Historical comment-only MCP runs reconcile without duplicate output.** Narrowly identified post-merge metadata runs close safely, while any run carrying execution evidence is preserved for normal stale-run handling.

## [2026-07-17] — v0.28.0 · Faster local delivery

### Added

- **Workspace invitations are secure and lifecycle-aware.** Administrators can issue, revoke, resend, and accept expiring email invitations with tenant-safe membership and concurrency controls.
- **Local development is fast, deterministic, and production-safe.** One command starts host-native Turbo HMR against local containerized services, while explicit refresh, reset, and scalable scenario commands provide reproducible test data without persisting production credentials.

### Changed

- **Issue search uses one consistent semantic model.** Issue lists, command search, and MCP recognize exact keys, bare numbers, titles, descriptions, projects, labels, people, and agents while preserving tenant and API-key scope.
- **Issue pages load less work up front.** Secondary surfaces hydrate on demand, realtime invalidation targets relevant caches, and successful tRPC logging stays quiet by default without losing live updates.

### Fixed

- **Lazy workspace controls retain the first interaction.** Quick Create and other deferred surfaces consume early requests reliably instead of requiring a second click during hydration.

## [2026-07-16] — v0.27.1 · Truthful delivery evidence

### Changed

- **Delivery identity separates the agent from its operator.** Compact and expanded cards distinguish execution identity, invocation, connector, runtime, and human ownership while explaining connection confidence on hover or keyboard focus.
- **Issue evidence and activity stay compact without hiding history.** Delivery and GitHub disclosures share a clear interaction pattern, repeated adjacent activity is grouped, and operators can expand capped history on demand.

### Fixed

- **GitHub and completion state remain internally consistent.** Native implementation, closing, related, and release-containment relations render distinctly; merged pull requests no longer retain pending or unknown merge metadata.
- **Compact GitHub references link as one unit.** Shared Markdown surfaces recognize `owner/repository#number` before Forge issue keys instead of splitting hyphenated owners at the slash.

## [2026-07-16] — v0.27.0 · Personal work and canonical delivery

### Added

- **Personal workspaces get a calm Today-first experience.** Personal profiles provide focused task capture, notes, routines, an optional agent companion, and profile-aware navigation without fragmenting Forge's underlying tenant and agent model.
- **Agent execution connections are explicit and durable.** Managed runtime, MCP, webhook, and on-demand work now carries connection provenance, participant roles, delivery ownership, and transport-aware evidence across Agent Profile, Delivery, Command Center, and policy surfaces.

### Changed

- **Activity distinguishes people, agents, workers, automation, and connectors.** Issue updates now present meaningful action or field summaries when their payload contains evidence instead of an opaque generic update row.
- **MCP lifecycle confidence is transport-aware.** Quiet MCP clients create recoverable operator attention without being misrepresented as failed runtime heartbeats, and active legacy sessions can safely adopt their authenticated connection identity.

### Fixed

- **Personal profile changes take effect immediately.** Workspace navigation and dashboard context refresh after a Team ↔ Personal change, while Notes no longer advertises the reserved `G N` shortcut.
- **Delivery ownership remains coherent during recovery.** Primary connections cannot be demoted by joining, and resumed MCP work clears its obsolete quiet-recovery requests.

## [2026-07-16] — v0.26.1 · Reliable native chat startup

### Fixed

- **Native Hermes conversations initialize before durable delivery.** Forge now prepares the exact base and optional canvas-aware instructions before atomically writing the user message and Sessions outbox row, preventing a production-bundle initialization failure on the first interactive send.
- **Dispatch-only chat stays lightweight.** Local and daemon-backed agents skip Forge prompt and canvas-summary preparation because their runtime owns that context.

## [2026-07-16] — v0.26.0 · Artifact Studio and trustworthy completion

### Added

- **Artifact Studio ships collaborative, shareable deliverables.** Teams can create and revise rich artifacts, manage revisions and previews, attach source assets, publish token-scoped read-only shares, and govern workspace defaults and API-key access.
- **Completion recommendations expose structured verification state.** Operators can inspect ready, blocked, verifying, unavailable, and stale evidence with per-fact status, observation and retry times, diagnostics, and source links.
- **Authorized operators can deliberately override incomplete verification.** A destructive **Mark done anyway** path lists unresolved reasons and records the structured assessment plus override decision in the issue audit trail.

### Changed

- **Completion evidence refreshes when its sources change.** GitHub webhooks, a deduplicated reconciliation job, scheduled sweeps, card visibility, window focus, and a manual action rebuild recommendations from current trusted evidence; realtime invalidation keeps mounted cards synchronized.
- **Automatic completion remains fail-closed.** Only a current `READY` assessment may complete automatically, while stale or unavailable evidence requires explicit operator judgment.

### Fixed

- **Webhook retry draining uses BullMQ-safe dedupe keys.** Stable per-attempt job IDs no longer contain BullMQ's reserved colon delimiter, restoring automatic queueing while durable delivery rows remain authoritative in Postgres.

## [2026-07-16] — v0.25.0 · Native Hermes conversations

### Added

- **Hermes chat uses native, resumable Sessions.** Interactive conversations negotiate explicit connector capabilities, preserve one durable tenant-scoped mapping per Forge thread, and support ordered streaming, proactive agent messages, tool events, attachments, approval signals, reconnect, and replay without changing the `/v1/runs` background execution path.
- **Connector operations are inspectable and recoverable.** Chat diagnostics expose safe session identifiers, negotiated features, delivery state, retries, and errors alongside classification filters and an explicit reconnect control.
- **Hermes can install Forge as a platform plugin.** The distributable adapter provides an ordered SQLite outbox, idempotent proactive delivery, capability negotiation, and a conservative legacy fallback.

### Changed

- **Memory and delivery identity are isolated by tenant and actor.** Versioned opaque keys include runtime, workspace, operator, agent, thread, and reset-generation identity; durable connector ledgers enforce workspace ownership, sequence, and idempotency boundaries.
- **Delivery recovery is settings-driven.** Workspace retry, backoff, dead-letter, webhook, and processing-lease controls govern replay across stream, webhook, poll, and worker boundaries.

### Fixed

- **Interrupted interactive turns no longer strand or duplicate replies.** Expired processing leases are atomically reclaimed, Hermes readiness fails closed until Sessions streaming is probed, and final plugin events retain their original idempotency key across retry.
- **Chat drafts remain attached to the route-selected thread during hydration.** Clear-and-resend flows no longer race the initial client query.
- **The local release gate starts from isolated disposable state.** `pnpm ci:local` now matches GitHub CI's serial file execution, acquires shared browser-server ownership, waits for stale listener teardown, disables server reuse, refuses to inherit the developer database, and recreates only the explicitly named `forge_e2e` database.

## [2026-07-15] — v0.24.0 · Actionable Mission Control

### Added

- **Global attention uses one shared notification lifecycle.** The Mission Control bell combines persisted alerts and unread assignments in a responsive drawer with recent activity, operational context, and one mark-all-read action.
- **Cross-workspace Inbox and Activity are inspectable in place.** Operators can review issue metadata, agent and run state, comments, event meaning, grouped updates, and canonical source links before leaving Mission Control.

### Changed

- **Run capacity reflects concurrent execution slots.** Mission Control reports active runs against configured finite capacity and names unlimited-capacity agents explicitly.
- **Activity emphasizes meaningful changes.** Human-readable timeline interpretation and subject grouping keep repeated watchdog and action-request refreshes from overwhelming the feed.

### Fixed

- **Mission Control agent pages remain fully reachable.** Fleet and profile surfaces establish the correct nested scroll contract at constrained desktop viewports.
- **Global navigation controls behave as advertised.** The notification bell and keyboard-help button open useful surfaces, the Activity shortcut no longer resembles a stuck unread count, and semantic breadcrumbs navigate to parent pages while marking the current page correctly.

## [2026-07-15] — v0.23.0 · Mission Control agent fleet

### Added

- **Mission Control now manages the full agent fleet.** Define identities, choose execution runtimes, inspect MCP client readiness and recent work, and bind or unbind workspaces from one global control plane.

### Changed

- **Workspace agent settings are policy-only.** Capacity, capability overrides, routing eligibility, engagement, and approval stay scoped to the workspace while profile and binding lifecycle moves to Mission Control.
- **Instance Administration is governance-only.** Approvals, instance sharing, and force-disable remain at instance scope; authorized administrators manage and safely remove profiles through Mission Control.
- **Legacy Agent Studio links remain valid.** Former profile routes redirect to the new fleet surface, with explicit global, workspace, and instance scope labels.

### Fixed

- **Agent management actions match workspace authority.** Bind, unbind, and MCP client creation are shown and enforced only for workspace owners and administrators, with durable audit events and preserved history.

## [2026-07-15] — v0.22.0 · Connected agent delivery

### Added

- **Agent Studio makes identity, execution, and access readiness explicit.** Each profile owns one primary execution runtime, aggregates every workspace binding and linked MCP client, and deep-links into client creation with the correct binding selected.
- **PR delivery can require a durable issue handoff.** Workspace policy can recommend, require, or automatically publish one concise implementation, pull-request, and validation update when an MCP work session attaches its native PR.

### Changed

- **Workspace agent configuration is policy-only and progressive.** Binding rows open compactly and reveal capacity, routing, engagement, approval, and capability overrides only when an operator chooses Configure.
- **Agent credentials have one lifecycle surface.** Agent access now owns MCP clients, scopes, provider setup, rotation, revocation, personal tokens, and session keys; the duplicate client inventory redirects there.
- **Profile edits stay coherent across workspaces.** Identity and execution changes synchronize to active bindings while workspace-local policy remains untouched; Instance Administration stays governance and Mission Control stays read-only operations.

## [2026-07-15] — v0.21.0 · Clear project and issue scope

### Added

- **Issue lists and boards share one visible lifecycle scope.** Open and All apply consistently across global and project views, remain encoded in the URL, and offer a direct recovery path when completed work matches a search.
- **Project creation explains its durable choices.** Required fields, immutable issue-key behavior, accessible color selection, inline validation recovery, and direct navigation to the created project make setup predictable.

### Changed

- **Issue filtering exposes only meaningful controls.** Redundant Done filtering and empty saved-view chrome are removed, updated-time filtering is distinguished from sorting, and active searches can be cleared directly.
- **Project progress is readable and accessible.** Cards show completed and total issue counts alongside semantic progress indicators.

## [2026-07-15] — v0.20.1 · Clean-checkout deployment

### Fixed

- **Worker images now build from the dedicated clean deployment clone.** The Dockerfile no longer requires Next's generated, gitignored `next-env.d.ts` for the `tsx` worker stage, removing a hidden dependency on development-checkout residue.

## [2026-07-15] — v0.20.0 · Coordinated code delivery

### Added

- **Issues now coordinate one active code work session across Forge, Codex Desktop, and contributors.** The Delivery card records the owner, repository, branch, base, isolated worktree, heartbeat, native implementation PR, and separate merge, release, deployment, and live-verification milestones.
- **Active delivery work remains visible after navigation.** A dashboard card shows current branches, owners, PR state, stale work, and the next delivery stage; workspace admins can tune the stale lease threshold.
- **Agents receive a code-work contract and MCP tools.** EXECUTE runs check and claim shared ownership before editing, heartbeat meaningful phases, and attach native GitHub implementation PRs instead of generic links.
- **Production deployment has a serialized exact-ref path.** A guarded script requires a clean dedicated clone, verifies the target belongs to `origin/main`, locks concurrent releases, stamps the build SHA, and smoke-tests the live sign-in route.

### Changed

- **GitHub remains authoritative for PR delivery facts.** Review, checks, mergeability, branch head, and merge state advance the Forge delivery session without creating a parallel PR status model.
- **Stale work is actionable instead of silently released.** Quiet sessions retain their ownership lease and create one shared action request until the owner resumes or an operator abandons the session.
- **Parallel contributors use timestamped Prisma migration names.** Repository, agent-context, release, docs-site, production compose, and Obsidian policies now share the same worktree and delivery rules.

## [2026-07-15] — v0.19.1 · Refreshable GitHub sync health

### Added

- **GitHub sync status can be refreshed without changing credentials.** Workspace settings now recheck the webhook URL, required events, App permissions, and permissions accepted by the installation, with a visible last-checked time and an automatic silent check after returning from GitHub.

### Changed

- **Webhook rotation is a separate security action.** The settings card distinguishes read-only status refresh from explicit secret rotation and reports pending installation approval independently from App registration readiness.

### Fixed

- **Accepted GitHub permission changes clear stale warnings.** A successful end-to-end refresh persists the ready state immediately, while incomplete installation approval remains actionable instead of being mistaken for a healthy App.

## [2026-07-15] — v0.19.0 · Unified GitHub realtime sync

### Added

- **Workspace GitHub Apps now own realtime state detection.** Forge stores per-App webhook secrets encrypted, rotates them with crash-safe grace credentials, and shows whether each App is providing realtime sync or polling only.
- **Legacy GitHub attachments have a bounded migration path.** An explicit maintenance command resolves old issue/PR URLs through the provider sequentially, creates native relations, and removes generic cards only after success.

### Changed

- **One GitHub App handles sync and runtime access.** Newly created Apps request the issue, pull-request, review, check, and status events required for native state detection while continuing to mint short-lived runtime credentials.

### Fixed

- **Webhook delivery no longer depends on missing instance secrets.** Signatures resolve from the payload installation's workspace App with the former environment credential retained only as a compatibility fallback.

## [2026-07-15] — v0.18.0 · Reliable GitHub state detection

### Added

- **Pull-request review state is aggregated from GitHub.** Forge records the latest decisive review per reviewer together with outstanding reviewer and team requests, without copying PR discussion into issue comments.
- **Legacy GitHub link attachments recover into native relations.** A bounded worker repair promotes old issue/PR links when their native resource already exists, restoring normal state sync without provider calls.

### Fixed

- **Webhook delivery is retryable and ordered.** Failed or abandoned deliveries use atomic processing leases, concurrent and out-of-order updates cannot regress newer PR state, and repository mappings must match both the requested repo and installation.
- **Checks and commit statuses invalidate immediately.** Queued/rerun checks, SHA-only check events, and legacy `status` webhooks mark aggregate evidence dirty; provider refresh remains the only source trusted for safe automatic completion.
- **Linked GitHub changes reach live issue views.** Meaningful checks, review, draft, mergeability, head-SHA, title, and lifecycle changes publish issue-scoped activity while duplicate links and mirrored GitHub issue comments remain idempotent.
- **Native GitHub installation cannot borrow a runtime-auth app.** Issue/PR sync now requires the configured instance GitHub App with the documented read permissions and active webhook events.

## [2026-07-15] — v0.17.0 · Clear configuration ownership

### Added

- **Every settings shell now names its scope.** Personal settings, the active workspace, and Instance Administration have distinct navigation and overview surfaces, with a complete configuration inventory and migration plan captured alongside the release.
- **Workspace dispatch defaults are editable where they are explained.** Automatic dispatch and fall-through mode persist from Dispatch & routing and show the effective manual value when automation is off.

### Changed

- **Instance identity configuration lives with instance ownership.** Identity & sign-in moved into Instance Administration while its former account URL redirects safely, and workspace API access and developer clients now use canonical workspace routes.
- **Mission Control remains an operations surface.** The workspace overlay is named Activity, its preferences behave as an accessible dialog, and durable settings continue to live at their authoritative scope.

### Fixed

- **Settings remain usable at phone widths.** Navigation collapses behind a Browse control, current-page and search semantics are explicit, and runtime telemetry no longer crowds half-width cards.

## [2026-07-14] — v0.16.0 · Scannable issue discussions

### Added

- **Busy issue discussions now open on recent context.** Forge loads the latest 15 comments first, shows the full count, and fetches earlier history on demand without moving the reader's place.
- **Replies and specific comments are directly reachable.** A Reply action focuses the composer, timestamps provide durable links, and older deep links automatically load the history they need.

### Changed

- **Long rich comments start at a clean, readable height.** Markdown, images, and tool-rich bodies expand with explicit Show more / Show less controls while the issue page retains one predictable scroll region on desktop and mobile.
- **Issue metadata refreshes no longer carry the full discussion.** Comments use an independent tenant-scoped cursor cache that updates for realtime creates and edits.

## [2026-07-14] — v0.15.1 · Manual GitHub retry safety

### Fixed

- **Manual GitHub refresh failures now honor provider retry timing.** Rate limits, permission failures, and timeouts persist the real diagnostic and mapping-wide retry circuit instead of falling back to a short collision lease.
- **Release builds exclude every generated Next output directory.** Lifecycle and other named `.next-*` caches no longer inflate Docker contexts or exhaust builder storage.

## [2026-07-14] — v0.15.0 · Reliable GitHub status recovery

### Added

- **Linked implementation PRs now self-heal after missed GitHub webhooks.** A settings-driven stale-only worker refreshes PR lifecycle and aggregate checks with bounded batches, restart-safe leases, provider-aware rate-limit backoff, and visible retry diagnostics.

### Fixed

- **GitHub status recovery cannot certify stale or partial evidence.** New PR heads invalidate cached checks, late check events for older heads are ignored, partial GitHub App permissions remain non-blocking, and merged PRs without confirmed checks back off instead of polling hot or closing issues.
- **Check webhooks are refresh hints, not repository-wide success.** Forge now paginates every check suite, combines legacy commit status, distrusts incomplete or malformed aggregates, and only completion evidence read directly from GitHub can close work.
- **Provider failures cannot monopolize maintenance.** Configurable request timeouts, sweep budgets, manual-refresh cooldowns, dormant closed-PR rechecks, atomic leases, and mapping-wide backoff contain timeouts, permission failures, and rate limits while allowing other workspaces to continue.

## [2026-07-14] — v0.14.0 · Proactive completion handoff

### Added

- **Verified work can now become one actionable close-out decision.** EXECUTE agents can explicitly recommend issue completion, while merged implementation PRs and completed GitHub checks feed the same idempotent evidence card in issue detail, Command Center, Dashboard, Inbox, and notifications.
- **Completion behavior is policy-driven.** Workspaces can disable, recommend, or safely automate completion against a chosen DONE status, and projects can inherit or override that policy.

### Changed

- **Automatic completion is guarded centrally.** Live runs, pending review gates, unresolved decisions, blocking issues, unmerged implementation PRs, and unconfirmed checks hold automation and remain visible as evidence instead of silently closing work.
- **Closed, unmerged PRs produce a recovery decision.** Review-stage work can return to the configured active status or link a replacement PR from the native GitHub panel.

### Fixed

- **Repeated lifecycle signals no longer stack cards or notifications.** Producer-owned dedupe keys refresh one durable request, identical refreshes are no-ops, and a periodic reconciler repairs missed transitions and completes newly-unblocked safe candidates.

## [2026-07-14] — v0.13.1 · Reliable agent wake boundaries

### Changed

- **Activity and notifications no longer imply agent work.** Labels, ordinary status changes, non-escalating priority changes, stall and SLA markers, coach output, and other system activity remain visible without invoking an LLM.
- **Waiting agents resume through an explicit, engine-aware boundary.** Actionable human replies, direct mentions, explicit restarts, reassignment, and true priority escalation can wake work; RUNS agents receive a fresh provider turn while webhook and completions agents reactivate directly.

### Fixed

- **Agent output cannot wake its author.** Terminal and stalled replies, blocking markers, and automated comments no longer create replacement runs, while nudges produce one delivery instead of two.
- **Every terminal run leaves exactly one durable issue reply.** Completion, stall, and abandonment comments are claimed atomically so concurrent pollers cannot duplicate them.

## [2026-07-14] — v0.13.0 · Reliable lifecycle operations

### Added

- **A deterministic Lifecycle Lab now covers the operator journey end to end.** Eight isolated, frozen states exercise ready, assigned, active, waiting, approval, review, completed, and stalled work without touching shared development or production data.

### Changed

- **Requests for operator input now stay visible across the product.** Action requests and conversational agent questions share one deduplicated “Needs your input” stream in Inbox and the notification drawer, with matching unread badge behavior and less empty-section scrolling.
- **Command Center carries four attention lanes cleanly at wide widths.** Asks, runtime approvals, stalled runs, and review gates remain visible together, while issue breadcrumbs, notification landmarks, headings, and mention autocomplete use clearer accessibility semantics.

### Fixed

- **AI triage no longer asks Hermes to execute an unknown `submit_triage` tool.** Hermes receives a compatible structured response contract, provider credentials resolve consistently, stale triage claims can be retried safely, and accepted suggestions follow Forge’s normal label, assignment, dispatch, audit, and wake lifecycle.

## [2026-07-14] — v0.12.0 · Calmer issue operations

### Added

- **Every successful agent run now leaves one durable issue reply.** Terminal outcomes are visible in the issue conversation across all engagement modes, while late provider trace events can no longer resurrect completed work as Thinking.
- **Operational alerts now share one lifecycle.** Command Center and the notification drawer reconcile durable active and resolved state, with accessible notification focus behavior and clearer incident grouping, counts, recovery actions, and error feedback.

### Changed

- **Issue detail keeps context visible without forcing a full sidebar.** The page has one predictable scroll owner, Activity is the default rail view, dense cards start clean and expand for full content, and patient user waits no longer generate repeated stall replies.
- **GitHub URLs use Forge's native resource relation.** GitHub issues and pull requests submitted through generic link paths retain checks, sync, and PR state instead of becoming opaque attachments.

### Fixed

- **Historical pins can be removed and reordered again.** Migration-era `pin_<md5>` rows and modern CUID rows are both accepted, and each compact navbar pin now has a direct unpin action.

## [2026-07-13] — v0.11.0 · Live agent operations

### Added

- **Issue work now has one live Workstream.** Agent identity, presence, engagement mode, runtime, effective tool policy, current semantic status, elapsed and last-signal timing, approvals, recovery controls, and an expandable event trace now live together directly beneath the issue context.
- **Realtime reconnects recover durable activity.** The existing SSE transport now replays missed activity and granular run events from a persisted per-workspace cursor, reports connecting/live/reconnecting/offline health, and reconciles bounded overflow without requiring a manual refresh.
- **Agent progress expectations are workspace-configurable.** Admins can set the cadence for concise operator-facing checkpoints and the early Quiet threshold independently from the canonical STALLED watchdog.

### Changed

- **Mission Control now reads like an operations console at both scopes.** The global overview leads with runtime readiness, dispatch posture, queue pressure, assigned attention, capacity, coverage, and activity; the workspace dock expands into a responsive Operations Shelf with Live, Queue, Agents, and Chat while keeping content and mobile navigation unobstructed.
- **Agent comments separate semantic progress from mechanical trace.** Active rolling STATUS updates stay in Workstream instead of jumping through the conversation, while terminal summaries remain in history. The versioned run contract asks agents for concise phase/result checkpoints without exposing chain-of-thought or raw tool logs.
- **Quiet is no longer mislabeled as Stalled.** An ACTIVE run with no recent signal is shown as Quiet and remains recoverable; only the persisted terminal run state is called STALLED.

### Fixed

- **Queue and live-state indicators now reflect durable truth.** Mission Control distinguishes total from unassigned queue pressure, uses canonical workspace issue keys, exposes loading/empty/error/retry states, and publishes granular run events with their persisted row identity and timestamp.

## [2026-07-13] — v0.10.3 · Durable chat runtime lifecycle

### Changed

- **Chat now communicates the whole agent lifecycle instead of collapsing everything into a spinner.** Accepted, thinking, tool work, approval, responding, finalizing, stopped, failed, and stalled phases remain truthful across streaming, reloads, reconnects, and deferred runtime replies. Streaming is batched for smoother rendering, scrolling stays under operator control, and token/cost usage is visible when the runtime reports it.
- **Victor and Mizu now use profile-specific Hermes runtimes.** Each agent is bound to its own authenticated gateway and profile contract, preventing a shared endpoint from accepting work for the wrong agent.

### Fixed

- **Replies no longer attach to the wrong user turn.** Direct streams, deferred dispatch, and MCP drafts persist exact reply correlation, durable partial output, tool approvals, and terminal checkpoints so concurrent messages and reconnects converge on the right conversation state.
- **Stopping, retrying, clearing, and attachment-only sends are reliable.** Stops and draft finalization are idempotent, intentional cancellation is not presented as failure, failed preparation can be retried safely, attachment retries do not orphan files, and `/clear` removes the completed local stream state immediately.
- **Hermes run data is ingested without losing lifecycle detail.** CRLF-framed events, stable tool-call IDs, usage records, profile identity, provider cancellation, expired runs, and approval races now map into Forge's canonical runtime state accurately.

## [2026-07-13] — v0.10.2 · Expired approval recovery

### Changed

- **Approving an expired runtime session now recovers the work.** If a provider has swept or lost the run behind a permission card, Forge truthfully marks the orphan stalled and immediately starts a fresh run with the same agent and engagement mode. The operator is told that the old approval was not applied and may be requested again.

### Fixed

- **Runtime approval cards can no longer become immortal.** The run worker now continues polling provider-backed WAITING runs, distinguishes a missing provider run from successful completion, clears expired approval state, and surfaces the failed attempt on the issue and Command Center recovery queue.

## [2026-07-13] — v0.10.1 · Human-action visibility

### Changed

- **Runtime permission pauses are now first-class decisions.** Command Center surfaces them in its priority queue with the requested command and inline approve/reject controls, counts them in the Decisions badge, and no longer mislabels a patient approval wait as a stale run that should be abandoned.

### Fixed

- **Human-action stalls no longer disappear when an issue is unassigned.** Issue detail resolves the real active or waiting run independently of current assignment, prioritizes permission and waiting states, and shows the same actionable permission card in the main issue flow and persistent agent rail.
- **Approval state now refreshes every related surface reliably.** Connector approval capture and resolution write a deduplicated run event plus an audited activity event carrying the issue context, so Mission Control, Command Center, and issue detail converge over realtime updates. Open issue-bound asks created outside comments are also visible on the issue.

## [2026-07-13] — v0.10.0 · Rich issue rendering & delivery-safe goals

### Added

- **Issue descriptions, comments, and Focus now render rich content consistently.** Direct images and browser-playable videos get bounded previews; supported YouTube, GitHub, Loom, and Figma links get controlled provider cards; every preview can be collapsed, hidden, restored, or opened directly with accessible controls and safe fallbacks.
- **Plan steps now have an obvious issue-like conversation path.** Each step exposes Comment and Ask @agent actions, with the same mention autocomplete used in issue threads. Mentioning an agent wakes canonical issue-backed work with the Goal, Plan, Step, dependency, and operator-comment context.

### Changed

- **Finished execution no longer certifies its own delivery.** When every required step passes, the Plan becomes Completed but the Goal remains Active in outcome review. A signed-in operator must record a delivered-outcome summary and at least one PR, commit, deployment, test, artifact, or other reference before accepting the Goal as Achieved.

### Fixed

- **Rich-rendering work stranded in an isolated runtime clone is now part of the real release history.** The six reviewed commits were recovered onto current `main`, preserving Forge's newer URL-safety policy, and the delivery lane now has an explicit reopen path for prematurely accepted Goals.

## [2026-07-13] — v0.9.0 · Context-aware plans & issue archive

### Added

- **Plan-created issues now explain the work around them.** Issue detail shows the source Goal, Plan, step instructions, completion contract, dependencies, dependents, and sibling progress. Agents receive the same bounded context as an immutable run snapshot, so later plan edits cannot rewrite what an in-flight or historical run was told.
- **Issues can be archived and restored cleanly.** The Issues page has an archived-only view with individual and bulk restore. Archive removes work from active views, clears queue and claim state, closes live agent work, and safely synchronizes an unambiguous materialized plan step while preserving history and relationships.

### Changed

- **Plan execution now enforces its declared constraints.** Crew concurrency is capped across all of a crew's active plans; dependencies and cross-workspace references are validated; role assignment never guesses between ambiguous crew members; and materialized Issue/ExecutionStep terminal state stays synchronized in both directions.
- **Issue capture and bulk handling are more predictable.** Board and status-group quick-create preserve their originating status, command-palette creation stays in issue mode, MCP creation accepts status and labels within narrowed-key lanes, counts refresh with mutations, and bulk selection accurately says “Select loaded.”

### Fixed

- **Archived work can no longer leak back into agent or editing surfaces.** MCP issue/context tools, agent inboxes, comments, labels, relations, assignment, queueing, slash commands, and bulk status changes now respect the archive boundary. Comment deletion is tenant-scoped and label assignment rejects foreign-workspace labels.

## [2026-07-11] — v0.8.2 · Plan recovery ordering

### Fixed

- **Historical plan recovery now selects the genuinely latest run attempt.** PostgreSQL places null values first for descending timestamps; the initial reconciler could therefore prefer an older stalled attempt over a newer successful completion. It now orders by the run's universal last-event timestamp, with the production history shape covered by regression tests.

## [2026-07-11] — v0.8.1 · Operational layouts & reliable plan recovery

### Added

- **File and dispatch work from your terminal in one command.** The `forge` CLI has a new `forge task "<what needs doing>"` — it creates the issue and, with `--agent <name>`, assigns it straight to that agent; without one, it queues the issue for auto-dispatch. (`--project`, `--priority`, and `--title` are supported too. Rebuild the CLI with `pnpm build:cli`.)
- **Agents can open their own tracked run.** A new `runs.open` MCP tool lets an agent (e.g. a local CLI session) proactively start a tracked run on an issue it's working — so its progress, token usage, and steps show in Mission Control — instead of only getting a run when work is dispatched to it. Re-opening resumes the same run rather than stacking duplicates.
- **Idle throwaway agents can auto-clean up.** Settings → Workspace has a new **ephemeral agent idle timeout**: an ephemeral (session/CLI) agent that hasn't checked in for that long is automatically archived — hidden from your lists but reversible. Off by default (0); persistent agents like your always-on assistants are never affected.
- **Deregister a runtime from the CLI.** `forge runtimes archive <id>` removes a stale or abandoned runtime from the list (a new `runtimes.archive` action); `forge daemon start` re-registers a fresh one for the host.
- **Remove agents you no longer need — not just disable them.** Both **Settings → Agents** (in a workspace) and **Instance Admin → Agents** can now remove an agent or profile. It's smart about history: a genuinely unused agent — or a profile no workspace has bound (e.g. a throwaway CLI or test agent) — is deleted outright, while one that has runs, comments, keys, or past assignments is archived instead — hidden from the list but with its history kept, never silently destroyed. In a workspace, **Delete** sits next to **Unbind** (which stays the reversible option); in Instance Admin, **Remove** sits next to Enable/Disable.
- **A finished agent run can auto-move the issue to review.** Settings → Workspace has a new **Review status** option (under "Auto-transition on completion"): pick an In Review-category status, and whenever an agent finishes Execute work successfully, the issue moves there automatically — no more agents leaving completed work sitting untouched in whatever status it started in. Off by default. It only ever lands on your chosen review status, never Done — marking something Done stays your call (or an explicit instruction elsewhere). Research/Review/Discuss dispatches are unaffected, since those never move the issue.

### Changed

- **The dashboard now has a bounded priority cockpit and a shared responsive workspace board.** Focus work and live agent signals stay together at the top; Pipeline, Suggestions, What's New, Notes, Today, Pulse, and Workspace activity then reflow across three, two, or one columns instead of growing as independent uneven stacks. Long ambient feeds are capped with a direct **View all** path, and visual/keyboard order stays aligned at every breakpoint.
- **Configuring a runtime now requires workspace admin.** Creating or editing a runtime in Settings → Runtimes — including its host tool permissions (whether an agent may use terminal / filesystem / git on the host) — is now restricted to workspace owners and admins, matching the existing admin-only gate on that runtime's secrets and repositories. Regular members could previously change it.

### Fixed

- **Completed goal work now advances instead of silently wedging.** Finishing a step-bound agent run now atomically moves its plan step into review and preserves the run as evidence. The watchdog safely repairs historical completed-run/READY-step drift, creates a human review gate when a crew has no reviewer, and sends one persistent, directly linked “Plan needs attention” notification. Plan detail also explains the exact recovery state instead of presenting stale work as actively queued.
- **A stalled issue no longer floods Command Center or leave you guessing what to do.** Repeated watchdog signals group into one activity row and unchanged assignments stop re-emitting the same event; on the issue itself, Forge now explains when Research/Review finished without moving the issue and offers Execute, snooze, and activity actions while keeping runtime tool limits explicit.
- **`forge issue assign` now works.** The CLI command was sending the wrong parameter name and always failed with a validation error; it now assigns correctly. (Rebuild the CLI with `pnpm build:cli` to pick it up.)
- **Expired ephemeral (session) API keys are now cleaned up automatically.** Session keys are TTL-bounded and were meant to be auto-purged when they expire, but expired ones actually lingered in your Access / Agent Clients list; a background sweep now removes them shortly after expiry. Personal and agent keys are untouched.
- **Turning off a runtime's "Local workspace tools" no longer silently wipes its per-mode tool grants.** That toggle clears the runtime's declared tools and every per-mode allowlist (including Research/Review read access), so it now asks you to confirm first — a stray click can't quietly erase the configuration.

- **A Research/Review/Discuss-mode agent no longer gets marked "stalled" after it replies.** Those modes are designed to never move the issue's status — only to comment — but the stalled-work check was watching for a status change regardless, so a well-behaved research reply looked identical to a dead assignment once enough time passed. It could even repeat indefinitely on workspaces with auto-redispatch on. Fixed to skip the stalled check entirely for non-Execute dispatches, matching the documented behavior.

## [2026-07-07] — v0.8.0 · Dashboard redesign, cross-workspace moves & agent-runtime hardening

### Added

- **A redesigned dashboard cockpit — less scrolling, no gaps.** The dashboard is now a two-column cockpit: a wide work column on the left (_Focus today_, _Pick up where you left off_, and a compact **Pipeline** card) beside an always-visible rail on the right (agent activity, attention, standup, what's new) — instead of one long stacked column. The "Suggestions" strip (unassigned + stalled) stays in the work column, below Pipeline.
- **Richer issue cards on the dashboard.** Focus and Pick-up cards now show who's on it (assignee + agent avatars with a presence dot), sub-issue progress, a live agent-run status (running / waiting / stalled), project / label / due / SLA context, and a one-line description when the title is short — each shown only when it applies. Cards size to their own content, so the empty gaps between sparse cards are gone.
- **Set a per-issue SLA target — and let the Coach react to breaches.** Each issue's detail rail now has an **SLA target** field: pick a preset (1 hour, 4 hours, 1 day, 1 week…) or a custom number of minutes, or clear it. When **Enforce per-issue SLA** is on (Settings → Workspace → Agent SLA), an issue that ages past its target raises an SLA breach — which posts a Coach diagnostic comment and shows in your activity feed. Issues with no target are never breached, so turning enforcement on is safe.
- **See your Coach agent's health at a glance.** Settings → Workspace → AI now shows whether the Coach is _armed_, whether it can reach a model, whether the Coach agent exists, which events trigger it (issue stalled / missed ack / SLA breach — and which are turned off), and when it last fired. No more guessing why it is or isn't commenting.
- **A built-in calendar for every date field.** Due dates, sprint and initiative dates, roadmap dates, the time-log range, and snooze now open Forge's own themed calendar instead of the browser's native date box — same look on every browser and OS, with month navigation and a clear button.
- **Draft or improve an issue description with AI.** Next to the Description heading there's now an AI button — **Draft with AI** writes a description from the issue title when there's none yet, and **Enhance** rewrites an existing one for clarity and structure. You see the suggestion (with a current-vs-suggested view for an enhance) and choose **Apply** or **Discard** — nothing changes until you accept it. Appears only when AI is enabled for the workspace.
- **Create a label without leaving the issue.** The label picker on an issue now has a search box — type to filter, and (if you're a workspace admin) pick **Create "&lt;name&gt;"** to make a new label with a name and color right there and apply it in one step. No more detour to Settings → Labels first.
- **Move issues between workspaces (instance admin).** A new **Admin → Move issues** page re-homes issues into another workspace: pick source and target, paste the issue ids, and **Preview** shows exactly what will happen — the new keys (issues are renumbered into the target), how each status and label maps, which labels get dropped, and which issues are _blocked_ (anything with agent runs, plans, or artifacts is refused so nothing is corrupted). Confirm to move; a record is written in both workspaces' audit logs.
- **Cap self-service workspace creation.** Operators can set `MAX_WORKSPACES_PER_USER` to limit how many workspaces a single (non-admin) user can create; the default is unlimited, so nothing changes unless you set it.
- **Approve or reject a paused agent run right where you see it.** When an agent pauses for permission (a Codex/Hermes run flagged a command or file change), the run row in Mission Control's Live tab now shows **Approve** / **Reject** inline — no detour to the Command Center.
- **See a plan's wall-clock burn.** The plan cockpit's budget meter now shows elapsed time vs. the wall-time cap alongside cost, so a plan approaching its time budget is visible at a glance (matching the goal cockpit).
- **Set the engagement mode right when you assign an agent in Quick Create.** Type `/assign @handle` in the new-issue overlay and a small Execute / Research / Review / Discuss picker appears next to the assignee chip — pick one to override the workspace's default for that dispatch, or leave it alone to keep using the default.

### Changed

- **Plans and the review inbox update live.** The Plans list and the Review-gate inbox now refresh on their own as plans, steps, runs, and gates change — no manual **Refresh**, matching the Goals list.
- **Orchestration screens are fully themed.** Every dropdown on the Plans, Goals, and Runtime-settings screens, plus the new-plan / new-goal / edit-goal dialogs, now use Forge's own pickers and one consistent dialog instead of native browser controls.

- **Confirmations, prompts, and dropdowns use Forge's own UI, not the browser's.** "Are you sure?" confirmations (deleting a note, removing an admin, restarting a run), the GitHub App setup prompts, and a batch of dropdowns now use Forge's themed in-app dialogs and pickers instead of the operating system's native popups — consistent look, keyboard-friendly, on-brand. (More dropdowns are still being converted.)
- **The label color picker is now in-app.** Choosing a label color (in Settings → Labels and the new inline create) uses themed swatches plus a hex field instead of the operating system's native color dialog — consistent with the rest of Forge.

### Fixed

- **The Coach stops posting junk or duplicate comments.** It now discards empty or meta AI responses (e.g. "Posted the diagnostic comment…") instead of posting them, and won't comment on the same issue more than once in 24 hours — so a stuck issue gets one useful diagnostic, not an hourly pile-up.
- **AI triage works again — and tells you what's wrong when it can't.** The "AI triage suggestion" card on an issue could get stuck showing a bare _"AI triage unavailable."_ with only a Retry, because some AI providers reply in plain text instead of the structured format Forge expected — so every suggestion was thrown away. Forge now reads those plain-text replies too, so triage produces a real priority / label / agent suggestion. When triage genuinely can't run, the card now explains why and links straight to **Settings → Workspace → AI** to fix it, instead of leaving you guessing.
- **A goal or plan that hits its budget actually stops spending.** When a plan reaches its cost or time cap (or you abandon its goal), its remaining steps stop dispatching immediately — previously a blocked plan could keep launching agents and spend the very budget you were asked to approve.
- **Finished work stays finished.** A late or duplicate reviewer verdict can no longer knock a completed step back into "to-do" and re-run it.
- **Agent runs aren't falsely marked "stalled" after a deploy or restart.** A run whose runtime briefly can't report status — or that's quietly mid-work on a long step — now stays running, and is only marked stalled when it's genuinely idle.
- **Approving or stopping an agent run tells you if it didn't go through.** A failed Approve or Stop now surfaces an error instead of showing success while the run stays blocked at the runtime.
- **Goals and Plans tell a load error apart from an empty list.** A network hiccup now shows "couldn't load … Retry" instead of "No goals yet" / "Goal not found — may have been abandoned", which looked like your work had been deleted.
- **A freshly registered runtime is no longer a dead-end.** You can open a just-registered local daemon's settings — run its self-test, add credentials, bind a repo — straight from the global **Runtimes** page, without waiting for an agent to use it first.
- **Research and Review dispatches can actually read the repo.** A Hermes runtime with no per-mode tool profile configured used to hand a Research or Review run zero local tools — even though the mode's own contract promises "read, search, run read-only tools." It now gets the read-oriented subset (filesystem + git, never terminal) of whatever the runtime declared, matching what was already documented.

### Changed

- **The audit log and webhook deliveries name what they touched.** Both used to identify the subject by a raw id fragment (`issue/a1b2c3d4`). They now resolve it to the real thing — the issue (with its key), project, agent (`@handle`), goal, plan, sprint, artifact, and more — so you can scan the system audit log and delivery history without decoding cuids. The full id is still there on hover.
- **Create overlay catches fields as you type.** The quick-create bar (`⇧C`) now autocompletes real **projects, assignees, labels, priorities, and due dates** — type `/` (or click a **+ field** chip), pick from the live list, and **Tab** drops it in as a coloured badge right in the title box; Backspace removes the last one. The mode and field legends now show only while the bar is empty, so they stop competing with what you're typing. And the field menus no longer get clipped by the overlay — the Project picker, which used to open _inside_ the card and stay invisible, now renders cleanly. Same `⏎ create` / `⌘⏎ create + open` keys.
- **Comments and descriptions autocomplete people, projects, and labels.** Typing a slash command in a comment or the description editor now suggests the real thing as you go — `/assign` lists your agents (with avatars), `/project` your projects, `/label` your labels, plus priority and due-date options — so you pick from a list and press **Tab** instead of remembering a key. Same `/status`, `/blocked`, `/handoff` templates as before.
- **Cleaner pickers for crew, time tracking, and relations.** The crew picker, the time-tracker's issue picker, and the relation-type picker are now themed to match the rest of Forge. The time-tracker's issue field is now **searchable** — find any issue by key or title instead of scrolling a short recent list.
- **The Review page shows what you're approving.** Review gates used to identify their target by a raw id (`a1b2c3d4…`). They now show the issue (with its key), plan, or goal name, so you know what you're gating before you approve or reject.
- **Browse _any_ repo your GitHub App can reach — no manual mapping first.** The link dialog's **Browse a repo** tab used to list only repositories an admin had already connected, so right after installing the App it dead-ended at "install the GitHub App" even though the App was working. It now lists every repo the App's installation can see; pick one, start typing, and Forge connects it automatically on first search. Non-admins still see only already-connected repos.
- **The claim holder shows who actually claimed it.** An issue's sidebar used to read "Claimed by `a1b2c3d4`". It now shows a proper badge — and when an **agent** claimed (via its key), it attributes the claim to that agent (avatar + name + `@handle`) instead of the human account that owns the key. Human claims still show the person. The short id stays as quiet subtext.
- **The GitHub App you set up now powers PR/issue linking too — one app, no env vars.** Linking used to need a _separate_ global env app (`GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`) plus a Connection, wholly disjoint from the GitHub App configured in Settings → GitHub Apps (which only did runtime `GH_TOKEN` auth) — so "Test connection" could be green while issue-page linking still said "install the app." Forge now mints linking tokens from that same `GithubApp`, and when no connection exists yet the link dialog offers a one-click **"Use your GitHub App"** that wires it up (and maps the repo) with no GitHub reinstall and no env config.
- **Orchestrated runs now show their engine.** Runs opened by the Goal/plan loop (execution steps) now carry their engagement mode + run engine like assignment and grant runs, so the engine chip and "why" tooltip render on them too instead of staying blank.

### Fixed

- **Pop-up menus no longer get cut off.** Several dropdowns were clipped when they opened near the edge of a scrolling panel — the run-controls menu in the agent pipeline, a comment's edit-history, the snooze menu, agent quick-actions, the dispatch "Why?" tooltip, and the Quick Notes status/convert menus. They now float above everything and flip upward when there's no room below.

### Added

- **Filter the issues list by project — including "No project".** The global issues view gains a first-class Project filter alongside Sprint/Initiative, with a **No project** option for unfiled work, plus a **Done** quick filter. Filtering by a Done/Canceled status now actually shows those issues instead of silently returning nothing, and agents see the same semantics via MCP `issues.list` (which also stops dropping Canceled issues).
- **Link GitHub issues & PRs from the issue page — with a way out of "no mapping".** The issue's GitHub panel now opens a proper dialog: paste a URL or `owner/repo#123` and see a live preview before linking (a PR pasted as an `/issues/` URL is recognized as a PR), or **browse a connected repo's** open issues and pull requests and link them in place. When a repository isn't wired up yet, the dialog explains exactly _why_ and offers the one-click fix — **connect the repository** (admins), **resume a paused** connection, or **install the GitHub App** — instead of the old dead-end "No active GitHub mapping for this repository" error. Agents get a new `github.listMappings` tool so they can discover which repos are linkable before searching or linking.
- **Run rows show the engagement mode, engine, and _why_.** Every agent run now displays its engagement mode (including **Execute**, which used to be hidden) and its run engine (**Runs** / **Streaming**) as chips, with a tooltip explaining how the mode was decided (surface default, mention policy, carried from the active run, an explicit marker, …). The mode/engine/source are frozen on the run at dispatch, so they stay truthful even after you later change an agent's settings.
- **See how a dispatch will run before you commit.** The assign popover now previews how the assigned agent will dispatch at the chosen mode ("runs as Research on Hermes Runs"), and the agent detail page shows the agent's _resolved_ engine (honoring an attached runs-runtime, not just the raw preference).
- **Command Center & Inbox group repeated asks per issue.** Multiple open requests on the same issue now collapse into one card with a "+N more" count instead of stacking near-duplicates.
- **Per-run safety budgets.** A workspace can now cap each agent run by tokens, cost (USD), and/or wall-clock minutes (Settings → Workspace → Run safety budgets; `0` = no cap, opt-in). When a run crosses a configurable warn threshold you get a one-time heads-up; when it breaches a cap, Forge stops the provider run and either **pauses** it — parked with a clear reason and a "raise the budget & resume, or abandon" notification — or **stops** it outright. The idle watchdog only caught _quiet_ runs; this catches a _busy-but-looping_ one before it burns unbounded spend. No run is left in a silent dangling state.
- **Slimmer MCP tool list for providers with tool-count caps.** The MCP endpoint now accepts `?profile=core|planning|agents|canvas` (or `?tools=issues,comments,…`) to advertise a focused subset of Forge's ~200 tools — so models that cap the tool list (e.g. xAI/Grok at 200) stop rejecting sessions. `tools/list` is also pruned to the key's scopes. Full capability stays callable regardless. Point a capped runtime's Forge MCP URL at `?profile=core`.
- **Generate a plan with Forge — no agent required.** A goal now offers two ways to draft its plan: **Generate with Forge** builds the steps directly using your workspace's AI model, and **Dispatch to crew planner** hands it to an agent as before. Pick whichever fits; Generate works even with no agents online.
- **The dashboard Customize mode is now a fluid grid.** Tiles live on a 2-column grid you can drag to reorder — the board reflows with smooth motion as you drag instead of snapping. Drag a tile's right edge (or hit the size button) to snap it between half and full width, and the layout animates into place. Your order, widths, and hidden tiles save automatically. Respects reduced-motion.
- **The issues list loads every issue, not just the first 50.** The list now pages in more as you scroll (with a "Load more" fallback); the board pages each column independently, so low-traffic columns like Backlog and Done are no longer starved by a shared cap.
- **Keyboard navigation on the issues list.** Move the row cursor with `j`/`k` or the arrow keys, open the focused issue with `↵`, and select it with `x` — no mouse required. Filter pop-overs also close with `Esc` and move with the arrow keys.
- **Filtered issue views are now shareable.** Your active filters, search, sort, and grouping live in the URL, so a filtered list can be bookmarked, shared, and survives a refresh — and the browser Back/Forward buttons undo and redo filter changes.
- **The issues board honours Sort and the due-date filter.** Changing Sort now reorders board cards, and a `?dueOn=` deep link (from the Today widget) scopes the board too — previously both were silently ignored on the board.
- **Shared GitHub Apps for runtime git auth (no per-repo keys).** A new **Settings → GitHub Apps** page lets you set up one GitHub App and share it across runtimes. Forge mints a short-lived installation token into `GH_TOKEN` at provision time, and you manage which repos it can touch from GitHub — no per-repo tokens, no long-lived key to rotate. **Create with GitHub** runs a manifest flow where GitHub generates the app and key for you (no PEM to paste) and walks you through install; or add an existing app manually. A **Test connection** button reports the account + repo count. Point a runtime at an app from its settings. The private key is encrypted at rest and never leaves the server.
- **Per-project repositories.** Bind a git repo to a project (Project → Edit → Repository). Runtimes clone-or-pull every project's repo, so one runtime can serve many codebases — an agent dispatched to a project's issue is told which checkout to work in.
- **SSH-key git auth.** Add a `GIT_SSH_KEY` runtime secret (with optional `GIT_SSH_KNOWN_HOSTS`) to clone/push over SSH — deploy keys and non-GitHub hosts, alongside or instead of a token.
- **One-command runtime provisioning for any host.** A new **Provisioning** card (Settings → Runtimes → a runtime) gives a copyable bootstrap + downloadable script that sets up a runtime anywhere — fetches its secrets, configures git auth, and clones its repos. Works for ephemeral agents (Claude Code, Codex CLI) and persistent hosts alike; a `forge-provision` Hermes skill runs it on a schedule. Provider-agnostic — the same flow as the Codex bridge.
- **Runtime credentials + repo provisioning.** Runtimes (Settings → Runtimes → a runtime) now have an encrypted **Secrets** store (e.g. `GH_TOKEN`) and **Repository** bindings. A runtime auto-provisions on startup — fetches its secrets, sets up git/`gh` auth, and clones-or-pulls its bound repos into the workspace — so a dispatched agent lands in a ready checkout with push/PR access instead of an operator hand-placing files and keys. Secret values are write-only (never shown again after saving).

### Fixed

- **"Install GitHub App" / Connect-GitHub works behind a reverse proxy and without extra env setup.** The Connect-GitHub flow used to redirect to an internal `https://0.0.0.0:3000/...` URL on a proxied deployment (so the button looked broken on the public site), and it dead-ended with "GITHUB_APP_SLUG is not configured" unless that env var was set by hand. It now builds redirects from the real public origin (honoring `X-Forwarded-Host`/`-Proto`) and, when the env var is unset, falls back to a GitHub App you've already set up in Settings → GitHub Apps — so connecting a repo to link PRs/issues works out of the box.
- **Assigning a non-Execute agent via `/assign` no longer auto-starts the issue.** A slash-command assignment now carries the resolved engagement mode, so a Research/Review/Discuss agent assigned that way is no longer wrongly flipped into in-progress.
- **Repeated stalled agent runs collapse into one card.** When a piece of work was re-dispatched, each attempt left its own stalled run behind, so one issue could show three or four identical "stalled run" cards in Command Center (e.g. AXI-75). A fresh run now supersedes its earlier attempts and they collapse into a single thread — the head run, with the history preserved underneath — instead of piling up.
- **Duplicate permission/grant requests no longer pile up.** A second runtime-tool-grant request for the same issue (e.g. escalating read-only → full) now _replaces_ the earlier open one instead of leaving two competing cards in the queue. Generally, a newer request for the same issue + kind + agent supersedes the prior open one.
- **Mission Control finally fits a phone.** The cross-workspace pages (Mission Control, Inbox, Activity, What's New) used to stack the whole sidebar above the page on mobile — eating the top third of the screen before any content. The sidebar now lives behind a hamburger menu (a bottom sheet), tap targets on the top-bar buttons are bigger, the app extends correctly under the notch (safe-area), and desktop-only keyboard hints are hidden on mobile.
- **Clicking "Plan" no longer leaves you with a silent empty plan.** If the crew's planner can't be reached (no planner assigned, offline, or not wired up), the goal now says so clearly and points you to generate the plan with Forge or add steps yourself — instead of a blank plan with no explanation. When a planner _is_ reachable, you see it was dispatched and that steps are on the way.
- **Unused dashboard widgets no longer show as blank tiles.** Widgets with nothing to show (no agents, no recent items, etc.) collapse and take no space; in Customize mode they stay visible, flagged "not in use," so you can hide them.
- **Dashboard customize drag feels smoother.** You can now grab a tile anywhere (not just the small grip), reordering no longer jitters while tiles animate, and the resize edge is a larger, easier target.
- **Filtering the issues list by a "Done" (or "Cancelled") status now shows those issues.** Previously the list hid completed work by default, so explicitly selecting a Done status from the Status filter returned nothing. The list now includes done issues whenever your filter explicitly asks for a completed status.
- **The issues header count is now honest.** The subtitle reflects what you're actually looking at ("N matching" when filters are active) instead of a raw total that counted archived, done, and snoozed issues.
- **"Clear filters" no longer snaps back.** Clearing with both a saved view and a due-date deep link active could silently re-apply the view; it now clears everything in one step. The board also shows a "no matches" state with a Clear shortcut, like the list.
- **The "Recently updated" quick filter no longer resets your window.** A saved view pinned to 7/30 days now lights the chip correctly instead of appearing off and being clobbered back to 3 days on the next click.
- **Invalid due-date links are rejected.** A shared `?dueOn=` with an impossible date (e.g. `2026-13-45`) no longer silently rolls over to a different day.
- **Codex approvals on assigned issues no longer freeze.** Approving (or rejecting) a Codex command request now reaches the agent even when dispatch runs in a separate worker process — previously the button flipped the run between "running" and "waiting" without ever resuming.
- **Failed agent dispatches now show on the issue.** When a dispatched run ends without completing (stalled/abandoned), the agent's output is posted as a comment on the issue instead of being buried in the Mission Control run overlay — so a failed run is visible in the timeline and notifies watchers.
- **Replying to a blocked agent now resumes it.** When an agent pauses a run waiting on you, nudging it (or commenting on the issue) re-dispatches it with your reply — previously a paused run could only be restarted by re-assigning, which lost its context.

### Changed

- **The planning views got a visual refresh.** Plans and goals show a numbered DAG step strip with the running step glowing, status colors now use the warm palette, lists fade in as they load, and detail-view titles are sized to match the rest of the app (no more oversized headers).
- **Creating a goal no longer auto-starts the planner.** You land on the goal and choose how to draft the plan, instead of a planner being dispatched silently in the background.
- **Approve grants session scope by default.** Approving a command request stops the agent re-prompting for similar commands for the rest of the run; a "Just this once" link keeps the single-command option.
- **Command approvals now appear on the issue page.** The Approve/Reject card shows in the issue's agent panel, not only in the Mission Control Live tab.
- **The issue's agent panel shows why a run is paused.** A waiting run now displays the agent's last step / block reason inline, so you can respond without opening the Mission Control overlay.

## [2026-06-09] — v0.7.0 · Chat runtime controls

### Added

- **Runtime model and mode controls.** Codex runtimes can set a default model and YOLO mode; Hermes runtimes can set profile, mode, model, and YOLO auto-approval.
- **Conversation-level YOLO overrides.** Chat threads can inherit, force-enable, or force-disable YOLO from the chat header settings menu.
- **Workspace default issue assignee.** Workspaces can automatically assign new issues to nobody, the creator, or a selected member.

### Changed

- **Chat status is calmer and more accurate.** Stale failed turns no longer keep active conversations stuck in attention/thinking states, `/clear` restores suggestions, and chat work traces render in a shared compact format.
- **Codex app-server run tracking is durable across connector instances.** Forge now retains active run state long enough for pollers and reports unknown or prematurely closed Codex runs as failures.

### Fixed

- **Provider permissions now reach the runtime.** Codex chat turns forward model and YOLO policy, and Hermes approval prompts are auto-resolved when YOLO is enabled.
- **Issue creation paths honor the same assignee defaults.** UI, email ingest, recurring issues, note promotion, MCP promotion, and execution-step materialization now share the same default assignment behavior.
- **The Activity launcher no longer blocks Chat send.** The collapsed Mission Control launcher lifts above the full Chat composer instead of intercepting the Send button.
- **Chat read and composer state are steadier.** Activity views mark visible chat activity read, and newly opened thread drafts finish loading before the composer accepts input.

## [2026-06-09] — v0.6.0 · GitHub support and sprint planning

### Added

- **GitHub App support.** Added GitHub connection setup, install callbacks,
  webhook ingest, synced external resource mappings, issue-detail GitHub links,
  and MCP tooling/docs for linked GitHub work.
- **Sprint management workflows.** Added sprint edit, rollover, guarded create,
  backlog planning, and delete flows with audit-backed issue movement.

### Changed

- **Roadmap is now a working timeline.** Added initiative, date coverage, and
  progress filters, visible sprint bands, no-date rows, and inline project date
  editing.
- **Issue creation now has a shared service path.** UI, API, and MCP creation
  paths share the same issue-create behavior.

### Fixed

- **Sprint and project date guards are enforced server-side.** Forge now rejects
  overlapping active sprints and invalid project date ranges through tRPC and MCP.
- **Side-panel interactions no longer leak to Mission Control shortcuts.**

## [2026-06-06] — v0.5.1 · Android PWA install and push

### Added

- **Forge installs cleanly on Android.** Added install prompts, launcher
  shortcuts, update notifications, offline fallback, and opt-in visited-page
  caching for the PWA shell.
- **Browser push notifications.** Added VAPID-backed Web Push subscriptions,
  service-worker notification handling, and best-effort fanout for alertable
  workspace activity.

### Changed

- **iOS gets lightweight PWA guidance.** Users on iOS see an Add to Home Screen
  hint when Forge is not already running standalone.

### Fixed

- **Twitter image builds without metadata warnings.** The twitter-image route
  now exports metadata config directly so Next can analyze it cleanly.

## [2026-06-06] — v0.5.0 · Agent runroom views

### Added

- **Agents now have an operational runroom.** The workspace agents view now
  surfaces fleet health, dispatch queues, attention items, runtime topology,
  and recent activity in one oversight screen.

### Changed

- **Agent detail pages focus on readiness.** Individual agents now show held
  work, active runs, context, crew activity, runtime readiness, webhook health,
  and dispatch eligibility in a cleaner operator layout.

## [2026-06-03] — v0.4.2 · Build version reporting

### Fixed

- **Version chip reports the tagged package version.** `system.buildInfo` now
  reads `package.json` in standalone Docker images when `npm_package_version`
  is absent, so the in-app release chip shows the deployed Forge version
  instead of the fallback `v1.0.0`.

## [2026-06-03] — v0.4.1 · Release metadata visibility

### Fixed

- **What's New shows the current release again.** Fixed the changelog parser so
  bracketed ISO-date headings like `[2026-06-03]` stay intact instead of being
  split at the first hyphen, restoring `system.buildInfo.release` and the
  release ordering used by What's New.

## [2026-06-03] — v0.4.0 · Mobile app experience

### Added

- **Forge now works as a mobile app.** The authenticated shell, bottom
  navigation, issues list/board/detail, inbox, dashboard, review, settings,
  agents, and Mission Control now adapt down to phone widths with reachable
  controls, stable touch targets, and no document-level horizontal overflow.
- **Mobile regression coverage.** Added a Playwright smoke spec that exercises
  core authenticated workspace routes at 390px, 430px, and 768px.

### Changed

- **Dense workflows read better on small screens.** Page topbars stack, subtitles
  clamp cleanly, issue rows emphasize the useful title/key hierarchy, inbox
  action labels shorten where needed, mobile toasts clear the bottom nav, and
  agent runtime cards use compact tooltip-backed metrics.

## [2026-05-31] — v0.3.1 · Auto-settle stale agent runs

### Changed

- **Finished agent runs stop lingering.** The stalled-run watchdog is now on by
  default (idle ACTIVE runs auto-close after 30 minutes), so an agent turn that
  ended without an explicit "done" no longer shows as a live run on the issue
  page indefinitely. Tunable per workspace (`agentRunStaleMinutes`); set 0 to
  disable.

## [2026-05-31] — v0.3.0 · Issues filtering & live composer UX

### Added

- **Filter, sort & group your issues.** The issues list gains multi-select
  **Status / Priority / Project / Assignee / Label** filters, a **Sort**
  control (priority, newest, oldest, recently updated, title A–Z), and a
  **Group by** control (status, project, assignee, priority, or none). Sort
  and grouping are remembered per browser.
- **Slash commands that show their work.** In the new-issue overlay (⇧C),
  typing a command like `/priority high`, `/assign @victor`, `/due tomorrow`,
  `/label bug`, or `/project AXI` now lights up the matching picker (priority,
  project) or drops a removable **chip** the moment it's valid — press ⏎ to
  apply it and keep only your title text. A live "↵ apply …" hint shows when
  a command is recognized.
- **See your @mentions and /commands as you type.** The issue description and
  comment composers now highlight `@mentions` and recognised `/command` lines
  inline while you type, before you submit.

### Changed

- **Roomier create overlay.** The ⇧C quick-create panel is a touch larger
  with a cleaner layout, and the project picker now matches the rest of the
  app's styling instead of a plain dropdown.

### Fixed

- **Agent runtime reads cleanly.** The "X was assigned by Y" note in an
  issue's timeline now shows a tidy runtime label (e.g. "remote webhook")
  instead of the raw `REMOTE_HTTP` with stray underscores.
- **Live run status settles when work ends.** The agent run strip on an issue
  stops pulsing "working…" and settles to a calm "idle" state once the agent's
  turn finishes, instead of looking busy for minutes afterward.
- **Issue detail fits smaller screens.** The Attachments "attach link" form no
  longer overflows the side panel on smaller laptops, and the issue detail +
  issues list read cleanly down to mobile widths.

## [2026-05-27] — v0.2.0 · Release visibility & docs

### Added

- **What's New, everywhere.** A global **What's New** page (newest first, grouped
  Added / Changed / Fixed / Removed per release) is now reachable from Mission Control
  and Instance Admin — not just the workspace dashboard. All read the same canonical
  `CHANGELOG.md`.
- **Version at a glance.** The running version + build now show as a subtle chip in the
  global "concourse" rail and the Instance Admin rail (hover for release / SHA / build
  time), linking straight to What's New.

### Changed

- **Docs:** new user guides for **Mission Control**, **Connections**, **Instance Admin**,
  and **Agent profiles & bindings** (the three-tier ownership model + request→approve).

## [2026-05-27] — v0.1.0 · Multi-workspace platform

### Added

- **Connect external accounts (OAuth/OIDC).** Connections now do a real authorize →
  callback flow (generic OIDC discovery plus GitHub / Google / Slack), so you can
  **Authorize** an identity from **Settings → Connections** instead of pasting a token.
  Tokens are encrypted and refreshed automatically near expiry.
- **Request an agent profile.** Members can request a new agent profile from a
  workspace's **Settings → Agents** catalog; instance admins approve or reject pending
  requests from **/admin → Agent policy**. (Creating a profile directly still needs admin.)
- **Per-binding "require approval"** — a workspace binding can require human approval
  before a dispatched run starts, overriding the workspace default.
- **Default labels on connection mappings** — inbound work from a mapped repo/channel
  can auto-apply chosen labels.
- **Cross-workspace Mission Control.** A new home at `/` surfaces your work, agents,
  runtimes, and live activity across every workspace you belong to — read-only, with a
  workspace chip on each row and a Slack-style workspace switcher in the rail (also in
  ⌘K and a dedicated **Settings → Workspaces** picker).
- **Global agents, runtimes & connections.** Agent **profiles**, **runtimes** (the hosts
  you've registered), and **connections** (your GitHub / Slack / OIDC identities) are now
  defined once at the account level under **Settings**, then adopted per workspace.
- **Instance admin area.** A dedicated, separately-styled `/admin` section (instance
  admins only) for tenants, users, instance-wide runtimes, audit, and build/system info.
- **Epics & sub-issues.** Issues now have a **type** — Epic, Issue, or Sub-task — set
  from a picker on the issue header (type glyphs show in lists). An **Epic** is an
  issue whose **sub-issues** are its scope: the issue page has a Sub-issues panel with
  a done/total progress bar and inline "add sub-issue", a "↑ part of EPIC-…" backlink
  on children, and an **Epics** quick-filter on the issues list. Sub-issues reuse the
  same parent/child tree the relations graph already draws.
- **Engagement modes for agent work.** When you assign or mention an agent you can
  now say _what_ you want — **Execute** (take it to done), **Research** (investigate
  & report, no changes), **Review** (critique only), or **Discuss** (just weigh in).
  Only Execute moves the issue or runs the completion gates, so a research or review
  pass can't accidentally start work or deploy. Defaults per surface are configurable
  in **Settings → Dispatch Rules** (including how a bare @-mention is treated). See
  the [Engagement modes guide](/agents/engagement-modes).
- **Plan steps can become real issues.** Materialize any execution-plan step into a
  tracked Issue (carrying its expected-output + verification), so planned work shows
  up on the board/sprint like everything else — or leave it as pure plan scaffolding.
- **Goal/plan work is now visible in Mission Control.** Steps an agent runs as part of
  a Goal open real runs (with a mode chip) instead of dispatching silently.
- **Goals can sit under an initiative**, and a hand-authored plan can be linked to a
  goal (and built with step dependencies) in one step.
- **Dependency graph on issues.** The Relations tab now has a **Graph** view (toggle
  next to List) that maps the issue's place in its blocks/blocked-by chain _and_
  parent/child sub-issue tree — an animated, themed DAG with the current issue
  flagged "here". Click any node to jump to it.
- **Move issues between projects and sprints in bulk.** The issues list and inbox
  bulk bars gained **Project…** and **Sprint…** actions; select any number of issues
  and move them in one go.
- **"Part of" backlinks on issues.** An issue now shows the execution **plans** it's
  the subject of, each with a step-progress bar (done / total) — alongside the
  existing goals strip.
- You can now link a hand-authored execution plan to a goal: `executionPlans.create`
  accepts a `goalId`, and a new `goals.attachPlan` action attaches an existing plan
  as the goal's active attempt — no need to go through the AI planner.
- `executionPlans.create` can now seed a step DAG in one call using
  `steps[].dependsOnStepIndexes`, matching `plans.addSteps` for hand-authored plans.

### Changed

- **Workspace Agents & Connections are now bindings, not definitions.** A workspace's
  **Settings → Agents** is a catalog of globally-defined profiles you _bind_ with
  per-workspace policy (capacity, capability overrides, auto-dispatch eligibility);
  **Settings → Connections** _maps_ your global identities to repos / channels /
  webhooks. Dispatch rules can only target agents bound to the workspace.
- **"Mission Control" overlay is now "Activity."** The chord-`G 5` live-runs + chat dock
  is renamed **Activity**; the name _Mission Control_ now refers to the new
  cross-workspace home at `/`.
- **Removed the per-workspace "Personal" view** — its cross-workspace successor is
  Mission Control at `/`.
- **Issue sidebar pickers are now searchable.** Project and a new **Sprint** field use
  the command-palette picker; the project picker surfaces each project's initiative
  inline so you can place work in the right bet at a glance.

### Changed

- **The notifications bell no longer wipes unread state the instant you open it.**
  It now marks notifications read when you _close_ the panel, so you can open it to
  glance, read individual items, and use the per-row Ack/Dismiss/Resolve controls
  without the badge clearing out from under you.
- **The bell/inbox badge is now a true "unread" count** — items new since you last
  looked — instead of a running backlog total. Visiting the Inbox, pressing `M`, or
  opening and closing the bell clears it; new activity raises it again.

## [2026-05-25] — Settings sidebar + sharper status, dispatch, and detail styling

### Added

- **Command Center asks can now set the issue's status inline.** When an agent
  asks for you on an issue, a "Set status…" control on the card moves the issue
  (e.g. straight to Done) without accepting or declining the ask — so closing an
  issue never records a decline resolution.
- **Settings now has a left sidebar** with grouped sections, short descriptions,
  admin tags, and a search box (press `/`) — replacing the cramped top tab bar.
- **Status icons** across issues now show their true shape (backlog, started,
  in-review, done, blocked, canceled) instead of a plain dot, and **priority**
  marks are colour-coded (urgent reads red, high amber).
- **`+ Add`** affordances (capabilities, labels, assign-agent, providers) now use
  the dashed-outline style from the design.

### Changed

- **Dispatch rules** is now a proper routing table — On / Name / Priority /
  Label / Project / Target agent columns with a real toggle — instead of a
  one-line sentence per rule.
- **Plans** cards show their step DAG and owner; **Roadmap** bars show a progress
  fill and project key; **Goals** keeps the loop guide visible above the list;
  the **sprint backlog** reads as a dashed "drag → plan" tray.
- **Dashboard** "Needs you" now lists the actual asks inline (with the agent and
  a Resolve/Review action) and gained a **Pulse** widget (open / in-progress /
  done-this-week / sprint).
- Chips/badges use a consistent rounded style; **labels** render as bordered
  chips. Per-status groups on the issues list have an inline **+ Add issue**.
- **Sprints** header has a sprint switcher + always-available "Rollover
  incomplete"; the burndown notes whether you're on pace.
- Smaller polish: roadmap Filter + per-row project counts, artifacts "updated"
  timestamps, an initiatives "Roadmap view" shortcut, Command Center shows who's
  asking, an inbox "Mark read" (M), and the new-API-key dialog recaps the key
  details behind an "I've saved it" confirm.
- **Connections** now open a **detail page** (Configure/Connect → its own page).
- **Inviting members** is now a multi-recipient composer — paste a list, see
  who's valid / already a member, pick a role, add a note, send in one go.
- **Plugin** detail pages are organized into Overview / Permissions /
  Configuration / Activity tabs.
- Two new **interactive backgrounds** in Appearance — a cursor-reactive dot grid
  and a drifting particle field (both respect Reduced Motion).
- **Project** overview now has a Properties / Progress / Contributors side rail,
  and the **Inbox** gained an agent-queue + "agents online" side rail.
- **Chat** rail now shows the conversation's members and any linked issue
  alongside the connection status; **Plans** has a templates + status-legend side
  rail; the **add-agent wizard** uses step dots with per-provider setup previews.

## [2026-05-24] — Choose your background, richer agent & plan cards, plugin pages

### Added

- **Background style is now yours to pick** (Settings → Appearance):
  **Grid** (default), **Glow** (a drifting ember bloom over a dot field),
  **Dots**, or **None**. Applies instantly and follows you across workspaces.
- **Agent cards** now show provider, runtime, connection, heartbeat, capabilities,
  and a workload bar at a glance, with an **Infrastructure** panel for the wiring.
- **Plugin pages** — each plugin now has its own detail page (scopes explained,
  skills, webhooks, events) with approve / suspend / rotate-secret / remove —
  groundwork for first-class integrations like a GitHub bridge.
- **More signal on cards**: projects show a progress bar + initiative; initiatives
  list their projects with done/total; plans show a step strip + owner; goals and
  Command Center show step progress.

### Fixed

- The ambient **grid background no longer stutters** on long pages and now always
  fills the full height of scrollable pages (it's one fixed layer behind the app
  instead of a per-page layer that lagged or cut off mid-scroll).

## [2026-05-24] — Settings, redesigned

### Added

- **Agents** now show as one card per agent with provider, runtime, connection,
  and last heartbeat inline, a workload bar, and a collapsible **Infrastructure**
  panel — no more hopping between Agents, Runtimes, and Integrations to see how
  an agent is wired.
- **Plugins** gained a **Permission reference** explaining what each scope grants,
  so you can approve the smallest set that does the job.
- Settings pages across the board now **group related controls**, put **help text
  under fields** instead of in tooltips, teach you what a feature does when a list
  is empty, and isolate destructive actions in a clearly-marked **danger zone**.
- **Workspace · General** got a sticky **save bar** that appears only when you
  have unsaved changes (with a pending-count and ⌘S).

### Changed

- **Members**, **Statuses**, **Labels**, **Dispatch rules**, **Saved views**,
  **Recurring**, **Templates**, **Data export/import**, **Admin**, and the
  **account** pages were reorganized for less clutter and more breathing room.

## [2026-05-24] — More signal on the planning & work screens

### Added

- **Issues list now groups by status** with sticky section headers (count per
  status), Linear-style — plus inline label chips and a comment-count on each
  row. Select-all, bulk actions, and previews all still work.
- **Sprint summary** shows a four-up breakdown — Scope / Done / In progress /
  Remaining — instead of three numbers.
- **Goal cards** gained a step-ladder, a budget meter (turns amber as you near
  the cap), and the owning crew at a glance.
- **Roadmap** bars show the project key and a clearer legend; active sprints are
  tinted more strongly than planned ones.
- **Artifacts** can be filtered by type and searched.
- **Dashboard** "By status" rows now draw a proportional bar so you can eyeball
  the mix.
- **Command Center** live-goal cards show budget used vs cap.
- A **"+" on each board column** to add an issue straight into that column, and
  a live presence dot in the chat conversation header.

## [2026-05-24] — Settings cleanup: one home for agents, a clearer Connections page

### Added

- **Connections** (Settings → Connections) — a focused page for systems that
  talk _to_ Forge or receive events _from_ it: GitHub, Slack, email-to-issue,
  custom webhooks, split into Inbound and Outbound. Replaces the old
  Integrations page.
- **Add-an-agent gallery + provider matrix** on Settings → Agents — pick a
  provider recipe (Hermes, Claude, Codex, Custom) to start onboarding with the
  right connection and runtime preset, and see at a glance which connection
  mode each provider uses.
- A **drifting glow-grid background** style (warm ambient lights moving through
  a dot grid; respects Reduced Motion).

### Changed

- **Agents is now the one place to configure agents** — provider, runtime, and
  connection all live here instead of being scattered across Agents, Runtimes,
  and Integrations.
- **Integrations was renamed Connections** and scoped to external I/O only.
  Old `/settings/integrations` links redirect automatically.

### Removed

- The standalone **Runtimes** entry in the settings sidebar — runtime setup now
  happens during agent onboarding (the advanced runtime editor is still
  reachable for power users).

## [2026-05-24] — Agent runtimes & chat clarity

### Added

- **Codex as a first-class agent** — connect a Codex _app server_ as a
  managed runtime and chat with a Codex agent that answers as itself, the
  same way Hermes agents do.
- **Local agent sessions over ACP** — drive a local CLI (Claude Code,
  Codex, OpenCode) as a live agent via the Agent Client Protocol, run by
  the `forge` daemon.
- **Model credentials in Settings → Workspace → AI** — store an
  OpenAI / Anthropic / custom chat-model key (encrypted) so the Streaming
  engine works without environment variables.
- **"Verify connection"** in the agent editor — confirms an agent can
  actually chat (and probes the runtime endpoint) before you rely on it.
- **Fleet-setup checklist** on Settings → Agents — runtime → agent → key →
  chat-ready, at a glance.
- **About / build line** on the Settings page showing the running version,
  release date, and build, plus a "What's new" link.

### Changed

- **Integrations page** now groups every connector by tier — first-class
  managed runtimes, session CLIs, and basic webhooks — with clear
  transport and chat badges.
- **Chat now shows how each agent is served** — a transport chip (Hermes,
  Codex app server, ACP session, local daemon, or streaming) in the chat
  header, Mission Control, and the status rail, so you always know where a
  reply comes from. Slash commands adapt to the agent (e.g. Hermes-only
  commands are hidden elsewhere; a new `/runtime` shows the chat path).
- **Agent detail page** gained a Connection card (transport, runtime
  adapter, disabled state, and a Verify-connection button); dispatch-only
  cards (webhook health, heartbeat) are hidden for agents that don't use
  them, so the page fits the agent.

### Fixed

- **Managed-runtime agents no longer show a false "offline."** An agent
  reached on demand (Codex app server, a streaming model, or a daemon)
  now reads **"on-demand"** consistently across chat, Mission Control, and
  Settings → Agents — it connects when you message it — instead of a
  permanent offline that only applied to heartbeat agents like Hermes.
- **On-demand agents can be auto-assigned work again.** Auto-dispatch no
  longer skips an agent just because it's "offline" by heartbeat (which an
  on-demand agent always is), so Codex/app-server agents are eligible for
  round-robin / capability / priority assignment. Disabled runtimes are
  skipped up front.
- **A Codex app-server agent can now be set to persistent.** Settings →
  Agents previously forced Codex (and Claude) to single-session and blocked
  the persistent option — so a Codex agent stayed single-session and read
  "offline" everywhere despite the on-demand work above. You can now choose
  **Persistent** for a Codex agent attached to the Codex app-server runtime,
  and it shows **"on-demand."**
- **On-demand presence now reads correctly on every surface** —
  execution-plan step dots, the crew rosters (crew page + plan/goal
  cockpits), the chat @-mention list, the agent timeline, the dashboard
  agent-activity tile, and agent hover cards no longer show a managed
  app-server agent as "offline."
- **Persistent mode is gated by the attached runtime, not the provider.**
  A Claude or Codex agent can be persistent when hosted on a managed
  runtime (the Codex app server or the Forge local daemon); the wizard no
  longer blocks persistent Claude outright or restricts persistent Codex to
  the app server alone.

### Changed

- **Managed agents now show true online/offline.** An agent hosted on the
  Forge local daemon goes **online** while the daemon is heartbeating and
  flips to **offline** when it stops — instead of always reading "on-demand."
- **Codex app-server presence is health-checked.** Forge now periodically
  pings the Codex app server; its agent reads **online** when the server
  answers and **offline** when it doesn't, so a dead bridge is visible at a
  glance instead of failing only when you message it.
- **New workspaces auto-offline idle agents by default.** The agent idle
  timeout now defaults to **15 minutes** (was off), so a heartbeat agent whose
  runtime goes quiet flips to offline on its own — true presence works out of
  the box. Existing workspaces keep their current setting; `0` still disables.

## [2026-05-23] — Sign-in, SSO & agent platforms

### Added

- **New sign-in experience** with a refreshed split layout.
- **Single sign-on (SSO)** — admins can enable and manage OIDC providers
  (Authelia and other self-hosted IdPs) plus GitHub / Google from
  Settings → Auth.

### Changed

- **Agents answer on the right platform.** A configured agent no longer
  silently falls back to another provider — if its chat backend isn't set
  up, you get a clear "no chat model configured" notice instead of a reply
  from the wrong platform.

### Fixed

- Chat replies no longer occasionally show an empty agent bubble.
- An error notice in chat now stays visible until you retry or send again,
  instead of disappearing on its own.
- Smoother animated backgrounds (sign-in and dashboard) — no more stutter.
- Navbar account menu items are all clickable again; Mission Control's
  History heatmap fits its column width.

## [2026-05-21] — Customizable dashboard

### Added

- **Customize your dashboard** — a "Customize" toggle lets you drag to
  reorder the dashboard's widgets and hide ones you don't use; the
  layout is saved to your account. Reset returns to the default.
- **"Pick up where you left off"** — a dashboard tile surfacing the
  issues, projects, and other items you most recently opened.
- **What's New "unseen" dot** — the What's New tile flags when there
  are changes you haven't read yet, and clears once you open the full
  page.

### Changed

- **Smarter dashboard greeting** — "Browse templates" becomes "New
  project" once you have projects, and "Invite member" only shows for
  admins.
- **Dashboard ↔ canvas round-trip** — your personal canvas now has a
  "Dashboard" button to get back, matching the dashboard's view toggle.

## [2026-05-21] — Canvas motion overhaul + issues-page polish

### Added

- **Canvas present mode** — turn frames into slides with eased
  fit-to-frame, a laser pointer with trail, and arrow / space / Esc /
  Home / End navigation.
- **Images on canvas** — paste, drag-drop, or pick a file to drop an
  image onto the board; backed by the attachment system.
- **Canvas drawing polish** — diamond shape, hand-drawn "sketch"
  rendering, five arrowhead styles (either end), fill color, and an
  adjustable corner radius.
- **Agent profile icons in comments** — agent replies now show the
  agent's own avatar instead of a generic bot glyph.
- **Issue hover previews** — hover an issue title in the list to peek
  status, priority, project, and assignees.
- **Snooze indicator** — snoozed issues now show a "Snoozed" chip in
  the list.

### Changed

- **Smoother canvas camera** — fit / reset / present transitions ease
  instead of snapping, pan carries inertial momentum, and remote
  cursors glide to their positions.
- **Composer discoverability** — the comment and chat composers now
  advertise @-mentions and `/` commands (placeholder + a persistent
  hint).
- **Debounced issues search** — searches settle for 300ms (with an
  in-input spinner) instead of firing on every keystroke.
- **Broader canvas undo/redo** — now covers create + delete for every
  element type, not just moves.

### Removed

- **Duplicate "Personal" sidebar item** — the personal canvas is now
  reached from the Dashboard's List / Canvas view toggle.

## [2026-05-20] — Orchestration loop, on-canvas authoring, crews

### Added

- **Goals → plans → execution** — define a Goal, auto-decompose it into
  an execution plan, and have steps dispatched, judged, and retried
  automatically within cost / time budgets.
- **On-canvas authoring** — create issues and notes directly on a
  canvas, with smart alignment guides, a floating selection inspector,
  and sticky-note / comment-pin / stamp primitives.
- **Agent crews** — group agents into crews with per-member roles.

### Changed

- **Faster nested-frame canvas drags** — the frame drag cascade is now
  linear in descendants.

## [2026-05-19] — Chat streaming + safer destructive actions

### Added

- **Streaming agent chat replies** — agent responses now stream
  token-by-token in the chat surface.
- **Canvas entity hover previews** — hover linked issues / notes on a
  canvas for a quick summary.

### Changed

- **Confirm modals** guard destructive actions; canvas render
  performance improvements.

## [2026-05-18] — First-class Chat workspace

### Added

- **Chat surface** — a dedicated per-agent chat workspace with file
  attachments and rich markdown rendering.

## [2026-05-04] — Pomodoro, email-ingest, today widget, what's new

### Added

- **Today widget** on the dashboard — active-sprint countdown,
  next-7-day due-soon list (max 5), Mon–Sun week peek strip.
- **What's New rail** + `/w/[slug]/whats-new` page sourcing this
  CHANGELOG via the `system.changelog` tRPC proc.
- **Quick-save filter as view** — the `/issues` saved-view bar now
  surfaces an inline "Save changes" / "New view" pair when the
  current filters match an existing view, plus the standard
  "Save view" when they don't.
- **Pomodoro break prompts** — opt-in toggle on `/settings/account`;
  when a timer runs and the toggle is on, the time-tracker fires a
  toast at the configured cadence (default 25 / 5 minutes).
- **Email-to-issue ingest** — `/api/ingest/email` accepts HMAC-signed
  JSON and creates an issue (+ optional attachments). Endpoint is
  off by default; admins enable + rotate the secret in
  `/settings/integrations`. No upstream provider wiring yet.

## [2026-05-04] — Watch, journal, slash commands

### Added

- `IssueWatcher` model + `issue.watch / unwatch / watchers / watching`
  tRPC + matching MCP tools.
- Daily Journal as a Note variant (`Note.kind = JOURNAL`, unique per
  user/date) with `notes.todayJournal` / `notes.listJournal` MCP.
- Slash commands in QuickCreate + comment composers
  (`/assign /due /label /priority /project /watch /unwatch`) plus
  `issue.applyCommands` for after-the-fact application.

### Changed

- Inbox grew a Watching section between Snoozed and Sprint burn.

## [2026-05-03] — Quick Notes, attachments expansion

### Added

- Quick Notes widget on the dashboard with auto-save + ⌘⏎ shortcut.
- Expanded attachment MIME allowlist (HTML, CSV, XML, JSON, YAML,
  audio/video containers); external link attachments via
  `attachments.link`.

### Fixed

- Project page scroll containment regression.
- Per-agent dispatch shim no longer pages every workspace event.

## [2026-05-02] — UX revamp wave (overview → triage)

### Added

- Pinning on issues / projects / saved views (`Pin` table) and
  pinned-recents in the sidebar.
- Bulk-actions bar on `/issues` and a workspace-wide command
  palette.
- Inbox / Agents / Stalled surfaces gained dedicated revamps with
  tooltips and density-aware text utilities throughout.

## [2026-05-01] — Auto-transition on agent assignment

### Added

- `Workspace.startedStatusId` — server-side auto-transition into a
  configured IN_PROGRESS status when an agent is assigned.
- `statuses.list` MCP tool so daemons can resolve transitions
  client-side.

## [2026-04-28] — Agent awareness, runtime primitive, forge CLI

### Added

- 10 new MCP tools for agent awareness:
  `comments.list`, `chat.getThread`, `context.bundle`,
  `attachments.getInline`, and others.
- `Runtime` primitive (LOCAL_DAEMON / REMOTE_HTTP / CLOUD) plus
  token-usage columns on `AgentRun` and a unified agent-activity
  timeline.
- `forge` CLI + local daemon (`forge login / daemon / runtimes /
agents / issues`) with a real Claude Code adapter.

## [2026-04-27] — Mission Control notifications

### Added

- Actionable Mission Control notifications and a tightened agent
  presence panel.

## [2026-04-26] — VitePress docs

### Added

- In-app docs viewer at `/w/[slug]/docs` plus the static
  VitePress site shipped at `/docs/`.

## [2026-04-25] — SLAs, watchdogs, push dispatch

### Added

- Required-ack window + per-issue SLA enforcement (workspace-level
  toggles + watchdog sweep).
- Push-dispatch model — webhooks from Forge to agent runtimes
  replaced the legacy heartbeat cron.
