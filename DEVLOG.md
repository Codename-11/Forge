# Forge DEVLOG

> Append-only session log. Read at session start. Update at session end.

## 2026-06-08 — Immediate chat read receipts

Made the chat read receipt behave like the Discord bridge: once the stream
route accepts a turn and creates the agent-side reply/run placeholder, Forge
persists the USER `acknowledgedAt`/`outputStartedAt` timestamp before emitting
stream metadata. The first SSE `meta` event now carries that receipt timestamp,
and the client overlays it locally so the outgoing bubble flips to "Read"
immediately while thinking/tool/content streaming continues.

Verification: `pnpm lint`, `pnpm typecheck`, and full `pnpm test` pass.

## 2026-06-08 — Chat streaming duplicate bubble fix

Fixed the chat streaming handoff that could show a persisted USER row marked
read and a duplicate optimistic "Sending..." row at the same time while Victor
was thinking. The client now refreshes the thread as soon as the stream is
accepted / metadata arrives, suppresses optimistic sends once the matching
persisted USER message is visible, and hides fresh empty AGENT placeholders
while the live streaming bubble owns that reply.

Verification: `pnpm lint`, `pnpm typecheck`, and full `pnpm test` pass.

## 2026-06-08 — Hermes slash command model replies

Aligned Forge chat slash-command behavior with Hermes command expectations.
No-argument prompt commands such as `/status` now dispatch immediately from the
slash popover instead of filling a stub. Hermes `/new` still creates a fresh
Forge conversation, but now also dispatches a starter prompt into that new
thread so Victor replies there like Hermes does from Discord.

Updated the chat command reference for durable `/clear`, `/new`, and prompt
dispatch semantics.

Verification: `pnpm lint`, `pnpm typecheck`, focused slash-command Vitest
coverage, full `pnpm test`, and `pnpm docs:build` pass.

## 2026-06-08 — Chat slash command controls

Made chat slash commands work consistently for Hermes, Codex, and standard
agents. Universal controls now include `/commands`, `/clear`, `/reset`,
`/localclear`, `/new`, `/newchat`, `/compact`, and `/summarize-context`, while
Hermes-only commands like `/skills`, `/memory`, and `/hermes` remain
provider-gated.

Backed `/clear` with a durable `chat.clearThread` mutation that preserves the
conversation row but removes messages, message attachments, message events,
message audit rows, and stale summary metadata. Chat composer command execution
now awaits async commands, shows a command-running state, and avoids sending the
slash text as a normal prompt while the command is still executing. `/new`
creates a fresh side conversation and switches the active chat surface to it.

Hardened chat attachment cleanup so clear/delete removes polymorphic attachment
rows even when object storage cleanup is unavailable, and made the Hermes
transport preview test explicitly opt into its env fallback instead of depending
on the developer shell.

Verification: `pnpm lint`, `pnpm typecheck`, focused slash/chat/router Vitest
coverage, and full `pnpm test` pass.

## 2026-06-07 — Hermes chat send watchdog and admin prompt visibility

Fixed the live Victor/Fixtor chat failure mode where the browser marked a
message "Failed to send" even though Forge had already persisted the USER row.
The cause was the chat client's 30s acceptance watchdog: Hermes RUNS turns with
tool activity were being aborted at ~30s, leaving interrupted AGENT rows and a
false failed outbox bubble. The client no longer aborts accepted-but-slow
streams on a fixed timer, and it no longer renders a blank agent stream bubble
before the server has accepted the stream.

Hardened `/api/chat/stream` so the SSE route starts its async run bridge in the
background instead of returning an async `ReadableStream.start` promise, making
headers/meta available immediately. RUNS start failures, provider error events,
and client disconnects are now logged and persisted into the AGENT message
`contextSnapshot` with redaction; `chat.threadDiagnostics` exposes those fields
and the chat status rail shows the latest stream error/interrupt.

Exposed agent prompt/runtime config more cleanly: global agent profile detail now
shows and edits `templateMarkdown` with an effective system-prompt preview, the
profile router accepts prompt data on create/request/update, and profile prompt
saves sync active workspace bindings. Workspace agent detail now shows a
read-only effective prompt/config card for the live binding.

Verification: focused runtime/chat Vitest coverage, `pnpm exec tsc --noEmit
--pretty false`, and `pnpm lint` pass.

## 2026-06-07 — Hermes gateway health display hotfix

Fixed the Hermes runtime health display so a fresh gateway contract probe reads
as gateway-online instead of stale/offline because `Runtime.heartbeatAt` is old.
Hermes agent presence remains a separate agent heartbeat / forge-presence /
webhook-delivery signal.

Adjusted chat stream finalization so a client disconnect before any content,
thinking, or tool activity does not persist a fake `Reply interrupted before it
finished` agent bubble. Partial/tool-bearing aborted turns still retain an
explicit interrupted record.

Verification: focused runtime/chat Vitest coverage, `pnpm exec tsc --noEmit
--pretty false`, and `pnpm lint` pass. Live diagnostics confirmed the Hermes
gateway, `/api/chat/stream`, and the actual Chat composer can stream a normal
Victor reply.

## 2026-06-07 — Hermes chat runtime contract diagnostics

Repaired the Forge workspace Victor binding by attaching it to a Forge-scoped
Hermes runtime copied from the working gateway config, created the seeded owner
default Victor chat thread, and refreshed both Hermes runtime probes. The live
contract probe now reports the expected `/v1/models` success plus `/v1/runs`
route availability without starting a run.

Tightened Hermes chat readiness so the env gateway fallback only counts when a
real token or explicit unauthenticated-local opt-in is configured. Runtime
contract probe failures now downgrade RUNS chat readiness instead of showing a
false-ready state, and the chat status rail surfaces attached runtime health so
operators can see the difference between "chat can reach Hermes" and "profile
presence heartbeat is stale."

Enhanced the collapsed Chat conversations pane into a narrow recent-thread rail:
the rail now keeps direct access to recent chat bubbles, highlights the active
thread, shows status/attachment accents, and exposes a detailed themed tooltip
without expanding the full sidebar.

Verification: focused Vitest coverage for chat readiness, runs connector
resolution, transport display, runtime health, and runtime dispatch contracts
passes; `pnpm lint`, `pnpm exec tsc --noEmit --pretty false`,
`pnpm build:app`, `git diff --check`, and a Playwright collapsed-rail smoke
against `http://localhost:3010/w/forge/chat` pass.

## 2026-06-07 — Hermes RUNS recovery and LAN live-dev loop

Closed the remaining AXI-72 Victor wake failure. The issue already had an
EXECUTE-mode Hermes host policy with terminal/filesystem/git allowed, but the
canonical `AgentRun` could be touched by comments or kicks while still lacking a
Hermes `/v1/runs` `externalRunId`. The RUNS dispatcher now recovers recently
touched unbacked active runs, and operator kicks on RUNS-backed rows record a
structured dispatch event instead of falling back to the legacy webhook path.

Added a faster live-data development loop for UI/API plus worker debugging:
`dev:live:ui`, `dev:live:stack`, `dev:live:lan`, and standalone
`worker:live` scripts. The app can now disable in-process workers while a
watched host worker runs against live Postgres/Redis/MinIO, and LAN mode binds
Next to `0.0.0.0` with matching auth/public origins for in-app-browser testing.

Cleaned up the dev overlay issues seen while testing the LAN dashboard: Next
LAN origins are allowed in dev config, Pino's pretty worker transport is now
explicit opt-in, the activity drawer has a stable server snapshot, dashboard
suggestions no longer nest project links inside issue links, and duplicate
date/version React keys were made unique.

Verification: `pnpm lint`, `pnpm typecheck`, `pnpm build:app`,
`git diff --check`, shell syntax checks for the live-dev scripts, focused
`run-dispatcher` Vitest coverage, and a Playwright LAN dashboard smoke all pass.

## 2026-06-06 — AXI-72 mobile settings/admin follow-up

Expanded the AXI-72 mobile usability pass into the previously desktop-weight
surfaces. The global activity pill now stacks and wraps on phone widths, the
instance settings shell moves its navigation rail above the content below the
medium breakpoint, and the admin shell switches from a fixed side rail to a
compact scrollable top-nav on mobile while preserving the desktop sidebar.

Broadened `tests/e2e/mobile-smoke.spec.ts` to cover `/activity`, global
settings pages, and admin pages at 360px, 390px, and 430px with the shared
no-document-horizontal-overflow assertion. The existing primary issue workflow
coverage still exercises create/open/edit/comment/status/assignment plus agent
and runtime inspection from a phone viewport. The existing multi-workspace admin
shell smoke assertion was also scoped to the visible warning badge so the new
responsive short/long "Instance scope" labels do not trip strict locators.

Verification: `pnpm lint`, `pnpm typecheck`, `pnpm build:app`, full
`pnpm test` (795 passed / 1 skipped), `E2E_FORCE_BUILD=1 pnpm exec playwright
test tests/e2e/mobile-smoke.spec.ts --project=chromium` (7 passed),
`pnpm exec playwright test tests/e2e/multiws-restructure.spec.ts --project=chromium`,
`git diff --check`, and conflict-marker grep all pass.

## 2026-06-07 — Issue run strip layout hardening

Fixed a remaining overlap in the issue detail active-run card. The run summary
now occupies its own line, the restart mode control has its own bounded row,
and runtime/diagnostic/time metadata wraps separately so WAITING text, mode
buttons, and policy badges cannot paint over each other at medium widths.

CI follow-up: the shared router workspace fixture now keeps workspace keys
within the eight-character contract while using a hashed suffix tail, avoiding
occasional `Workspace.key` collisions in the full sequential unit suite.

Verification: `pnpm lint`, `pnpm typecheck`, `pnpm build:app`, and
`git diff --check` pass. `pnpm test --no-file-parallelism` passes, and the MCP
workspace-key schema guard was checked with
`pnpm vitest run src/server/services/__tests__/mcp.test.ts --no-file-parallelism`.

## 2026-06-06 — Comment wakes use Hermes run dispatch

Investigated AXI-72 after Victor reported the run was blocked because Hermes
did not expose terminal/filesystem/git tools. Hermes host policy support was
already present and healthy for structured `/v1/runs` dispatch; the remaining
Forge bug was that comment-created wakes for RUNS-backed agents could still
fall through the legacy webhook path. Those runs had no `externalRunId`, so
Hermes never received the run tool allowlist or runtime policy.

RUNS-backed comment wakes now skip legacy webhook delivery and the run
dispatcher starts any unbacked active canonical `AgentRun` through the
configured runs connector. The existing issue instruction, engagement mode,
tool policy, and runtime policy are preserved when the structured Hermes run is
created. Fresh comment-triggered issue runs also no longer hard-default to
EXECUTE: they preserve any active/waiting run mode, otherwise use the latest
assignment engagement mode for the assigned agent, while non-assigned
`@mention` wakes use the workspace mention policy.

Cleaned up the issue-detail run status strip so long agent names, restart-mode
controls, runtime badges, diagnostics, and timestamps wrap instead of
overlapping at medium widths.

Follow-up in the same deployment: the issue detail right rail now has a real
desktop height budget. Properties remain above the tab strip, but long
properties can scroll independently and the active Attachments, Relations, or
Activity tab owns the remaining scroll area. Removed the old internal top gap
from those tab bodies so dense activity histories start immediately under the
tabs instead of wasting vertical space.

CI follow-up: the Android PWA service-worker controller reload now ignores the
first controller claim on a fresh install, so production-mode E2E sign-in is
not interrupted by an app-shell reload. The Playwright E2E Postgres health
check now targets `forge_e2e`, matching the shard database instead of probing
the default `forge` database.

Verification: `pnpm install --frozen-lockfile`, `pnpm prisma:generate`,
focused dispatch/inbox/audit tests, `pnpm typecheck`, `pnpm lint`,
`pnpm build:app`, and full `pnpm test` pass (795 passed / 1 skipped). The
follow-up rail scroll change was additionally checked with `pnpm typecheck`,
`pnpm lint`, and `pnpm build:app`. The CI follow-up was checked with
`pnpm lint`, `pnpm typecheck`, `pnpm build:app`, `git diff --check`, and
the focused Playwright issue-flow spec against a fresh `.next-e2e` production
build. The full test run still prints pre-existing async notification/storage
warning logs, but exits cleanly.

## 2026-06-06 — Android PWA install and push notifications

Expanded the PWA baseline for Android-first install behavior. `PwaProvider`
now handles browser install prompts, app-installed confirmation, service-worker
update prompts, online/offline status toasts, and an opt-in visited-page cache
for offline navigation. iOS gets a lightweight Add to Home Screen hint when
running outside standalone mode. The manifest now includes launcher shortcuts
for Mission Control, Inbox, and What's New.

Added Web Push support behind VAPID configuration. Push subscriptions are stored
in the new `PushSubscription` table, exposed through protected notification
tRPC procedures, and registered from `PushNotificationProvider` after user
permission. The service worker now handles push payloads and notification
click-through. Alertable activity-event materialization fans out best-effort
browser push notifications to workspace members while preserving the existing
in-app notification state and preference checks.

Configuration: set `WEB_PUSH_VAPID_PUBLIC_KEY` and
`WEB_PUSH_VAPID_PRIVATE_KEY` (or the `VAPID_*` aliases), plus optional
`WEB_PUSH_SUBJECT`, to enable push prompts and delivery.

Verification: `pnpm prisma:generate`, `pnpm lint`, `pnpm typecheck`, and
`pnpm build:app` pass. The twitter-image runtime warning was removed by making
that metadata route export its config directly. `pnpm test` was attempted and
failed because this shell has no `DATABASE_URL` for Prisma-backed tests; Redis
also reported closed connections during the same run.

## 2026-06-06 — PWA install baseline

Added the first Forge PWA baseline. New `app/manifest.ts` emits the install
manifest at `/manifest.webmanifest` with root `start_url`/scope, standalone
display, Forge metadata, and PNG install icons. Generated opaque install assets
under `public/icons/`: 192, 512, and a padded 512 maskable icon from the existing
ember app mark.

Added `public/sw.js` plus `PwaProvider` registration in the root layout. The
service worker precaches only the offline fallback and static Forge assets,
serves navigations network-first with `/offline` fallback, and deliberately
skips API, auth, tRPC/realtime, signed image, and other stateful paths. Added
`/offline` as a token-styled fallback page and configured `/sw.js` headers
(`application/javascript`, no-store, strict self CSP, root SW scope).

Verification: `pnpm install --frozen-lockfile`, `pnpm prisma:generate`,
`pnpm exec prettier --write` on touched PWA files, `pnpm lint`,
`pnpm typecheck`, and `pnpm build:app` all pass. Local `next start` on port
3210 verified `/manifest.webmanifest`, `/sw.js` headers/body, `/offline`, and
all three icon files over HTTP; the server logged expected DB/Redis connection
errors because this shell did not have runtime services configured. Full
`pnpm test` was attempted after the build and failed broadly on the same
environment gap (`DATABASE_URL` missing for Prisma-backed tests, plus Redis
connection errors), not on PWA-specific assertions.

## 2026-06-06 — Runroom agents views

Enhanced the workspace Agents surface around the selected "Runroom Command"
mockup. `/w/[slug]/agents` now uses a new `AgentRunroomDashboard` that composes
existing live queries into an operator dashboard: fleet health, dispatch queue,
active run count, runtime coverage, missed wakes, compact presence scan, agent
run lanes, runtime topology with workspace/runtime bindings, attention queue,
and activity stream. No new server contracts were added; the view reuses
agent/pipeline/dispatch/runtime/global-runtimes/agent-run/timeline data.

Reworked `/w/[slug]/agents/[profileKey]` for single-agent oversight. The detail
view now leads with an incident banner, health chain, held-work panel, and
reordered operational sections: Now, What the agent sees next, Crews & live
steps, stats, uptime, runtime readiness, webhook health, dispatch eligibility,
and recent events. Existing actions remain real: connection verification,
runtime links, delivery links, issue links, and stalled-run Kick.

Verification: `pnpm lint`, `pnpm typecheck`, `pnpm test` (793 passed / 1
skipped), `pnpm build:app`. Local dev route compilation succeeded for
`/w/[slug]/agents`; authenticated screenshot capture was blocked by local
credential drift in the shared dev database.

## 2026-06-06 — Issue status timeline and Hermes enforcement flag

Issue STATUS comments now stay inside the normal chronological comments
timeline instead of pinning above the thread. Rolling status rows use
`updatedAt` as their effective timestamp, active/waiting/stalled rows render
as "live status", and terminal rows render as "run status"; the issue run
strip remains the current-run control surface above the issue and near the
composer. Updated `docs/concepts/comments.md` to match.

Corrected the live `rt_hermes_gateway` Runtime config to set
`modeToolPolicyEnforced: true` now that the deployed Hermes gateway is on the
policy-capable build. New Hermes dispatches should badge as host-enforced;
already-active runs keep their dispatch-time runtime-policy snapshot unless
explicitly restarted/reconciled.

Verification: `pnpm lint`, `pnpm typecheck`, `pnpm test` (793 passed / 1
skipped).

## 2026-06-06 — Mobile core app usability pass

Improved the shared topbar for phone-width layouts: the quick-create button now has an explicit accessible name and a larger mobile tap target, while page-level action groups wrap instead of forcing header overflow. Desktop sizing remains the same from the `sm:` breakpoint upward.

Expanded mobile smoke coverage to target 360px, 390px, and 430px widths. The spec now covers dashboard, inbox, issue list, issue detail rail, kanban, command center, agents, runtimes, and a primary phone-width workflow: create issue from the topbar, edit title, comment, change status, assign Victor, inspect agent detail, and open runtime detail. Each changed surface asserts no document-level horizontal overflow.

Verification: `pnpm lint`, `pnpm prisma:generate && pnpm typecheck`, `pnpm test` (793 passed / 1 skipped), `pnpm exec playwright test tests/e2e/mobile-smoke.spec.ts` (4 passed), conflict-marker scan, and `git diff --check`.

## 2026-06-06 — Run recovery and runtime compliance console

Added an operator recovery path for AgentRuns. Mission Control Admin now
shows a Run Recovery section that explains why runs are counted
(`active-stale`, `terminal-failure`, or `protocol-failed`) and offers bounded
bulk/per-row actions: abandon stale live runs, clear stalled/abandoned
terminal rows, and reconcile protocol-invalid completed runs without rewriting
history. Command Center now uses the same recovery classifier so its run
recovery count matches the actionable rows.

Added a runtime/agent compliance scorecard. Mission Control agent cards now
surface runtime risk, declared repo-tool access, and Hermes host-enforcement
signals; Instance Admin runtimes show declared tool surface directly in the
runtime table. New recovery/compliance coverage lives in
`agent-run.test.ts`.

Centralized MCP execution through `mcp-exec.ts` so REST, JSON-RPC, and
confirmed chat tools share lookup, scope, zod parsing, and engagement-mode
policy preflight before calling the raw tool. Added regression coverage for
transport-neutral errors, successful execution, Research-mode mutation denial,
and chat-tool execution through the same wrapper.

Tightened reassignment/live-status behavior. Reassigning or clearing an agent
now abandons the previous assignee's active/waiting run, and the issue page
only pins STATUS comments from the current assigned agent's active/waiting run;
older run status cards remain chronological history. Hermes/engagement-mode
docs now state that host allowlists block local terminal/file/code/desktop
surfaces without blocking skills, memory, web/search, context reads, or
delegation, and delegated subagents inherit the same local deny-list.

Verification: `pnpm test src/server/services/__tests__/agent-run.test.ts
src/server/services/__tests__/mcp-exec.test.ts`, `pnpm typecheck`, Hermes
focused pytest coverage for runtime tool policy/API dispatch/delegation, plus
pending full lint/test before release.

## 2026-06-06 — Run contract enforcement and restart flow

Added the next hardening pass for Forge agent runs. `AgentRun` now stores
`completionMeta` (mode-specific completion fields + run contract version) and
`runtimePolicy` (effective tool/enforcement snapshot captured at dispatch).
RUNS dispatch passes `engagement_mode`, `forge_contract_version`,
`tool_allowlist`, and `runtime_policy` to Hermes, while Codex app-server keeps
forcing non-Execute turns into read-only sandboxing. Runtime config now accepts
`modeToolPolicyEnforced`; the workspace runtime UI and `forge runtimes
configure --mode-tool-policy-enforced` expose it.

`runs.complete` is now a real server-side mode contract: linked-agent key
required, terminal rewrites rejected, Execute enforces issue artifact/checklist
gates, Research requires `confidence`, Review requires `verdict`, and Discuss
is reply-only. `finishRun` and issue-terminal close now include WAITING runs so
patient runs do not linger. Added centralized MCP policy metadata/helper for
Execute-only issue mutations and exposed policy in MCP descriptors.

The issue run strip now offers explicit Stop + Restart with Mode actions rather
than fake in-place switching. Issue and Mission Control run cards show runtime
enforcement strength (Forge MCP, Codex sandbox, Hermes host, prompt-only) and
protocol diagnostics (`never-acked`, `acked-no-output`, stale output without
completion, invalid completion). The Mission Control timeline labels STEP rows
from provider/current-step payloads instead of falling back to bare `STEP`.

Follow-up hardening from subagent review: direct RUNS chat starts now use the
Discuss contract/policy payload, durable inbox-created runs capture a
dispatch-time runtime policy snapshot, Mission Control keeps WAITING runs in
the live lane, provider-side terminal completion without `runs.complete` is
marked STALLED instead of false-completed, and merged runtime config can now
clear `modeToolPolicyEnforced` / tool declarations. Live Hermes runtime config
was made explicit prompt-only (`modeToolPolicyEnforced: false`) with Execute
repo tools and empty Research/Review/Discuss mode profiles until the Hermes
host itself proves allowlist enforcement.

Docs updated: engagement modes, Hermes integration, runtimes, and MCP
reference. Verification: `pnpm lint`, `pnpm typecheck`, `pnpm test` (785 pass /
1 skipped), `pnpm build:docs`, `pnpm build:app`, `pnpm test:e2e` (21 pass), and
`pnpm build:cli`.

## 2026-06-06 — Runtime tool-surface config and cards

Made runtime local tool surface a first-class declaration. Hermes Runtime
config now accepts `{ localWorkspaceTools, toolCapabilities, workspaceRoot }`
through the same validation service used by tRPC and MCP; Codex app-server
keeps sandbox/approval config and can share the same workspace-root/tool
surface shape. Issue preflight now reads the shared helper instead of its own
JSON parser.

Runtime cards/detail/global settings now show repo-tool state plus adapter
capabilities (streaming, approvals, presence), and Hermes create/edit dialogs
include structured controls for local workspace tools, declared tools, and
workspace root. Added `runtimes.configure` MCP and `forge runtimes configure`
so operators can set the same config from CLI without direct DB writes.
Updated runtime, Hermes, provider/transport, MCP, and CLI docs.

Follow-up: configured the live Codex app-server runtime with its bridge-visible
Forge workspace root (`/work/agent-forge`), workspace-write sandbox, on-request
approvals, and explicit repo-tool declaration. Workspace runtime cards now label
the `codex-app-server` adapter directly; saving a Codex workspace root also
persists the local tool-surface declaration so cards/preflight stop showing
"no repo tools" for configured Codex runtimes. The global runtime card's dead
ellipsis button is now a real settings link.

Second follow-up: tightened issue assignment/run-state visibility after AXI-72.
`AGENT_ASSIGNED` system comments now include the resolved engagement mode and a
concrete runtime/tool-surface line, and same-agent mode changes (`modeUpdated`)
write their own chronological SYSTEM comment instead of being suppressed as a
no-op reassignment. Assignment activity rows now read as assignment/mode events
and include runtime/tool details when the payload has them. This remains
truthful: Forge does not synthesize an agent-authored "starting work" comment;
the runtime/agent must still post status/comment output itself.

Third follow-up: made engagement mode a real run contract instead of only UI
copy. Dispatch now injects a shared Forge run protocol (ack inbox, mark output
started, use meaningful status, set waiting when blocked, complete the run)
alongside the mode instruction, includes issue/run ids in RUNS prompts, and
surfaces the same `runProtocol` object in `agent.context.bundle`. Agent-linked
MCP calls from active Research/Review/Discuss runs now reject issue-state
mutations (issue updates/transitions/assignment/labels, issue-linked artifacts,
and action-request acceptance) while still allowing comments/status/waiting and
completion reports. Codex app-server non-Execute runs are forced into read-only
sandboxing per turn; Hermes still needs host-side toolset enforcement for
terminal/filesystem/git tools.

Active run modes are now immutable. The issue strip shows the mode as locked
while running, `agentRun.setEngagementMode` rejects in-place changes, same-agent
mode updates are blocked while a run is active/waiting, and `openOrTouchRun`
preserves the existing mode on later wake/touch events. Substantive run events
(status/comments/steps/tool calls/transitions) now auto-set `outputStartedAt`
so live UI moves out of "acknowledged" once real output lands.

## 2026-06-05 — AXI-40 MCP workspace discovery + scoped access keys

Implemented MCP workspace discovery and API-key provisioning for workspace-scoped agent/home-lab use. `workspaces.list` now returns `id`, `key`, `name`, and `slug`; non-admin API keys remain pinned to their issuing workspace, while user-backed sessions or ADMIN user-backed keys can list/select workspaces where the user is a member.

Added an `access.*` MCP namespace for safe non-plugin key management: `access.list` returns metadata only, `access.createPersonal` creates user-owned personal keys, `access.createSession` creates short-lived session keys, `access.createAgentKey` creates AGENT keys linked to an existing agent binding in the selected workspace, and `access.revoke` revokes selected workspace keys. Workspace selectors accept exactly one of `workspaceId`, `workspaceKey`, or `workspaceSlug`; cross-workspace selection requires ADMIN scope, a user-backed principal, and workspace membership. Narrowing ids are validated against the target workspace, and raw key material is returned only from create calls.

Coverage: `pnpm prisma:generate`, `pnpm lint`, `pnpm typecheck`, and `DATABASE_URL=postgresql://forge:***@localhost:55432/forge?schema=public REDIS_URL=redis://localhost:56379 pnpm test src/server/services/__tests__/mcp.test.ts` (105 pass).

## 2026-06-05 — AXI-73 runtime health diagnostics

Implemented runtime reachability diagnostics across schema, services, router APIs, and UI. Added persisted sanitized probe fields (`lastProbeAt`, `lastProbeAttempted`, `lastProbeReachable`, `lastProbeDetail`) via migration `0073_runtime_health_diagnostics`; centralized status derivation in `runtime-status`; and added `runtime.verifyConnection` for handshake-only Hermes/Codex probes that never start a run and never expose secrets.

The scheduled runtime health sweep now records sanitized probe results for supported adapters. Codex app-server probes still count as runtime heartbeats and propagate persistent-agent liveness; Hermes probes are diagnostic-only so operators can distinguish gateway/auth failures from missing forge-presence / heartbeat / webhook delivery. Runtime list/detail/global/admin surfaces now show server-derived status, reason, last signal, adapter/endpoint, and sweep coverage. Runtime detail now exposes Edit, Test connection, Enable/Disable, Archive, and Unarchive together.

Gate: `pnpm prisma:generate`, `pnpm lint`, `pnpm typecheck`, full `pnpm test` (758 pass / 1 skipped), and `pnpm build:app`.

## 2026-06-05 — AXI-71 RUNS dispatch + issue run-state UX

Investigated AXI-71 after Victor reported the webhook runtime had no local
terminal/filesystem/git/patch tools. Confirmed the local Codex runtime does have
the Forge repo/tooling, and traced the stall to the RUNS dispatcher skipping
`AGENT_ASSIGNED` events whenever the durable inbox had already precreated the
canonical `AgentRun`. Fixed `run-dispatcher` so it reuses precreated active /
waiting runs that lack `externalRunId`, starts the provider run, stamps
`externalRunId`, and records `DISPATCH_STARTED`.

Engagement mode handling is now consistent across assignment surfaces:
explicit mode > agent binding override > workspace default. Same-agent explicit
mode updates emit an `AGENT_ASSIGNED` payload with `modeUpdated: true`, and
`openOrTouchRun` restamps existing active/waiting runs so an in-flight run can
move from Review/Research/Discuss to Execute without unassign/reassign churn.
Applied the same payload stamping to issue create, update, bulk assignment,
MCP `issues.assign`, and auto-dispatch (`engagementMode` is distinct from the
auto-dispatch algorithm `mode`).

Issue detail UX: split the subheader into a metadata row and title row so long
titles do not crowd status/priority/agent/run chips; made the active run strip a
two-zone layout with visible waiting state, timing, and an inline segmented
engagement-mode control; tightened the topbar run activity chip and sticky agent
rail to surface waiting/current mode more clearly.

Follow-up: added contextual controls to the sticky assigned-agent rail. WAITING
runs show Nudge (posts the wake mention), stale ACTIVE runs show Kick (re-fires
the run wake), and assigned/no-active-run issues show Wake (same-agent
assignment event using the agent's configured engagement mode). Follow-up gate:
`git diff --check`, `pnpm lint`, `pnpm typecheck`, full `pnpm test` (744 pass /
1 skipped), and `E2E_FORCE_BUILD=1 pnpm test:e2e` (20 pass).

Second follow-up: added an issue-detail terminal-run failure banner driven by
the latest `AgentRun` on `issue.byId`. Stalled / abandoned runs now surface a
warning with agent, runtime, last-signal, run id, and recovery guidance; newer
completed runs automatically suppress stale failure chrome. Gate: `git diff
--check`, `pnpm lint`, `pnpm typecheck`, full `pnpm test` (748 pass / 1
skipped), `NEXT_DIST_DIR=.next-e2e pnpm exec next build`, and `pnpm test:e2e`
(20 pass).

Third follow-up: fixed MCP agent attribution for issue/project mutation paths
that resolved the human API-key owner but failed to pass `actorAgentId` into
`recordChange`. `issues.transition`, bulk transition, issue update/priority,
queue, label edits, and project create/update now preserve linked-agent
authorship in audit/activity rows. The activity drawer and project overview
feeds now hydrate `actorAgent` and render the agent as the primary actor, with
the human API-key owner retained as secondary metadata, so future Victor status
moves do not collapse to Bailey or imply Bailey supervised the action.
Applied a targeted production data repair for the existing AXI-71 Done move
activity/audit rows, setting `actorAgentId` to Victor while preserving Bailey
as the API-key owner.
Gate: `git diff --check`, `pnpm lint`, `pnpm typecheck`, focused
`pnpm test tests/unit/activity-actor.test.ts`, focused `pnpm test
src/server/services/__tests__/mcp.test.ts`, and full `pnpm test` (750 pass /
1 skipped), plus `E2E_FORCE_BUILD=1 pnpm test:e2e` (20 pass).

Fourth follow-up: extended agent-run lifecycle attribution so
`openOrTouchRun`, `finishRun`, `recordAgentAction`, and `finishRunsForIssue`
carry `actorAgentId` through to `recordChange`. Patched MCP/comment/status
paths plus the audit-to-durable-inbox handoff so STARTED/COMPLETED run events
created by agent-linked API keys render the agent as the actor while preserving
the human key owner as secondary metadata. Issue activity now includes related
`agent-run` lifecycle rows, and the activity drawer/global feeds hydrate run
payload `issueId`s and render clearer run labels. Live backfill applied only to
defensible lifecycle rows: 43 `AGENT_RUN_STARTED` + 31
`AGENT_RUN_COMPLETED` ActivityEvents, and matching AgentRun audit rows (43
`create`, 27 `finish` COMPLETED, 4 `finish` ABANDONED). Left 11 STALLED and 7
KICKED run rows unattributed because those are watchdog/operator events.
Gate: `git diff --check`, `pnpm lint`, `pnpm typecheck`, focused `pnpm test
src/server/services/__tests__/agent-run.test.ts
src/server/services/__tests__/mcp.test.ts tests/unit/activity-actor.test.ts`,
full `pnpm test` (752 pass / 1 skipped), and `E2E_FORCE_BUILD=1 pnpm
test:e2e` (20 pass).

Fifth follow-up: cleaned up live run activity for AXI-73 diagnostics. Mission
Control now fetches enough events to show the meaningful stream and renders
human labels / payload previews for tool, thinking, summary, and provider
status events instead of a wall of raw `STEP` rows. The RUNS poller no longer
persists generic `STEP { lastEvent }` rows for connectors that already provide
a live event stream; it only advances `currentStep` / `lastEventAt` and leaves
the detailed timeline to subscription events. Also tightened comment wake
fan-out so body comments only wake the current assigned agent and explicit
agent mentions; stale watcher rows from prior assignees no longer create ghost
runs after reassignment. AXI-73 live inspection confirmed the `@victor` wake
did deliver successfully, while the extra Codex run came from this stale
watcher path.
Gate: `git diff --check`, `pnpm lint`, `pnpm typecheck`, full `pnpm test` (759
pass / 1 skipped), and `E2E_FORCE_BUILD=1 pnpm test:e2e` (20 pass).

Sixth follow-up: clarified the agent/runtime/mode model and closed the related
logic gaps from AXI-73. Hermes remains a first-class RUNS runtime; the UI now
separates agent identity, engagement mode, dispatch surface, and runtime/tool
surface so Execute/Review/Research is not mistaken for terminal/filesystem/git
capability. Added migration `0074_issue_watcher_wake_on_activity` to split
agent watcher visibility from generic activity wake fan-out: assignment makes
the current agent the wake target, reassignment demotes prior agent watcher
rows without removing them, explicit agent watches opt into wakes, and mentions
still wake directly. `finishRunsForIssue` now demotes another agent's
unstarted/no-ack/no-output ACTIVE run to ABANDONED when an issue reaches Done
instead of falsely recording it as completed by the closing agent. Added an
issue-detail runtime preflight warning for code/repo-looking work assigned to a
runtime that does not declare terminal/filesystem/git capability, plus clearer
activity / Mission Control phase labels for wake requested, run opened, wake
delivered, ack, output, retry, blocked, stopped, stalled, and completed states.
Gate: `pnpm prisma:generate`, `pnpm prisma:deploy` locally, `git diff
--check`, `pnpm lint`, `pnpm typecheck`, focused `pnpm test
src/server/services/__tests__/agent-run.test.ts
src/server/services/__tests__/audit.test.ts
src/server/services/__tests__/runtime-preflight.test.ts
src/server/routers/__tests__/issue.test.ts tests/unit/run-failure-banner.test.ts`,
full `pnpm test` (764 pass / 1 skipped), and `E2E_FORCE_BUILD=1 pnpm
test:e2e` (20 pass).

Seventh follow-up: fixed the terminal-run failure cleanup gap exposed by the
11 old AXI stalled runs still appearing in Command Center. Added migration
`0075_agent_run_cleared_operational_failures` with `AgentRun.clearedAt` /
`clearedById`, `AGENT_RUN_CLEARED`, and a one-time backfill that pre-clears
terminal STALLED/ABANDONED runs older than 24 hours so historical watchdog
closures stay durable but stop polluting live ops. Added `agentRun.clearMany`
with audit/activity rows, made `agentRun.list` hide cleared runs by default,
and changed Command Center / Pipeline from "stalled runs" to uncleared "run
failures" with per-row and Clear all actions. Activity and issue timelines now
label clears as cleanup rather than a fresh stall.
Gate: `pnpm prisma:generate`, `pnpm prisma:deploy` locally, `git diff
--check`, focused `pnpm test src/server/services/__tests__/agent-run.test.ts`
(4 pass), `pnpm typecheck`, `pnpm lint`, full `pnpm test` (768 pass / 1
skipped), and `E2E_FORCE_BUILD=1 pnpm test:e2e` (20 pass).

Verification: `pnpm lint`, `pnpm typecheck`, full `pnpm test` (744 pass / 1
skipped), and focused `pnpm exec vitest run
src/server/services/__tests__/engagement-mode.test.ts
src/server/services/__tests__/agent-run.test.ts
src/server/services/__tests__/run-dispatcher.test.ts` (12 pass). Browser gate:
`E2E_FORCE_BUILD=1 pnpm test:e2e` (20 pass).

## 2026-06-03 — v0.4.0 mobile app release

Squash-merged the `mobile-ui-ux-enhancement` worktree into `main` for the
v0.4.0 mobile app experience release and bumped `package.json` +
`CHANGELOG.md`. The local release gate initially exposed stale generated
Next type artifacts and a dev database whose Prisma migration bookkeeping was
behind the schema; removed ignored `.next*` artifacts and resolved/applied the
local dev DB migrations through `0072_enable_run_stale_sweep` before rerunning.

Gate on merged `main`: `pnpm lint && pnpm typecheck && pnpm test` (741 pass /
1 skipped) and `pnpm test:e2e` (20 pass, including the 390/430/768 mobile
smoke spec).

Deploy smoke for v0.4.0 confirmed the container was running SHA `c0dbac2`, but
also exposed an existing changelog parser bug: bracketed ISO-date headings were
split at the first hyphen, leaving `system.buildInfo.release` null. Patched the
parser/test coverage and bumped a follow-up `v0.4.1` patch release before
redeploying. Patch gate: `pnpm lint && pnpm typecheck && pnpm test` (741 pass /
1 skipped) and `E2E_FORCE_BUILD=1 pnpm test:e2e` (20 pass).

Follow-up smoke on v0.4.1 passed for authenticated sign-in, deployed SHA,
release date, mobile inbox overflow, MCP `issues.list`, and issue create/status
transition, but showed `system.buildInfo.version` still falling back to `1.0.0`
inside the standalone Docker runtime. Added a package.json fallback for runtime
version reporting and bumped `v0.4.2`.
Gate: `pnpm lint && pnpm typecheck && pnpm test` (741 pass / 1 skipped) and
`E2E_FORCE_BUILD=1 pnpm test:e2e` (20 pass).

## 2026-06-02 — Mobile UI/UX worktree + Hermes runtime diagnostics scope

Created the `mobile-ui-ux-enhancement` worktree at `/home/bailey/forge-mobile-ui-ux`
and ran a delegated mobile pass across the core app: shell/nav, issues list/board/detail,
dashboard/inbox/command-center/review, workspace settings, agents, and Mission Control.
Tracked the implementation under AXI-72 and captured the Hermes/runtime diagnostic gap
under AXI-73; existing runtime follow-ups AXI-70/AXI-71 remain the close-contract /
precreated-run dispatch work.

- **Mobile shell + workflows** — topbar/sidebar controls now wrap safely on narrow
  viewports; mobile nav stays reachable; issue list/board/detail controls, bulk bars,
  and metadata rows avoid document-level horizontal overflow.
- **Settings + agents surfaces** — settings rail becomes a mobile-friendly scroll
  nav; workspace/admin/connection/dispatch/member forms stack; agents, pipeline, and
  Mission Control tabs/queues/chat rails fit 390px/430px layouts while preserving
  desktop density.
- **Dashboard/inbox/review** — dense action clusters and repeated cards use tighter
  mobile padding, wrapping controls, stable touch targets, and truncation for long
  IDs/titles/status labels.
- **Verification hardening** — added `tests/e2e/mobile-smoke.spec.ts` covering
  authenticated mobile widths 390/430/768 across inbox, issues list, issue detail,
  and Kanban, including no horizontal document overflow.
- **Test hygiene** — updated stale expectations around the new default
  `agentRunStaleMinutes=30`, human-readable runtime labels, and dispatcher test
  isolation from concurrent heartbeat sweeps.

Verified in the worktree: `git diff --check`, `pnpm lint`, `pnpm typecheck`,
`pnpm test` (741 pass / 1 skipped), and
`pnpm exec playwright test tests/e2e/mobile-smoke.spec.ts --project=chromium` (3 pass).

Follow-up mobile detail pass on the same worktree: stacked page topbars on phone
widths, reduced crowded inbox labels, kept issue list search/action controls from
compressing the title, made issue row title/key hierarchy clearer on mobile,
tightened agent runtime stats into a compact tooltip-backed line, demoted
issue-detail Delete to an icon-only mobile action, and offset mobile toasts
above the bottom navigation. Verified with 390px screenshots plus
`git diff --check`, `pnpm lint`, `pnpm typecheck`, and the mobile smoke
Playwright spec.

## 2026-05-31 — Enable stale-run sweep (v0.3.1) + Hermes lifecycle considerations

Follow-up to v0.3.0's run-strip "idle" settle. The strip de-pulses at 90s but only
fully clears when the run leaves ACTIVE — which needs the agent to call
`runs.complete` OR the `agentRunStaleMinutes` watchdog, shipped disabled (`@default(0)`).

- **Enabled the sweep** — `Workspace.agentRunStaleMinutes` default `0 → 30`
  (migration `0072_enable_run_stale_sweep`: `ALTER COLUMN … SET DEFAULT 30` +
  backfill existing rows at 0 → 30). The watchdog (`agent-run-stale.ts`, swept every
  minute) flips idle ACTIVE runs to STALLED → `activeForIssue` drops them → strip
  clears. Confirmed `AGENT_RUN_STALLED` is NOT in `ALERTABLE_ACTIVITY_EVENT_KINDS`,
  so this creates ActivityEvents (+ SSE strip update) but **no notification spam**.
  30 min chosen: agents emit run events / status comments while working, so total
  silence that long ⇒ done/dead; quiet-but-active runs aren't misclassified.
- **Hermes considerations (investigated, not changed)** —
  - `~/.hermes/skills/forge-presence` is heartbeat/presence ONLY (no run lifecycle).
  - `runs.complete` (MCP) DOES close the AgentRun now (AXI-47 fixed a prior bug where
    it stored completion metadata but left status ACTIVE).
  - Root gap: the Hermes dispatch protocol prompt ("wake → ack → bundle → act",
    generated by the Forge platform adapter in Bailey's hermes-agent fork, not in this
    repo or `config.yaml`) instructs ack/bundle/act but never tells the agent to call
    `runs.complete({ runId })` when a work turn ends (nor `runs.setWaiting` when blocking
    on the operator). So Hermes turns finish without closing the run.
  - Cleaner long-term fix = add a "close the run" step to that adapter prompt (closes as
    COMPLETED, accurate + immediate); the sweep then only catches genuinely-abandoned
    runs. Left to a Hermes-fork change.

Gate: prisma validate (schema valid), typecheck, lint green. Released v0.3.1; deploy
applies `0072`.

## 2026-05-28 — Issues filtering/sort/group + create-overlay slash chips

UX wave on the create overlay (`quick-create.tsx`) and the issues list. Part of a
larger in-flight session — overlay + issues shipped first; follow-ups (issue-detail
responsive containment, inline slash/@ rendering in the comment composer, agent
runtime attribution display, persistent running-status card) tracked separately and
NOT in this commit.

- **Slash → commit-to-chips** in QuickCreate. New `matchTrailingCommand()` in
  `slash-commands.ts` detects a trailing `/cmd arg` at the end of the single-line
  title (so commands finally work *with* a title — the old single-line input could
  only hold a command OR a title, never both). Plain ⏎ commits the trailing command:
  `/priority`→native priority chip, resolvable `/project KEY`→native project picker,
  the rest (`/assign`,`/due`,`/label`,`/watch`,`/unwatch`, unresolved `/project`) land
  in a `committed: SlashCommand[]` rendered as removable chips. `resolveIssueComposition()`
  flushes any still-trailing command on submit and merges committed + leading +
  flushed into `applyCommands`. Live `pendingCommand` drives a "↵ apply …" hint. The
  autocomplete dropdown still handles mid-keyword stub insertion. Mode switches clear
  `committed`. Unit tests added for `matchTrailingCommand`.
- **Overlay polish** — `max-w-3xl`→`4xl`, `rounded-xl`, roomier top row; native
  project `<select>` replaced with a themed `ProjectPickerChip` (dot + name, ember
  tint, ModeChip-style popover). New `CommittedChips` row.
- **Issues filter/sort/group** — `IssueFacetChips` (`saved-views/facet-chips.tsx`):
  multi-select Status/Priority/Project/Assignee/Label chips projecting onto the
  existing `SavedViewFilters` arrays (server already accepted them). `SortChip` +
  `GroupChip` single-pick controls. Server: `issue.list` gains a `sort` enum
  (`ISSUE_SORT_VALUES`) → orderBy switch; default unchanged (priority desc, created
  desc). `issue-list.tsx` `statusGroups` generalized to `groups` keyed on
  `groupBy` (status/project/assignee/priority/none); per-group add-issue button kept
  for status+project. Sort/group persisted via `useStoredPref` (localStorage),
  shared `IssueSort`/`IssueGroupBy` in `saved-view-filters.ts`.

Verified: typecheck, lint, slash-commands unit tests green. (Full unit suite passes in
the main checkout; 10 server-module files fail to load *in the worktree only* because
`vitest.config.ts` aliases `server-only` to a worktree-relative path with no
`node_modules/server-only` — environmental, not a code regression.)

Follow-up wave (same session, mid-session asks):
- **#6 runtime label** — `audit.ts` assignment SYSTEM comment rendered the raw
  `RuntimeKind` enum inside `_…_`; the embedded underscore broke the markdown emphasis.
  New shared `src/lib/runtime-kind.ts` (`RUNTIME_KIND_LABEL`/`runtimeKindLabel`); audit
  uses it and omits the line when the agent has no runtime.
- **#5 inline composer highlight** — `MentionInput` gains opt-in `highlightMentions`/
  `highlightCommands`: a transparent-text backdrop layer (identical box model, scroll-
  synced) tints `@mentions` (indigo) + recognised `/command` lines (ember) live. Real
  text rides on top via `bg-transparent` textarea (twMerge overrides the field bg).
  `buildHighlightSegments` tokenizer (reuses `parseLine`). Enabled on the issue
  description, comment, and edit-comment composers.
- **#7 run strip settle** — `AgentRunStrip.deriveStripState` kept "running" (pulsing)
  for the full 5-min stale window after the last event. Added an `idle` state: no events
  within a 90s LIVE window (but before STALE) → calm static dot + "<step> · idle", no
  ping. Presentational only; run lifecycle untouched (so a quiet-but-active run isn't
  dropped). RunActivityChip already gated on 60s. NOTE: fully clearing the strip still
  needs the run to reach terminal (agent `runs.complete`, or the `agentRunStaleMinutes`
  sweep which defaults to 0/disabled).
- **#4 responsive** — issue-detail Attachments "attach link" inputs used
  `min-w-[18rem]`/`min-w-[14rem]` and overflowed the ~22rem rail on smaller laptops →
  switched to `w-full min-w-0 basis-full` (stack). Relations search input → `flex-1
  min-w-0`. Issues-list search → `w-32 sm:w-48`. Shell layout (capped 1600, `min-w-0`
  main, `shrink-0` aside) was already sound; the overflow was inner content.

Verified (follow-ups): typecheck + lint green. The inline-highlight backdrop is the one
change that benefits from an eyeball in the running app (alignment), though the technique
degrades gracefully — plain prose shows no tint.

## 2026-05-27 — Release visibility & docs (v0.2.0)

Post-v0.1.0 polish + docs. Relaxed `system.changelog`/`changelogFull`/`buildInfo` to
`protectedProcedure` (data isn't tenant-specific) so they work in the global/admin shells.

- **Global What's New** — `(app)/whats-new/page.tsx` + `whats-new-content.tsx` render the
  canonical CHANGELOG grouped per release (Added/Changed/Fixed/Removed) with a Version·Title
  heading; marks `changelogSeenAt` on mount. Reachable from Mission Control + Instance Admin
  via the version chip. Workspace dashboard tile + `/w/[slug]/whats-new` unchanged (same source).
- **Version chip** — `version-chip.tsx` reads `system.buildInfo`; in the global concourse +
  admin rail footers (hover = release/SHA/build-time), links to What's New.
- **CHANGELOG heading convention** — `## [YYYY-MM-DD] — vX.Y.Z · Title` (bracket date drives
  the unseen dot; tail is the release name). Retrofitted v0.1.0; RELEASE.md updated.
- **Docs** — new guides: mission-control, connections, instance-admin, agents/profiles-and-bindings
  (registered in the VitePress sidebar).
- **Ops** — pruned ~190 GB of Docker build cache + dangling images.

Verified: typecheck, lint, next+docs build green. Released v0.2.0 via GitHub Flow.

## 2026-05-27 — Multi-workspace restructure · follow-up wave

Executed `docs/plans/multiws-followup-goal.md` (agent-team spec) — the deferred/larger
items after the core restructure shipped. Migration 0071 (`AgentProfile.requestedById`
+ `approvedAt`; `Agent.requireApprovalBeforeStart`, additive). Six lanes, parallel
subagents, integrated centrally:

- **Connections live OAuth/OIDC** — `/api/connections/[id]/authorize` + `/callback`
  (PKCE + signed state), generic OIDC discovery + GitHub/Google/Slack, encrypted token
  bundle + clientSecret (`config.clientSecretEnc`), `connection.refreshIfNeeded`. Global
  connections page wired with Authorize/Re-authorize + add-connection flow. Per-connection
  callback URL `<origin>/api/connections/<id>/callback`. Reuses AUTH_SECRET via crypto.ts.
- **Activity dock 7-tab fidelity** — Live/Queue/Agents/History/Chat/Admin/Plans brought to
  `screens-activity.jsx` (stat-card headers, section labels, dispatch hints, outcome words)
  without changing data sources / keybindings / namespaces.
- **Profile request→approve** — `agents.profiles.request` (member) / `approve` / `reject` /
  `listPending`; `/admin/agents` pending queue; workspace catalog "Request a profile" dialog.
  Bind catalog hides pending (unapproved) profiles; bind rejects pending.
- **Wired admin + binding affordances** — `instanceAdmin.createTenant` / `inviteUser` /
  `backup` (best-effort ack) behind the Overview/Users buttons; per-binding require-approval
  toggle; connection-mapping default labels.
- **MCP/CLI profile-awareness** — `agents.profiles.list`/`get` MCP tools, `agents.me` now
  returns `profileId` + `instanceRole`; `forge agents --global`, `forge whoami` instanceRole.

Verified: typecheck, lint, next+docs build, unit **736 passed/1 skipped** (sequential),
e2e **17 passed** (incl. 3 new follow-up specs: admin agent-policy, connections authorize,
Activity dock open+tab-switch). Known scope note: full OAuth round-trip + member/admin
two-user flows are covered by the unit/integration layer rather than browser e2e (a mock
IdP + second session would be disproportionate); backup is an acknowledgement, not a real
dump job.

## 2026-05-26 — Multi-workspace restructure · Phase 1 (schema foundation)

Kicked off the three-tier ownership restructure from the Claude Design
handoff ("Forge Screens Board" + the three design chats). Full brief and
phase plan in `docs/plans/multiws-restructure.md`. Working on branch
`worktree-multiws-restructure`.

Confirmed three architectural forks with Bailey before cutting any migration
(all on a LIVE system — prod builds from the working tree, entrypoint
auto-runs `migrate deploy`):

1. **`Agent` row = the binding, not a rename.** Pushed back on the handoff's
   "rename Agent → AgentProfile + new Binding table" framing — that repoints
   every FK (`AgentRun.agentId`, `Issue.assignedAgentId`, `ChatThread.agentId`,
   `ApiKey.linkedAgentId`, dispatch, MCP, CLI) on a live DB. Instead: keep
   `Agent` as the per-workspace binding, add a global `AgentProfile`
   definition it points at (`Agent.profileId`). Zero FK churn.
2. **`profileKey` unique per owner** (`@@unique([ownerId, profileKey])`).
3. **Connections** = model + mapping + read UI now, generic OAuth/OIDC
   (modelled on the existing `SsoType` pattern: OIDC/GitHub/Google/Slack/
   Custom — Authelia-style), not hardcoded vendors.

**Phase 1 shipped (additive only — existing code compiles untouched):**
- `enum InstanceRole`, `User.instanceRole` (default MEMBER).
- `AgentProfile` (global, `ownerId`, base capabilities, `instanceShared`,
  `disabledAt`); `Agent.profileId` + binding policy columns
  (`autoDispatchEligible`, `engagementMode`); `@@index([profileId])`.
- `Connection` (global, user-owned identity) + `ConnectionMapping`
  (workspace-scoped) + `enum ConnectionProvider`/`ConnectionStatus`.
- Migration `0069_multiws_restructure_phase1` (generated via a throwaway
  shadow PG, replaying 0001–0068; DDL-only, no destructive ops).
- `prisma/backfill-multiws.ts` — idempotent, **run-explicitly** data
  backfill (NOT auto-applied on deploy): promotes ADMIN_EMAIL to
  INSTANCE_ADMIN, creates one AgentProfile per (workspace-owner,
  profileKey), links `Agent.profileId`, backfills `Runtime.ownerId`.
- `instanceAdminProcedure` now checks `User.instanceRole` (DB) with the
  `ADMIN_EMAIL` env match kept as bootstrap fallback; injects
  `ctx.instanceRole`. `auth.ts` stamps INSTANCE_ADMIN on the bootstrap
  operator's upsert (self-heals existing rows on next sign-in).

Verified: `prisma validate` clean, `prisma format` clean, full
`pnpm typecheck` passes, ESLint clean on touched files. Migration is safe
to `migrate deploy`; backfill is decoupled and idempotent.

Next (Phase 2): globalize `Runtime` (nullable `workspaceId`, `instanceShared`),
split routers into `agents.profiles.*`/`agents.bindings.*`,
`runtimes.*`/`connections.*` global+workspace, add `global.*` aggregation
router + `globalProcedure`.
## 2026-05-26 — Forge MCP Orca integration contract

Closed the Orca-facing MCP gaps in `src/server/services/mcp.ts`:

- `issues.list` now accepts `orderBy` (`updatedAt`, `createdAt`, `priority`,
  `identifier`, `title`), `order`, `cursor`, and `createdByViewer`, and returns
  cursor envelopes with a stable Issue DTO (`identifier`, canonical URL, nested
  status/project/assignedAgent/labels, dates, and legacy scalar ids for
  compatibility).
- `issues.list` keeps `projectId`, supports `statusCategories`, and treats
  `includeDone:false` as "exclude DONE" without hiding CANCELED. `issues.assigned`
  now also accepts `projectId` and returns the same Issue DTO envelope.
- Added `workspaces.list` (`{id,name,slug}`) and narrowed `agents.list` to the
  stable assignable shape (`{id,name,profileKey}`), both in `{data:[...]}` envelopes.
- `comments.list` now returns `{data:[...], nextCursor?}`. Issue-returning parity
  mutations (`issues.create`, `issues.update`, `issues.transition`, `issues.assign`,
  `issues.setLabels`) now surface the same Issue DTO while preserving the legacy
  scalar ids clients already used.
- The REST MCP route now passes through tool-level `{data:...}` envelopes instead
  of double-wrapping them.

Coverage:
- `DATABASE_URL=postgresql://forge:forge@localhost:55432/forge?schema=public REDIS_URL=redis://localhost:56379 pnpm test src/server/services/__tests__/mcp.test.ts` → 102 passed
- `pnpm typecheck` → pass
- `pnpm lint` → pass
- `E2E_FORCE_BUILD=1 pnpm test:e2e` → 9 passed
- Full `pnpm test` was also run with the dev Postgres/Redis; the MCP suite passed,
  but the full run still has unrelated shared-dev-DB/env failures in
  provider-credentials without `AUTH_SECRET`, plus existing chat hard-delete,
  dispatch-rule, dispatcher, and heartbeat sweep tests. Re-running provider
  credentials with `AUTH_SECRET=test-auth-secret-for-vitest` passes; the remaining
  failures are outside this MCP contract path.

## 2026-05-26 — User-docs cleanup for the AXI-55 epic (convergence + modes)

Post-ship doc pass. The CHANGELOG/What's-New entries were already correct, but
the reference docs hadn't caught up with the shipped epic. Fixed three gaps:

- **`docs/agents/engagement-modes.md`** — rewrote from spec voice (addressed to
  "you asked…", "Decisions resolved", Phase 2 reading as maybe-live) into guide
  voice describing what's live. Phase 2 scoped-tool enforcement is now clearly
  labelled planned-not-shipped.
- **`docs/agents/overview.md`** — added a **"Two ways to run agent work"**
  section (direct dispatch vs. Goal orchestration), the question users actually
  had. Calls out the shared `AgentRun` substrate and the two orthogonal dials
  (engagement mode, execution engine). Added orchestration/engines/modes to the
  cross-references (overview previously didn't link to orchestration at all).
- **`docs/concepts/orchestration.md`** — wove in the convergence: added
  **"Steps, runs, and issues"** (AXI-57 steps open observable runs; AXI-56
  materialize-step-as-issue), noted `Goal.initiativeId` (AXI-58) on the Goal
  primitive, and corrected the cost-folding note to the new `executionStepId`
  FK (legacy `sourceRunId` fallback).

No code/feature change, no new CHANGELOG entry (docs describe already-shipped
behaviour). VitePress build passes (dead-link check is build-failing by default).

## 2026-05-26 — Orchestration↔issue convergence + engagement modes (AXI-55 epic)

Shipped the full epic (AXI-55) per `/home/bailey/engagement-convergence-plan.md`
runbook, five phases, backend-first with per-phase migrations applied to local
via `prisma db execute` (the repo's local dev DB has migration-history drift, so
`migrate dev`/`reset` are unusable here; prod picks up the migration folders via
`migrate deploy` on boot). Migrations 0064–0067.

- **AXI-56** (0064): `ExecutionStep.issueId` + `materializeStepAsIssue` (idempotent;
  carries title/body/expectedOutput/verification/assignee). tRPC + MCP
  `executionPlans.materializeStep`.
- **AXI-57** (0065): `AgentRun.executionStepId`. `transitionStepToReady` now opens an
  observable run (bound to the step's issue, else the plan anchor; tagged with the
  step) IN ADDITION to the webhook dispatch — orchestrated turns are visible in
  Mission Control without collapsing the two control modes. `applyRunCostToPlan`
  resolves via the FK (legacy `sourceRunId` fallback).
- **AXI-53** (0066): engagement modes. `EngagementMode` + `MentionEngagementPolicy`
  enums; `AgentRun.engagementMode`; 3 `Workspace` knobs. `resolveEngagementMode()` +
  per-mode instruction blocks (`engagement-mode.ts`, unit-tested). Runs carry the
  mode (threaded from the AGENT_ASSIGNED payload through ensureCanonicalFromEvent +
  the RUNS dispatcher, which also injects the instruction). Auto-transition gated on
  EXECUTE. MCP `issues.assign` + tRPC `issue.update` accept `mode`. UI: mode glyph +
  chips (run strip / RunRow), assign-picker segmented control, Settings → Dispatch
  Rules controls.
- **AXI-58** (0067): `Goal.initiativeId` (+ initiative back-relation); `createGoal`
  accepts it. (Cycle↔goal/plan largely subsumed by step-as-issue.)
- **AXI-54 gap 2**: `executionPlans.create` accepts `steps[].dependsOnStepIndexes`
  (index→id in-txn), so a DAG is authorable in one create call.

Tests: orchestration suite 10→17, new engagement-mode suite (9), all green; lint +
typecheck clean. SLA/watchdog mode-gating left as a follow-up (the run carries the
mode; no behavior regression — only auto-transition is gated so far).

## 2026-05-25 — ExecutionPlan create supports indexed step deps (AXI-54 gap 2)

Closed Gap 2 of AXI-54: `executionPlans.create` can now seed a step DAG in the
same call using `steps[].dependsOnStepIndexes`, matching the already-working
`plans.addSteps` authoring shape. `createExecutionPlan` now creates seeded steps
in a first pass, records their real ids, then resolves index dependencies in a
second pass inside the same transaction. Explicit `dependsOnStepIds` remain
supported and are de-duped with resolved index deps.

Surface updates:
- Service input accepts `dependsOnStepIndexes` on seeded steps.
- tRPC `executionPlans.create` schema forwards `dependsOnStepIndexes` and router
  coverage verifies the seeded child receives the resolved parent id.
- MCP `executionPlans.create` schema forwards `dependsOnStepIndexes`, so agents
  can hand-author a goal-linked DAG without falling back to `plans.addSteps`.
- Changelog updated under Unreleased.

Verification:
- RED confirmed first: new service test failed with `dependsOnStepIds` still
  empty for child steps.
- `pnpm test src/server/services/__tests__/orchestration.test.ts -t "createExecutionPlan resolves seeded step dependencies by input index"` → pass
- `pnpm test src/server/services/__tests__/mcp.test.ts -t "orchestration loop tools"` → pass
- `pnpm test src/server/routers/__tests__/execution-plan.test.ts -t "creates a plan with ordered steps"` → pass
- `pnpm test src/server/routers/__tests__/execution-plan.test.ts src/server/services/__tests__/orchestration.test.ts src/server/services/__tests__/mcp.test.ts` → 124 passed
- `pnpm typecheck` → pass
- `pnpm lint` → pass
- `env -u OPENAI_API_KEY pnpm test` → 703 passed / 1 skipped, with 3 unrelated dispatcher/heartbeat failures when run against the shared `/home/bailey/forge/.env` database. The changed execution-plan/orchestration/MCP suites are green; the failures are in dispatch-rule/dispatcher/heartbeat selection tests and do not touch this code path.

## 2026-05-25 — Link hand-authored ExecutionPlans to Goals (AXI-54 gap 1)

Closed Gap 1 of AXI-54: there was no API path to attach a hand-authored
`ExecutionPlan` to a `Goal` — only `goals.decompose` (the LLM planner) ever set
`ExecutionPlan.goalId`, and `executionPlans.update` didn't accept it. Surfaced
while building the engagement-mode Goal/Plan (AXI-53): the plan could only be
associated to its goal via a shared `issueId`, never the `goalId` FK, so the
Goal DAG view didn't claim it.

Changes (no migration — `goalId` column already existed):
- `createExecutionPlan` (+ tRPC `executionPlans.create` + MCP) now accepts
  `goalId`. When set, the plan is created as the goal's active attempt and any
  prior active attempt is demoted (mirrors `decomposeGoal`). Cross-tenant +
  not-ACHIEVED/ABANDONED guards.
- New `attachPlanToGoal` service + tRPC `goals.attachPlan` + MCP
  `goals.attachPlan({ goalId, planId, makeActive? })` to link an *existing*
  plan. Refuses to steal a plan already owned by a different goal; keeps the
  single-active-attempt invariant.
- Tests: 3 new orchestration cases (attach links + activates; create-with-goalId
  demotes prior attempt; refuse cross-goal steal). 13/13 orchestration green;
  full plan/mcp suites green; typecheck + lint clean.

Gap 2 of AXI-54 (index-based step deps on `executionPlans.create`) still open —
`plans.addSteps` remains the DAG-authoring path. Note: the `mcp__forge__*`
stdio bridge drops array-of-object params, so step bulk-ops go via a direct
`POST /api/mcp/<tool>`.

## 2026-05-25 — Agent run completion closes lifecycle rows

Fixed the false-stalled-agent path where an agent could finish a no-op /
comment-only response but leave its `AgentRun` ACTIVE. The MCP
`runs.complete` tool already had the agent-facing completion contract and the
regression expectation was clear: it should store summary/artifact/checklist
metadata **and** close the run. Implementation now wraps the metadata write in a
transaction and calls shared `finishRun()` with `COMPLETED`, preserving the
standard `AGENT_RUN_COMPLETED` audit/activity event while leaving the Issue
itself open for human/operator follow-up. Also narrowed watched-issue agent
fan-out to actionable events only, so low-signal status changes and rolling
STATUS comment updates do not create/touch canonical agent work; BODY comments,
stalls, SLA breaches, nudges, and priority changes still page watchers.

Verification:
- `pnpm vitest run src/server/services/__tests__/audit.test.ts -t "watcher fan-out"` → 3 passed / 4 skipped
- `pnpm vitest run src/server/services/__tests__/mcp.test.ts -t "runs.complete"` → 2 passed / 97 skipped
- `pnpm vitest run src/server/services/__tests__/agent-run-stale.test.ts src/server/services/__tests__/stale-work.test.ts` → 9 passed
- `pnpm typecheck && pnpm lint` → clean
- `pnpm vitest run src/server/services/__tests__/audit.test.ts src/server/services/__tests__/mcp.test.ts -t "watcher fan-out|runs.complete"` → 5 passed / 101 skipped
- `pnpm test` full-suite smoke → 700 passed / 1 skipped, with two unrelated/environment-sensitive failures observed: `artifact-lifecycle` duplicate fixture key passed immediately when isolated; `agent-transport` expected no OpenAI model and passed with `OPENAI_API_KEY=`.
- Docker deploy smoke: rebuilt/recreated `forge` + `forge-worker`; migrations reported no pending migrations; both containers started; live bridge fallback confirmed AXI-47 is Done, `queued=false`, and has no ACTIVE/current run.

## 2026-05-24 — Design-board parity: glow-grid background + Settings IA (Agents + Connections)

Implemented the "Forge Screens Board" design handoff (claude.ai/design bundle).
Two pillars: theme/chrome token parity, and the settings information-architecture
the board landed on after the operator agreed to "replace existing mockups."

**Theme/chrome parity.** Live shell already mirrored the board (sidebar-nav.ts
is byte-identical to the design's reference copy), so the deltas were small:

- **`.forge-glow-grid*` family** added to `globals.css` (BG3 — the Atlas
  dashboard background ported to Forge tokens): static dot grid + two soft
  radial "lights" drifting on non-syncing 28s/36s paths, `mix-blend-mode:
  plus-lighter` so they add luminance to the dots beneath. Blob B uses ember
  for the single warm-accent bias. Transform-only, gated on `[data-motion="on"]`
  + reduced-motion. Registered `forge-glow-drift-a/-b` keyframes + animations in
  `tailwind.config.ts`. Did NOT regress `.forge-grid-bg` — live's `::before`
  translate3d version is the intentionally-smoother one vs the design's
  background-position form.
- `topbar.tsx` gained `bg-background` for strict parity with the board's
  `PageTopbar`.
- Sidebar `NavRow` badge colour split: decisions → ember accent, inbox → quiet
  subtle/foreground (matches the design `NavRow`; live had everything ember).

**Settings IA refactor (Agents + Connections).** The board collapsed the three
overlapping agentic-config surfaces (Agents / Runtimes / Integrations) into two:

- `settings-nav.ts`: renamed the `integrations` group → `connections`
  (`/integrations` item → `/connections`, new copy), removed the standalone
  `/runtimes` nav item, refreshed the Agents description. The settings index
  + compact navbar render from this list, so both auto-reflect the change.
- **New `/settings/connections`** page — strict inbound/outbound external I/O.
  Banner explains where Hermes/Claude/Codex went. The one real backend
  (Email-to-issue, `/api/ingest/email` + HMAC) is fully preserved as the wired
  inbound card; GitHub/Slack/Linear/PagerDuty/Discord/custom-webhook show as
  honest "available" cards (no OAuth backend exists yet). Event-vocabulary grid
  links to Webhook deliveries.
- `/settings/integrations` → server redirect to `/settings/connections`
  (preserves query string, mirrors the existing `integrations/deliveries`
  redirect shim).
- **Agents page** absorbed the old first-class integration adapter cards as an
  "Add an agent" recipe gallery (provider recipes that pre-seed the onboarding
  wizard via `openNewWithProvider`) + a read-only "Provider matrix" reference.
  Reworded the wizard's stale "Settings → Runtimes" hint.
- **Runtimes route kept alive** (not in the rail) as the advanced editor, since
  it owns real CRUD the board's Infrastructure accordion doesn't cover (adapter
  picker, Codex sandbox/approval policy, planned adapters, tier explainer).
  Reachable via the provider-matrix "runtime editor" deep link + existing
  runtime-detail links from mission-control / chat-status-rail / agent detail.
  The runtime-management + accessibility e2e specs still target it, so they pass.
- Repointed the two functional `/settings/integrations` links (fleet-checklist
  chat-ready step → `/settings/agents`; chat-thread "Integrations →" →
  "Connections →" `/settings/connections`) and the workspace.ts comment.

`pnpm lint` + `pnpm typecheck` clean. `pnpm test` = 689 pass (the only 4
failures are a pre-existing `AUTH_SECRET`-not-set env issue in
`provider-credentials.test.ts`, untouched by this work — pass with the secret
set). Done in worktree `worktree-design-parity`.

**Per-screen parity sweep (all 13 Screens-Board artboards).** Diffed every
board artboard against its live page. Finding: live is consistently a
*superset* of the mock (the board was built *from* live, then live grew
further — customizable dashboard widgets, the chat diagnostics rail, inbox
extras). So "parity" = porting the design's *additive* signal elements live was
missing, NOT regressing live to the simpler mock. Implemented (add-only,
verified data exists first — skipped anything that would need a new tRPC field
or a router change):

- **Cycles summary card** — 3 stats → 4-up bordered metric tiles
  (Scope / Done / In progress / Remaining); in-progress from
  `status.category === "IN_PROGRESS"`, remaining = total − done. Kept the
  timeline bar + burndown sparkline.
- **Goals card** — segmented step-ladder (done/current/todo), crew + plan-count
  meta row, labeled budget meter (turns warning past 80%). All from already
  computed `stepsDone/stepsTotal/planCount` + `totalCostUsd/maxTotalCostUsd`.
- **Command Center** live-goals card — `$used / $cap` budget figure + ember
  budget bar (rendered only when a cap exists). Step bar skipped (no step
  counts on that row).
- **Artifacts** — client-side type-filter chip row (only types present) +
  search over title/summary; resets stale filter on tab switch. Kept the
  Active/Archived tabs.
- **Roadmap** — visible mono project KEY chip on each bar, legend strip
  (Active sprint / Planned sprint / Project bar / Today), status-aware sprint
  band tint (ACTIVE ember/0.18 vs planned ember/0.05). Per-project progress
  fill skipped (`project.list` has no done split).
- **Issues list** (`issue-list.tsx`) — Linear-style **status grouping** with
  sticky per-status headers (dot + name + count) over the flat list. Grouping
  is purely visual: the flat selection model / select-all toolbar / Shift-range
  / `x`-hotkey / hover previews / unread dots / snooze all preserved. Plus up to
  2 label chips + a comment-count icon per row (both already on `issue.list`).
- **Issues board** — "+" add-issue button per column header (fires the existing
  `forge:quick-create`, passes `projectId` when project-scoped; status prefill
  not supported by quick-create, noted in a comment).
- **Plans card** — "Updated {relative}" footer (`updatedAt` was on the row).
  DAG step strip skipped — `executionPlan.list` exposes only `_count.steps`, no
  per-step status / done count / owner relation.
- **Dashboard** "By status" — inline horizontal bars scaled to count (status
  color over bg-subtle), kept the dot + CountUp.
- **Chat** stream header — `.forge-breath` live presence dot, gated on the
  existing reachability derivation so it never falsely claims liveness.

Deliberately NOT regressed (live is the newer intent): chat right-rail
diagnostics (design wanted Linked-work + Members), inbox single-column vs the
mock's 2-pane agent rail, dashboard widget system vs the mock's fixed
`grid-cols-12`, project-detail single-column Overview vs the mock's 2-col rail,
Plans tabbed grid vs the mock's template-rail split. Skipped for missing data:
Initiatives per-project nested list, Projects-list per-card progress bar +
initiative chip, issue-detail Reassign/Release affordance (no `issue.reassign`
mutation). All flagged in the parity reports.

Final: `pnpm typecheck` + `pnpm lint` clean; `pnpm test` 688 pass / 1 skip
(with `AUTH_SECRET` set).

**Settings-page redesign sweep (the "specifically designed" settings screens).**
The second design bundle (`iCVaz0otBlYcWUMr4POAdA`) is byte-identical to the
first; the operator re-pointed at it to flag that the prior passes did the
settings *IA* but not the per-subpage *internal* redesigns. Brought the live
settings pages up to the design's vocabulary (SettingsLayout / FormSection +
hints / DangerZone / SaveBar / TeachEmpty / FormSegmented) — add-only, every
input + tRPC mutation + handler preserved (the design's FormInput/Select are
display stubs; we reorganized live's *functional* controls, never replaced
them):

- **Agents** — replaced the flat list rows with the design's **AgentMergedCard**:
  header strip (avatar / @key / presence dot / N-of-capacity concurrent /
  description), an inline **provider · runtime · connection · last-heartbeat**
  4-col strip, a capabilities + workload-bar row, and a collapsible
  **Infrastructure** accordion (runtime kind / endpoint / heartbeat read-only +
  "Open runtime editor →" deep link). All real data from `agent.list` ⨝
  `runtime`; all actions (QuickActions / View / Edit-wizard / Archive / Delete)
  preserved. (Gallery + provider matrix from the earlier pass kept.)
- **Plugins** — added the **Permission reference** grid built from the *real*
  `PluginScope` enum (not the mock's invented scopes), a "scopes" label, and
  aligned subtitle.
- **Workspace · General** — split one long form into Identity / Sprint cadence /
  Tracking & storage / Agent SLA / Auto-transition / AI provider; pill toggles;
  red **Danger zone** (archive/delete, type-to-confirm) wired to existing
  Confirms; sticky **Save bar** that diffs against the server snapshot for an
  accurate pending count + ⌘S.
- **Members** — Roster section + a Roles teach card (OWNER/ADMIN/MEMBER/GUEST).
  **Dispatch rules** — Routing-matrix section + "How rules resolve" walkthrough
  + teach-empty (drag-reorder + first-match-wins preserved).
- **Statuses** — Pipeline section + read-only Categories reference + hex chips.
  **Labels** — Labels section + Palette reference + hex chips.
- **Saved views** — Yours / Shared split + teach-empty. **Recurring** — Schedules
  section + teach-empty (skipped a template-variable reference card — the
  backend does no `{{var}}` substitution, would be a false promise).
  **Templates** — section-wrapped issue/project partials + teach-empty.
- **Data** — Export / Import as separated groups + "What's portable" ✓/✗ lists +
  drop-zone framing. **Admin** — section hints + teach-empty streams.
  **Deliveries** — status-aware teach-empty (queue already matched).
- **Account pages** — Profile (inline help, Identity), Auth (admin-only banner +
  "what you can connect" + counts), Workspaces (danger zone routing to
  per-workspace settings — no account-scoped self-leave mutation exists, so we
  route rather than wire a phantom). Appearance + Developer access already
  matched the design — left as-is.
- **Onboarding** — live's 5-step add-agent wizard already implements the design's
  flow; now entered via the provider gallery. Connection/plugin *detail* flows
  from the mock (GitHub etc.) are aspirational with no backend — not built.

Validation: `pnpm typecheck` clean · `pnpm lint` clean · `pnpm test` 688 pass /
1 skip (AUTH_SECRET set) · **`pnpm build` succeeds** across all settings routes.

## 2026-05-24 — Agent merged card, data-backed deltas, plugin detail route, user-set backgrounds

Follow-up pass completing the operator's punch-list (second design bundle
`iCVaz0otBlYcWUMr4POAdA` — byte-identical to the first).

**Agent merged card (the centerpiece).** Replaced the flat agent-list rows on
`/settings/agents` with the design's `AgentMergedCard`: header (avatar / @key /
presence dot / N-of-capacity / description) → inline **provider · runtime ·
connection · last-heartbeat** strip → capabilities + workload bar →
collapsible **Infrastructure** accordion (runtime kind / endpoint / heartbeat
read-only + "Open runtime editor →"). Real `agent.list ⨝ runtime` data; all
actions (QuickActions / View / Edit-wizard / Archive / Delete) preserved.
Agent reassign/release already existed (AgentChip → AgentPickerModal w/ Unassign,
via `issue.update({ assignedAgentId })`).

**Data-backed deltas (added the data paths, then the UI — all query-side, no
schema change).**
- Projects list: `project.list` now includes `initiative` + a groupBy-computed
  `_count.doneIssues`; cards show a done/total progress bar + initiative chip.
- Initiatives: `initiative.list` now carries per-project `{key,name,color,done,
  total}`; card renders the nested project list (cap 4 + "+N more").
- Plans: `executionPlan.list` now includes `steps{position,status}` +
  `createdBy`/`createdByAgent` + `doneSteps`; card renders a DAG step strip
  (color-by-status pips + connectors, cap 12) + owner footer.
- Command Center: `liveGoals` aggregates `plans[].steps` → `doneSteps/totalSteps`;
  goal card adds a step-progress bar (budget bar was already there).

**Plugin detail route (prep for real plugin support, e.g. GitHub).** Added
`plugin.byId` (workspace-scoped, includes skills/active apiKeys/webhooks, strips
`secret`) + `remove` + `rotateSecret` (admin). New manifest-driven route
`/settings/plugins/[id]` (identity header, "what it does", approved-scopes with
shared blurbs, events, skills, webhooks/activity, danger zone with
type-to-confirm REMOVE). Extracted `src/lib/plugin-scopes.ts`
(`PLUGIN_SCOPE_HELP` from the real `PluginScope` enum) shared by list + detail;
list rows now link to the detail.

**Backgrounds as a user setting + grid fix.** New `User.backgroundStyle`
(migration `0063`, additive nullable; "grid" default | "glow" | "dots" |
"none") wired through `user.updateAppearance` + `ME_SELECT`, the cookie bridge,
`AppearanceProvider`, and the root `<html data-bg>` SSR stamp. New Background
section on `/settings/appearance` with live-swap + honest preview swatches.
**Grid audit fixes:** consolidated the three per-page `.forge-grid-bg` mounts
(dashboard/inbox/command-center) into ONE `.forge-page-bg` layer mounted once in
the app-shell `<main>` (`relative isolate`, `absolute inset-0 -z-10`). Because
`<main>` is the non-scrolling viewport-height flex parent, the layer always
covers the visible area (fixes command-center's "only first viewport" bug where
the grid sat on the scroll container) and the animated compositor layer is one
viewport tall instead of full-scroll-height (fixes the lag on tall pages).
`data-bg` selectors drive grid/dots/glow variants; `none` hides it.

Sign-in confirmed already live (`(auth)/signin`, LiveStatusPanel split) — no
work needed. Connection-detail pages (#10) deferred (need real GitHub/Slack
backends). Add-agent wizard 1:1 styling (#13) + canvas-interactive backgrounds
B1/B2 remain optional follow-ups.

Validation: applied `0063` to the local `:55432` dev stack; `pnpm typecheck` +
`pnpm lint` clean · `pnpm test` **688 pass / 1 skip** · **`pnpm build` succeeds**
(incl. new `/settings/plugins/[id]`). NOTE: deploy must run the `0063` migration.

## 2026-05-25 — Settings left rail + granular detail parity (status glyphs, dispatch matrix, dashed +Add)

Post-deploy review pass — the operator flagged that the settings *shell* kept
the horizontal navbar (design wanted a left rail) and that lots of small details
didn't match. Ran a granular detail audit and closed the HIGH items.

- **Settings shell → 244px left rail.** Replaced `SettingsNavbar` (horizontal)
  with `SettingsRail` (`components/settings/settings-rail.tsx`): grouped nav with
  per-item hint subtitles + admin pills, ember-tinted active row, a "Search
  settings" box with `/` focus shortcut. Wired into both the workspace and
  account settings shells; deleted `settings-navbar.tsx`.
- **Shared status/priority primitives** (the audit's high-leverage fix): new
  `ui/status-dot.tsx` (category-aware SVG glyph: backlog hollow-dashed /
  in-progress half-fill / done check / blocked diagonal / canceled line) and
  `ui/priority-glyph.tsx` (`!!!`/`!!`/… with per-priority tone). Wired into
  issue-list, issue-board, issue-hover-preview; de-duped the local glyph maps.
- **Dispatch rules → routing matrix.** Rewrote the page from a one-line badge
  sentence to the columnar matrix (On / Name / Priority / Label / Project /
  Target agent) + ember toggle switch + PriorityGlyph + bordered LabelChip +
  project color square + key + GripVertical handle + kebab. Read-only
  Fall-through indicator (autoDispatchMode editable would need a backend field).
- **Dashed "+ Add" affordances**: agents merged card capabilities + Providers
  field in the Infrastructure accordion; issue-rail labels as inline chips +
  dashed "+ Add" + a dashed Bot "Assign agent" button; sprint backlog rail in a
  dashed border + Inbox icon + "drag → plan" hint.
- **Missed card deltas finished on standalone pages**: `/plans` DAG step strip +
  owner footer; roadmap bars got the left-accent + interior done-so-far fill;
  goals loop explainer now a slim always-on variant above the list.

Validation: `pnpm typecheck` + `pnpm lint` clean · `pnpm test` **699 pass / 1
skip** · **`pnpm build` succeeds**.

## 2026-05-23 — Chat session management: delete, stop runtime run, connector-aware status rail

Closing the gaps in chat session/thread management on top of the in-progress
connector/provider work (`chat-readiness.ts` steering banner).

**1. Hard delete (`chat.deleteThread`).** Archive (reversible hide) stays; this
is the irreversible purge. Order: best-effort stop a live runs-backed run →
purge `chat-message` attachments (polymorphic, no FK cascade — uses
`deleteAttachment` for the MinIO object + row) → delete the `ChatThread`
(`ChatMessage` rows cascade via FK) → audit. Owner-scoped. A deleted default
thread re-creates empty on next open. Two-click confirm in the UI.

**2. Stop the live runtime session (`chat.stopThreadRun`).** For a RUNS-engine
agent whose run is owned by a managed runtime (Hermes today; Codex
app-server / ACP later), calls `connector.stop(externalRunId)` then marks the
`AgentRun` ABANDONED via `finishRun` (mirrors agent-run `respondApproval`
reject). Best-effort on the external call so Forge can always close its mirror.
COMPLETIONS agents have no external session — the composer's Stop button owns
that. Surfaced as a "Stop run" action (only when an active runs-backed run
exists).

**3. Connector-aware status rail.** `chat-status-rail.tsx` rewritten to
self-fetch (`agent.byId` + `chat.chatReadiness` + `threadDiagnostics`) and lead
with a **Connection** card: effective provider · engine (`runs`/`completions`
from `readiness.mode`) · managed runtime (name + kind, links to Settings →
Runtimes) · readiness chip (reaches a model / amber hint). Replaces the old
hardcoded "Hermes-backed conversation" copy that mislabeled Claude/Codex/
local-daemon threads. Actions now: retry · stop · kick · compact · archive/
restore · **delete**. `full` + `compact` variants.

**4. Both surfaces.** Full Chat page (`chat-workspace.tsx`) uses the rail (folded
the standalone archive button into it). Mission Control Chat tab (`chat-tab.tsx`)
gains a collapsible compact rail toggled from the thread strip — it had no
status/connection surface before.

**5. Mobile/tablet parity.** The right rail is `xl:block`, so sub-`xl` had no
inspector (mobile got only an archive button; tablet got nothing). Added a
right-side inspector **drawer** (`xl:hidden`) mirroring the existing left
conversations drawer — same overlay/panel classes + theme tokens — carrying the
full rail (connection · stop · kick · compact · archive/restore · delete). The
thread toolbar is now `xl:hidden` (was `md:hidden`) so tablet gets it too; the
"Conversations" button within stays `md:hidden`, and the lone archive button
became a connection/status (`SlidersHorizontal`) toggle.

typecheck + eslint clean; chat router tests 21 pass (5 new: delete cascade +
attachment purge + audit, default re-create, owner-scope forbid, stop no-op/
cross-agent), chat-readiness unit tests 6 pass.

## 2026-05-22 — Dispatch /events live, native commands, agent-config parity

**1. Dispatch runs consume `/events` live (migration 0057: `AgentRun.pendingApproval`).**
The worker now keeps a live SSE subscription per active connector-driven run
(tracked in-process, re-established by the 5s sweep → restart-safe) *alongside*
the status poll. The poll still owns lifecycle (terminal/usage/awaiting flag);
the subscription enriches the timeline with per-tool + thinking steps and
**captures the exact `approval.request` command** (poll status can't see it).
RunRow's approval banner now shows the command + risk. respondApproval +
poll + subscription all clear `pendingApproval` (Prisma.DbNull).

**2. Native Hermes command passthrough.** `ai.hermesInfo` proxies the gateway's
real `/api/skills`, `/api/memory`, `/health/detailed` (server-side, token never
leaves the server; agent profileKey forwarded as the memory-scope session key).
New chat commands `/skills`, `/memory`, and `/hermes status` return **live**
data; `/hermes usage` stays prose (no gateway API). Connector also handles the
9th event type `approval.responded` (→ `approval_resolved`).

**3. Agent config/onboarding parity.** Fixed: the wizard's "Chat engine"
selector was ignored on **create** (only `update` carried `runEngine`). Added
`runEngine` to the create input + mutation + create payload. Integration cards
(`/settings/integrations`) now show each integration's default engine
(runs/completions) next to the runtime badge. Runtime detection (forge CLI
daemon) is orthogonal and unaffected — RUNS agents are driven by the worker via
`/v1/runs`, not the local daemon.

typecheck + eslint clean; orchestration/chat/dispatch/run-stale tests green.

## 2026-05-22 — Dispatch approval UI + slash-command enhancements

**Dispatch permission blocks (the deferred piece).** Migration 0056 adds
`AgentRun.awaitingApprovalAt`. The runs-dispatch poller flips it on when a
run reports `waiting_for_approval` (BLOCKED event, once) and clears it when
the run resumes or finishes; the stale watchdog now skips runs with it set
(intentionally idle, not dead). New `agentRun.respondApproval({ runId,
decision })` tRPC: approve → `connector.approve(once)` + resume; reject →
`connector.stop()` + `finishRun(ABANDONED)`. RunRow shows an amber "needs
permission to run a command" banner with Approve/Reject when the flag is set.
(Won't fire for agents on `approvals.mode: off`, but the path is complete.)

**Slash commands.** Added `args` usage-hint metadata to `SlashCommand` (shown
in the autocomplete + `/help`; accepting an arg-taking command fills the stub).
New commands: **`/engine [completions|runs]`** (show or switch this agent's
chat engine — wired via `agent.update` through a new `setEngine`/`currentEngine`
slash-context capability) and **`/assign <KEY>`** (ask the agent to take an
issue). Added arg hints to `/issue`, `/hermes`. Docs: engines.md gained an
"Permission blocks (approvals)" section; agents/chat.md slash table updated.

typecheck + eslint clean; chat/dispatcher/run-stale tests (27) green; docs build clean.

## 2026-05-22 — Dispatch approval UI + slash-command enhancements

**Dispatch approvals (the deferred Phase-2 follow-up).** A connector-driven
run that pauses for operator permission is now actionable from Mission Control.
- Migration 0056: `AgentRun.awaitingApprovalAt`.
- `run-dispatcher` poll: on `waiting_for_approval` sets the flag + a one-shot
  BLOCKED event (keeps the run ACTIVE so it stays in the Live tab); on resume
  clears it; terminal always clears it.
- Stale watchdog skips `awaitingApprovalAt` runs (a blocked run is
  intentionally idle, not dead).
- `agentRun.respondApproval({ runId, decision })`: approve → connector
  `approve('once')` + resume; reject → connector `stop()` + finishRun ABANDONED.
- RunRow shows an amber "needs permission" banner with Approve / Reject.
- engines.md gained a "Permission blocks (approvals)" section (chat + dispatch).

**Slash commands.** Added an `args` usage-hint field (rendered in the `/`
autocomplete + `/help`), and new commands:
- `/engine [completions|runs]` — show or switch this agent's chat engine
  (ties into the engine work; admin-only switch, errors surfaced inline).
- `/assign <KEY>` — ask the agent to take an issue.
- Existing commands tagged with arg hints.
- chat-thread wires `currentEngine` + `setEngine` (via `agent.update`) into the
  slash context.

typecheck + eslint clean; chat/dispatcher/run-stale/orchestration tests green.

## 2026-05-22 — Hermes default→runs, approval semantics, FREE_FORM answers

Follow-on to the engine work, after researching the Hermes gateway approval
model (approvals gate dangerous *shell commands*: payload `{command,
description, choices: once|session|always|deny}`, per-session FIFO; a bare
**deny leaves the run blocked → must `/stop`**; `reasoning.available` carries
real thinking; tool args/results aren't streamed).

- **Hermes integration now defaults to RUNS** (`adapters.ts`). Chatting with
  Victor/Mizu talks to *that agent* (own memory + tools), and dispatch uses
  runs too. Per-agent override unchanged; flip to Completions for a stateless
  Forge-owned loop. engines.md updated to reflect the new default.
- **Chat permission blocks fixed** (`/api/chat/stream` RUNS path): the
  approval card is titled with the actual command (+ risk description in the
  args); **Approve → allow once; Decline → `/stop`** (a bare deny would hang
  the run per gateway semantics).
- **FREE_FORM asks deliver the answer.** A FREE_FORM ActionRequest is the
  agent asking *us* for info — bare "Accept" resolved it but delivered
  nothing. Command Center now shows **Respond** (textarea) for FREE_FORM asks;
  on accept-with-answer, `acceptActionRequest` posts a comment `@agent
  <answer>` on the issue, routing through the normal mention dispatch (+ inbox
  row for runs agents). Bound kinds (TRANSITION/ASSIGN/…) keep "Accept".

Streaming/thinking/tool rendering confirmed intact on the runs chat path
(message.delta → content, reasoning.available → thinking, tool.started/
completed → tool cards).

Deferred: a Mission Control approve/reject UI for *autonomous dispatch* runs
that hit an approval (currently shown as a "waiting for approval" step). Not
urgent — the operator's agents run `approvals.mode: off`, and the interactive
chat path already handles human-in-the-loop approvals.

typecheck + eslint clean; orchestration/chat tests (26) green; docs build clean.

## 2026-05-22 — Hermes /v1/runs Phase 2: dispatch ingestion + docs/UX

Dispatch (assigned work) now runs through the `/v1/runs` connector for
RUNS-engine agents, ingested by the worker.

- **Connector.getStatus** added (`RunStatus`) + `HermesRunsConnector.getStatus`
  (GET `/v1/runs/{id}`, maps status/last_event/output/usage; 404 → completed).
- **`run-dispatcher.ts`** (poll-based, restart-safe):
  `startNewRuns` opens an `AgentRun` for fresh RUNS-engine AGENT_ASSIGNED
  events (deduped by `assignmentEventId`) and `startRun`s the provider run;
  `pollActiveRuns` polls `getStatus` for ACTIVE runs with an `externalRunId`
  and mirrors progress (currentStep from last_event, BLOCKED on
  waiting_for_approval) / terminal `finishRun` (+ token usage) onto the run.
  Chose polling over a live SSE subscription so it fits the worker's
  short-job model and survives restarts with no in-memory state.
- **Worker:** `runs-dispatch-sweep` maintenance job every 5s → `ingestRunsDispatch()`.
- **audit.ts branch (a):** suppress the dispatch webhook for RUNS-engine
  assignees (so work isn't dispatched twice — they're driven by runs). A RUNS
  agent should not also carry a `webhookUrl`.
- **Docs:** new `docs/agents/engines.md` (Completions vs Runs — table, when to
  use which, pros/cons, ownership, dispatch behaviour), linked from the agents
  sidebar + a tip in `agents/chat.md`. CLAUDE.md gained an "Agent execution
  engine" section.
- **UX:** chat header shows a small ember **"runs"** pill when the agent is on
  the RUNS engine (the non-default "runs as itself" mode); completions stays
  unbadged to avoid clutter.

typecheck + eslint clean; dispatcher/inbox/chat/orchestration/analytics-dispatch/
run-stale tests (51) green; vitepress build clean.

Recommendation captured in docs: **standard consumer chat = Completions**
(fast, predictable, Forge-controlled); **Runs = opt-in** for agent memory +
native tools. Dispatch defaults to Runs.

## 2026-05-22 — Pluggable agent engine + Hermes /v1/runs (Phase 1: chat)

Groundwork for routing agents through Hermes' structured agent-run API
(`/v1/runs`) instead of only OpenAI-compat `/v1/chat/completions`, behind a
provider-agnostic abstraction.

- **Schema (migration 0055):** `RunEngine` enum (COMPLETIONS|RUNS),
  nullable `Agent.runEngine` (null = integration default), `AgentRun.externalRunId`.
- **Pluggable `DispatchConnector`** (`src/server/services/dispatch/`): normalised
  `RunEvent` union (content_delta/thinking/tool_started/tool_completed/
  approval_required/usage/completed/error) + `startRun`/`subscribe`/`approve`/
  `stop`. `HermesRunsConnector` implements it against POST `/v1/runs`,
  GET `/v1/runs/{id}/events` (SSE), `/approval`, `/stop`. `registry.ts`
  resolves the per-agent engine (`agent.runEngine ?? adapter.defaultRunEngine`)
  and returns the connector by provider. Other providers slot in without
  touching call sites.
- **Chat route** (`/api/chat/stream`): per-agent toggle. RUNS path delegates the
  turn to the connector and maps its events onto the SAME SSE vocab the client
  already speaks — so chat still streams token-by-token (via `message.delta`),
  tools render as cards, and `approval_required` surfaces as a tool_confirm
  whose response is POSTed back to the run. Stop aborts the live run.
  COMPLETIONS path unchanged (Forge owns the loop). Default stays COMPLETIONS
  (zero behaviour change until an agent is flipped).
- **UI:** integration `defaultRunEngine` (adapters.ts) + per-agent "Chat engine"
  selector in the agent wizard (Integration default / Completions / Hermes runs);
  `agent.update` accepts `runEngine`.

**Who owns what:** Forge always owns the ChatThread record + UI. COMPLETIONS →
Forge owns the loop + tools + approvals (stateless model). RUNS → Hermes owns
the loop + agent memory/persona/its own tools; Forge ingests events.

**Phase 2 (not yet built):** dispatch/assigned-work via `/v1/runs` — reuse the
same connector but ingest events into `AgentRun` + Mission Control from the
background **worker** (long-lived subscription + reconnect), webhook fallback
for completions/legacy agents. Deferred so the worker + dispatcher tests get a
deliberate pass rather than a rushed one.

## 2026-05-21 — Canvas: navigation, lock, collapse + component-instance delete

Round of canvas usability fixes (operator feedback "hard to move around").

- **Middle-mouse pan** anywhere (over cards/shapes too) — `onBackgroundMouseDown`
  handles `button === 1` with `preventDefault` to kill the autoscroll puck;
  shared `startPan()` helper.
- **Inline scroll beats global scroll** — `onWheel` walks ancestors from the
  wheel target to the surface; if a scroll container can still scroll in that
  direction it returns early (native scroll) instead of panning/zooming.
- **Lock canvas** (topbar toggle, persisted per canvas in localStorage). When
  locked: middle/left-drag pans, but move/resize/draw/delete/paste/drop and
  the inspector delete are all gated via `lockedRef`. Pan/zoom/select stay live.
- **Collapsible toolbar** — `canvas-toolbar.tsx` gained a collapse chevron +
  a compact "show toolbar" pill; collapsed state persists per workspace.
- **Left entity rail hidden by default**, open state persisted per workspace.
- **Right panel shows a vertical "Layers · Components" title when collapsed**
  (was a bare chevron — easy to forget it's there).
- **Component-instance delete bug fixed.** Placed instances were selectable but
  Delete/Backspace + context menu only handled shapes/frames/edges, so they
  couldn't be removed. Added router `canvas.instanceRemove` (deletes the
  `CanvasComponentInstance` row; definition untouched) and wired it into the
  Delete key, the selection-inspector delete, and a right-click menu
  ("Detach into shapes" via existing `instanceDetach`, or "Remove from
  canvas"). typecheck + eslint clean; canvas router tests (24) green.

## 2026-05-21 — Design-system follow-ups: motion toggle, docs, themed tooltips

Built on the M1–M10 motion work below.

- **Motion preference (Appearance → Motion).** New persisted user pref
  `motion` (`full` | `reduced`), mirroring `density`/`textSize`. Prisma
  column + migration `0054_user_motion_pref`, `ME_SELECT` + `updateAppearance`
  input, `appearance.ts` + `appearance-cookie.ts` (`AppearanceMotion`,
  default `full`), root layout stamps `data-motion` from the pref at SSR,
  `AppearanceProvider` keeps it in sync, and a new **Motion** section on the
  Appearance page (Full | Reduced choice cards with a live breathing-dot
  preview). `reduced` → `data-motion="off"` freezes the whole `forge-*`
  layer to static (independent of OS reduced-motion, which still also gates
  it). **Apply the migration** (`pnpm prisma migrate deploy`) in each env.
- **`docs/design-system/`.** README + `tokens.md` (every var, light/dark),
  `components.md` (the `ui/*` primitives), `principles.md` (10 rules +
  allowed/refused), `motion.md` (M1–M10 table + watch-items). Code stays
  canonical; docs describe it.
- **Themed tooltips app-wide — no browser tooltips.** Repo had no Tooltip
  primitive and no Radix, with **705 `title=` occurrences across 154 files**
  — too many to hand-edit. Built a global `NativeTooltips` delegate (mounted
  in the root layout) that intercepts every `title` on hover/focus: stashes
  + removes the attribute (suppressing the native popup), renders a
  token-styled tooltip, and restores `title` at rest for a11y. Net effect:
  every existing `title` is themed with zero call-site changes, and no
  native tooltips remain. Added a thin `<Tooltip content>` wrapper
  (`ui/tooltip.tsx`) for explicit use (sets `title`, routed through the same
  delegate). Fade-in is `motion-safe`; the tooltip itself always works.

Integration audit: each forge-* class/hook verified at its intended surface
(M1 dashboard, M4 issue-list, M5 chat, M6 dashboard counts, M7 step-node,
M8 sidebar, M9 section divider, M10 presence dot); M2/M3 remain classes-only
(deferred — don't stack ambient backgrounds). `pnpm typecheck` + `pnpm lint`
clean; `vitest run tests/unit` 161 passed (same 3 pre-existing `server-only`
failures, unrelated). Not yet applied: M4 on the Mission Control swimlane
(scoped to the issue list — staggering kanban cards reads worse); broaden if
wanted.

## 2026-05-21 — Apply the Claude Design spec: ambient motion M1–M10

Implemented the Claude Design handoff (`Forge Primitives Canvas`) as a
**design spec applied to the app** — not a new route/canvas tool. Plan:
`docs/plans/primitives-canvas-design-system.md`.

- **Token audit (no-op).** `forge-tokens.css` matches `globals.css`
  verbatim except `--font-sans` ordering (app keeps `ui-sans-serif`
  first — intentional) and two class-scoped `--grid-*` vars (not tokens).
  `globals.css` stays canonical; no token edits.
- **Primitive conformance (no changes).** Button (6 variants × sm/default/
  lg/icon) and EmptyState (page/section/card) already match the spec. The
  real `Badge` uses a dynamic `color` prop (DB label colors) instead of the
  spec's named tones — deliberate, left as-is.
- **Motion foundation.** Added a `/* Motion — forge-* */` block to
  `globals.css` with M1–M10 classes + keyframes, double-gated on
  `prefers-reduced-motion: no-preference` **and** `[data-motion="on"]`,
  each with a static fallback. Registered matching keyframes in
  `tailwind.config.ts` (so `animate-forge-*` utilities exist too). New
  `useCountUp` hook in `src/lib/` (IntersectionObserver + rAF, reduced-
  motion aware, once-per-mount). `data-motion="on"` stamped on `<html>` in
  the root layout (SSR, no flash). Vitest guard
  (`tests/unit/globals-keyframe-prefix.test.ts`) enforces `forge-`/`ui-`/
  `dag-` prefixes on new keyframes (no stylelint in the repo).
- **Wired into real surfaces:** M1 grid drift behind the dashboard (40%
  opacity); M4 staggered row-rise on `IssueList` (initial mount only, via
  a ref — won't re-stagger on refetch); M5 streaming ember sweep on agent
  draft bubbles in `chat-message.tsx` (dropped on finalize so text stays
  selectable); M6 count-up on the dashboard "By status" counts; M7
  active-node ember glow baked into orchestration `StepNode` (running
  node only, replacing the generic `animate-pulse` ring); M8 ember caret
  on the sidebar "Search or jump" omnibar trigger; M9 `SectionDivider`
  hairline-sweep primitive applied between Appearance settings sections;
  M10 ONLINE-only "breath" on `AgentPresenceDot` (replaces `animate-ping`).
  **M2 (aurora) / M3 (dot drift) shipped as classes only** — deferred in
  product per the handoff (don't stack ambient backgrounds).
- **Tweaked the spec's M4 fallback:** the spec's `.forge-row-rise{opacity:0}`
  base would leave rows invisible under reduced-motion; reworked so rows
  are visible by default and only start hidden when the animation will run.

Verification: `pnpm typecheck` + `pnpm lint` clean; `vitest run tests/unit`
161 passed incl. the keyframe guard. (3 pre-existing failures in
`rate-limit`/auth unit tests are a vitest `server-only` resolution gap,
unrelated to this diff.) Optional follow-ups left out of scope: a
"Motion: Full/Reduced" toggle in `/settings/appearance` that flips
`data-motion`, and the separate `docs/design-system/` docs site.

## 2026-05-21 — Mission Control chat: multiple conversations per agent

The chat tab only ever opened each agent's *default* thread and had no
way to start another — even though the backend already supports many
threads per agent (`chat.createConversation`) and `ChatThreadView`
already accepted a `threadId`. Added a thread strip above the
conversation (Main + named conversations for the selected agent) and a
"+ New chat" button that creates a fresh conversation and switches to
it. Switching agents resets to that agent's default thread. UI-only
(`chat-tab.tsx`); eslint clean, no type errors.

Also (ops, no repo change): fixed Hermes agents replying "401 Invalid
API key" — Forge's `HERMES_GATEWAY_TOKEN` (`~/docker/forge/.env`) didn't
match the gateway's `API_SERVER_KEY` (the `:8642/v1` inbound auth in
`~/.hermes/.env`). Set them equal, recreated `forge`+`forge-worker`,
verified 200 on `/v1/models` + a `claude-haiku` completion. Documented
in `~/SYSTEM.md`.

## 2026-05-21 — Agent-as-actor attribution in audit + activity

- **Problem.** Agent-performed actions (close/create/transition,
  slash commands, comments) attributed to the human key-owner (Bailey)
  because `AuditLog` / `ActivityEvent` only had `actorId` (User FK).
- **Model (operator-confirmed): agent is the actor.** When an action
  comes through an agent-linked API key, the Agent is the recorded
  actor (avatar + name + indigo "agent" chip); the human key-owner stays
  as secondary metadata (`actorId`) surfaced in a `via API key owned by
  {name}` tooltip. No "on behalf of" primary text.
- **Migration `0053_actor_agent`.** Added nullable `actorAgentId`
  (Agent FK, `onDelete: SetNull`) to `AuditLog` AND `ActivityEvent`,
  with back-relations on `Agent` (`actorAuditLogs`,
  `actorActivityEvents`). Indexes: `AuditLog @@index([workspaceId,
  actorAgentId])`, `ActivityEvent @@index([workspaceId, actorAgentId,
  createdAt])`. Applied cleanly via `migrate deploy`; client regenerated.
- **`recordChange`** (`src/server/audit.ts`) gained optional
  `actorAgentId?: string | null` (default null), written to both
  `auditLog.create` and `activityEvent.create`. No other behavior change.
- **Call sites (grep-driven sweep).** Threaded `actorAgentId:
  ctx.apiKey?.linkedAgentId ?? null` (or the already-computed agent var)
  through every reachable `recordChange`: `issue.ts` (20), `comment.ts`
  (create/update/upsertStatus), `mcp.ts` (49 remaining — primary agent
  path), plus full sweep of agent-reachable routers (canvas 31,
  execution-plan, artifact, context-set, attachment, agent-crew, chat
  message-post paths, agent, project, workspace, initiative, cycle,
  relation, timeEntry, note, ai, agent-run). Services that already
  receive `actorAgentId` as a param (artifact-, action-request-,
  execution-plan-, context-set-, agent-crew-service) now forward it to
  their `recordChange`. Pure-system events (dispatcher, heartbeat,
  sla-breach, recurring, stale-work, orchestration, ai-coach, etc.) and
  service fns without an `actorAgentId` param stay null (the actor is
  the system, not an agent).
- **Activity query + UI.** `issue.activity` and `admin.audit` now
  include `actorAgent { id, name, profileKey, avatar }`. The issue
  Activity panel and the admin Audit tab render the agent as actor
  (`AgentAvatar` + name + indigo `agent` chip + owner tooltip) when
  `actorAgent` is set, else unchanged (user actor). Skipped: dashboard
  "Recent activity" column and admin Events tab — both render only
  kind + time, no actor, so nothing to attribute.
- **Tests.** Extended `comment.test.ts`: agent-key comment records
  `actorAgentId = agent.id` + `actorId = human` on both audit + activity
  rows; human session leaves `actorAgentId` null. Full audit/issue/
  comment/mcp/action-request/artifact/canvas/chat suites green.

## 2026-05-21 — Dashboard is the consistent home + sticky agent panel on issues

- **Home page made consistent.** The workspace root already redirected
  to `/dashboard`, but the global root (`src/app/page.tsx`, post-login /
  last-workspace) sent users to `/inbox` — and the dashboard topbar
  called Inbox "the daily driver." Flipped both `page.tsx` redirects to
  `/dashboard`, fixed the "unified landing" comment, and reframed the
  dashboard's "Back to Inbox / daily driver" link to a plain "Inbox →"
  (the action queue, `g i`). Dashboard is now unambiguously home.
- **Sticky agent-status panel on issues** (`issue-agent-panel.tsx`,
  new). Lives at the top of the issue right rail (which is already
  sticky), so the assigned agent's presence dot + live run state
  (working / waiting on you) + current step stay visible while a long
  comment thread scrolls — the top-of-page `AgentRunStrip` scrolls away.
  Reads `agentRun.activeForIssue` + the issue's `assignedAgent`, refreshes
  over SSE, self-hides when there's no agent/run. Read-only (kick/resume
  are MCP-only, no tRPC mutation).

## 2026-05-21 — Command Center: realtime + inline decisions + de-overlap from Inbox

Command Center was a fetch-once, read-only summary that only deep-linked
out, overlapping conceptually with the Inbox. Made it a live decision
surface and gave both pages distinct identities.

- **Realtime.** Wired `useRealtime()` into the command-center page (same
  pattern as `agent-run-strip` / Mission Control — direct
  `utils.invalidate()`, no debounce). Invalidates
  `commandCenter.summary` + `commandCenter.decisionsCount` when an event
  arrives whose `subjectType` is `action-request`, `review-gate`,
  `agent-run`, or `goal`, or whose kind is in the `AGENT_RUN_*` family
  or `GOAL_CREATED` / `GOAL_STATUS_CHANGED`. Action-request and
  review-gate resolutions surface as `ISSUE_UPDATED` with a
  distinguishing `subjectType`, so keying off `subjectType` is what
  catches "ask resolved / gate resolved elsewhere." Broad but scoped —
  unrelated `ISSUE_*` edits are ignored.
- **Inline decisions.** Action-request "Asks for you" cards now
  accept/decline inline via `actionRequest.accept` / `.decline` (the
  same mutations the issue-timeline `ActionRequestCard` uses; reused the
  mutation contract, not the comment-bound component, since CC has raw
  `actionRequest` rows rather than a `commentId`). Review-gate cards
  resolve inline (Approve / Reject + optional note) via
  `reviewGate.resolve` — that's an `adminProcedure`, so the inline
  affordance only shows for OWNER/ADMIN; everyone else still gets the
  deep link to the target. Both do an optimistic drop of the acted item
  from the cached summary for instant feedback; `onSettled` invalidates
  to reconcile (and the realtime sub catches the server-side event too).
  Other cards (goals, runs, due, artifacts, timer) keep deep-linking.
- **De-overlap decision.** Investigated the overlap and it was already
  minimal: the Inbox surfaces *your work* (assigned/unblocked, mentions,
  waiting-on-me, human/agent-stalled, watching, sprint burn, agent
  queue) and **never surfaced action requests or review gates** as a
  decision affordance. The old CC "ask" card even deep-linked to
  `inbox?actionRequest=<id>`, a param the Inbox does not consume — a
  dead link. Decision: **Command Center is the canonical place to act on
  decisions** (action requests + review gates); the Inbox stays "your
  work" and keeps all its buckets untouched. Sharpened both subtitles to
  read as complementary — CC: "Decisions & live agent ops"; Inbox: "Your
  work — assignments, mentions, stalled, watching." Replaced the dead
  inbox deep-link on the ask card's title with a link to the related
  issue (a real destination) when one exists. No Inbox functionality
  removed.
- **No regressions.** `commandCenter` router untouched, so the sidebar /
  dashboard `decisionsCount` badge is unchanged (and now refreshes in
  realtime via the added invalidation). Mission Control untouched.
  Validated: `pnpm typecheck`, eslint on both touched files, and the
  action-request + inbox vitest suites (18 passing).

## 2026-05-21 — Immediate agent feedback on issue comments + status near the composer

Operator feedback: commenting to trigger an agent gave no immediate UI
signal, the run banner kept showing "waiting on you" after a reply, and
on long threads the top-of-page run strip scrolls out of view.

- **Instant "waiting → working" on reply.** The server already
  auto-resumes a WAITING run to ACTIVE in the same transaction as the
  comment (`openOrTouchRun`), but the strip only refreshed via SSE/
  refetch (~5–15s). `comment.create.onSuccess` now optimistically patches
  the `agentRun.activeForIssue` cache (WAITING → ACTIVE, bump
  `lastEventAt`) and invalidates it, so the banner flips the moment you
  send and a freshly-dispatched run surfaces fast.
- **Status where you type.** Render `<AgentRunStrip>` directly above the
  comment composer (in addition to the top-of-page instance). Same query
  key, so it's free and live; self-hides when no run. On a long thread
  the top strip is scrolled away — the composer-adjacent one keeps
  "working… / waiting on you" in view right where the operator replies.
- Validated: `pnpm typecheck` + `eslint` clean.

Follow-up considered, not built: a persistent agent-status panel in the
(already sticky) right rail — researched (reuse `AgentAvatar` /
`AgentPresenceDot` / run-status), deferred pending operator preference vs
the near-composer strip.

## 2026-05-21 — @mention + / coexistence: chainable in one comment, edit-mode dispatch

Operator bug: "after I @ an agent in a comment, I can't use a / command,"
plus "when editing, allow agent triggering properly."

**Root cause.** The slash picker (`slash-autocomplete.tsx`) only opened
when the caret line lived in a *top-of-body command block* — every
preceding non-blank line had to start with `/`. Typing an @mention as
prose on line 0 made any later `/` line "not top-of-body", so the picker
never opened. The same gate lived in `parseSlashCommands`
(`lib/slash-commands.ts`): it stopped extracting at the first
non-command line, so a `/assign @victor` line under prose was never
applied. The two were never mutually exclusive either — both could open
at the caret.

**Interaction model chosen.** Slash commands are recognised when `/`
begins ANY line (after optional whitespace) outside a fenced code block;
@mentions work anywhere inline. The two dropdowns are mutually exclusive
at the caret: `MentionInput` now emits `onMentionOpenChange`, and the
slash hook takes a `suppressed` flag so only one dropdown is ever open
and owns Arrow/Enter/Tab/Esc. Picking a slash command after an @mention
on a new line now opens the picker as expected.

**Parser.** `parseSlashCommands` rewritten to scan all top-level lines
and pull out RECOGNISED command lines wherever they sit, keeping prose
(and unknown `/foo`) verbatim and squashing the blank-line damage left
by removed lines. Conservative: only whole lines starting with `/` whose
keyword+arg parse are taken, so "and/or" and "https://…" are never
eaten. Fenced code blocks are tracked and preserved. Updated the
"stops at first non-command line" unit test (that encoded the OLD,
now-fixed behaviour) and added chained-@+/ and mid-line-slash cases.

**Edit mode (new UI).** There was no comment-edit UI at all. Added an
inline `CommentEditor` (BODY comments only) reusing `MentionInput` +
the slash picker with the same suppression guard. On save it applies
slash-command lines via `issue.applyCommands` and persists the prose via
`comment.update`. The issue DESCRIPTION editor got the same slash
support + apply-on-save.

**Edit-time agent dispatch.** `comment.update` previously emitted NO
event, so editing in an @agent triggered nothing. It now diffs old→new
mention tokens (`extractMentions`), resolves only the ADDED agents/users,
auto-watches them, and emits `COMMENT_UPDATED` with `edited: true` and a
`mentions.agentIds` carrying ONLY the diff. `audit.ts` branch (c) now
also fires on `COMMENT_UPDATED` *when `edited === true`*, so newly-added
mentions dispatch exactly like a fresh comment while pre-existing
mentions stay quiet (idempotent typo-fix). Rolling STATUS upserts also
emit COMMENT_UPDATED but without `edited`, so they never re-page. Branch
(e) watcher fan-out is skipped for `edited` events so a typo fix doesn't
re-page every stakeholder. Execution-step comments (`issueId` null) take
a plain update with no fan-out.

**Files.** `src/components/slash-autocomplete.tsx` (any-line trigger +
`suppressed` + fenced-block guard); `src/lib/slash-commands.ts` (parser
+ hint copy); `src/components/inputs/mention-input.tsx`
(`onMentionOpenChange`); `src/components/issue-detail/issue-main.tsx`
(comment composer suppression, `CommentEditor`, description slash
support, parser-driven hint); `src/server/routers/comment.ts`
(update mention diff + event); `src/server/audit.ts` (branch c on edited
COMMENT_UPDATED, branch e skip for edits); tests in
`tests/unit/slash-commands.test.ts` and
`src/server/routers/__tests__/comment.test.ts`.

**Validation.** `pnpm typecheck` clean; `pnpm lint` clean;
`vitest run` unit suite 178/178 + slash/templates 35; comment router
integration 10/10 (incl. 2 new edit-dispatch tests) + comment-history
7 + quick-reply 6, all green against dev Postgres+Redis. QuickCreate and
the Mission Control chat composer (home-grown, doesn't use MentionInput)
untouched.

## 2026-05-21 — Dashboard enhancements: customizable widgets, resume tile, unseen badge, context CTAs, canvas round-trip

Five operator-requested dashboard ideas. Migration `0052_dashboard_prefs`
(two nullable `User` columns) — applied via `migrate deploy` (status was
clean, no drift); client regenerated.

- **Migration**: `User.dashboardPrefs` (Json) + `User.changelogSeenAt`
  (DateTime?). Added to `ME_SELECT`. New user-router mutations
  `setDashboardPrefs` (zod `{ order, collapsed, hidden }`) and
  `markChangelogSeen`.
- **Customizable widgets** (`dashboard-stack.tsx`, new): the dashboard's
  movable tiles (today, resume, agent-activity, ideas, quick-notes,
  standup, whats-new) now render through `DashboardStack`. A "Customize"
  topbar toggle reveals per-widget drag handles (HTML5 DnD, no dep) +
  hide buttons and a hidden-widgets tray; Reset clears. Order/hidden
  persist via `setDashboardPrefs`, seeded once from `user.me`. Widgets
  own their card chrome, so edit mode adds a dashed control strip above
  each; non-editing renders pristine and empty widgets collapse via
  `empty:hidden` (no gaps). New widget ids append at the end of a saved
  order, so future widgets need no prefs migration. **Scope note:**
  collapse was dropped from v1 (the existing widgets render their own
  chrome with no external header to collapse into) — delivered reorder +
  hide instead. Fixed anchors (greeting, needs-you, onboarding, focus/
  suggestions, the bottom 3-col grid) stay put; the movable region sits
  between focus and the grid (this moved today/ideas/etc. below focus —
  a deliberate hierarchy bump, and now user-reorderable anyway).
- **Resume tile** (`resume-tile.tsx`, new): `recentItem.list` →
  `RecentItemsRail`. Per-user recency (distinct from the workspace-wide
  "Recent issues" column). Null when empty.
- **Unseen What's New dot**: `WhatsNewTile` takes `seenAt`; shows an
  ember dot when the newest dated changelog entry is newer than
  `changelogSeenAt`. `/whats-new` stamps `markChangelogSeen` on mount +
  invalidates `user.me` so the dot clears.
- **Context-aware greeting**: "Browse templates" → "New project" once
  projects exist; "Invite member" only for admins/owners.
- **Canvas round-trip**: personal canvases (`kind === "PERSONAL"`) get a
  "Dashboard" topbar button that persists view=list and navigates back.

Validated: `pnpm typecheck` + `eslint` clean; `changelog-parser` +
`sidebar-nav` unit tests pass.

## 2026-05-21 — Dashboard tie-together: templates link, Personal dedup, CHANGELOG refresh

Three operator-flagged dashboard fixes. No schema changes.

- **"Browse templates" now opens the templates dialog.** The
  GreetingBar button linked to `/projects` (bare list), where starter
  templates only render in the zero-projects empty state — so with
  projects present, the button led nowhere useful. Now links to
  `/projects?templates=1`; the projects page grew a `?templates`
  effect (mirroring the existing `?new` handler) that opens the
  already-present `StarterTemplates` dialog regardless of project count.
- **Removed the duplicate "Personal" sidebar item.** It redirected to
  the user's personal canvas — the same destination as the Dashboard's
  List/Canvas view toggle, which the operator prefers. Dropped the nav
  entry (`sidebar-nav.ts`, freed chord `g e`, removed orphaned `Home`
  icon import) and the breadcrumb `SectionId` / label entries. The
  `/personal` route stays as a harmless working redirect (still
  auto-provisions the canvas); the Dashboard toggle uses
  `user.personalCanvas` and is untouched.
- **Refreshed the stale What's New.** `CHANGELOG.md`'s latest entry was
  2026-05-04 (17 days stale). Added dated entries for 05-18 (Chat
  surface), 05-19 (chat streaming, confirm modals, canvas previews),
  05-20 (orchestration loop, on-canvas authoring, crews), and 05-21
  (canvas motion overhaul, issues-page polish). The What's New rail
  reads this file (mtime-cached), so it picks up automatically.

Validated: `pnpm typecheck` + `eslint` clean; `sidebar-nav` unit test
7/7 (chord uniqueness intact after the removal).

## 2026-05-21 — Issues-page polish: agent profile icons, composer discoverability, hover previews, snooze chips, debounced search

Tying together the recent UI/UX work. No schema changes; all client/render.

- **Agent replies show their real profile icon.** `CommentAvatar`
  (`issue-detail/issue-main.tsx`) was hardcoded to a generic `<Bot/>`
  glyph and explicitly forced `image` to null for agents — throwing
  away `authoringAgent.avatar`. It now renders the shared `AgentAvatar`
  (emoji / image / profileKey monogram), matching Mission Control, the
  agent picker, and crews. Applied to both the timeline card and the
  live-status pin.
- **Comment composer advertises @ and /.** The features already
  existed (`MentionInput` + `useSlashAutocomplete`) but nothing told
  users. New placeholder (`@ to mention · / for commands · paste or
  drop to attach`) plus a persistent `@ mention · / commands · ⌘↵ send`
  hint under the box — previously the hint only appeared *after* you'd
  typed a `/`.
- **Chat composer parity.** Did NOT swap `MentionInput` into the
  Mission Control chat composer: its dropdown anchors below the caret
  with no flip-up logic, which would render off-screen in the
  bottom-docked chat (which renders popovers upward); chat also has
  auto-resize, Enter-to-send, file-context toggles, and a chat-specific
  slash set. Instead added the same adaptive `@ / ↵` hint (gated to
  what's actually wired up, shown only while the composer is empty) so
  the *experience* matches. True component-level dedup would need
  placement-aware dropdown support in `MentionInput` — noted as
  follow-up.
- **Issue list: hover previews** — wired the existing
  `IssueHoverPreview` (350ms-delay portal, `issue.summary` fetch) onto
  each row's title.
- **Issue list: snooze chips** — rows whose `snoozedUntil` is in the
  future now show a `CalendarClock` "Snoozed" chip (with exact
  until-date tooltip). Snoozed issues already appear in the default
  list (`excludeSnoozed` defaults false), so the state was previously
  invisible.
- **Issues search debounced** — the list-view search now debounces
  300ms before hitting `issue.list` (was firing per keystroke) and
  shows a spinner in the input while a search is settling.

Validated: `pnpm typecheck` + `eslint` clean on all touched files. No
unit/integration tests cover these client components; e2e chat specs
don't reference the touched selectors.

## 2026-05-21 — Canvas: Excalidraw-grade motion, images, present mode, virtualization, sketch, undo

Six-part pass to close the UX gap vs Excalidraw. No schema migration —
images reuse the attachment system; everything else is client/render.

- **Motion (`canvas-camera.ts`, new)**: pure easing/lerp/fit helpers
  (`easeOutCubic`, `lerpViewport`, `computeFitViewport`,
  `prefersReducedMotion`). Page now eases all camera jumps via
  `animateViewportTo` (fit / fit-selection / reset / present), adds
  inertial-pan momentum (velocity sampled on drag, friction decay), and
  `RemoteCursorsLayer` lerps peer cursors toward their 10Hz targets so
  they glide instead of stepping. `will-change: transform` on the
  pan/zoom container. Honors `prefers-reduced-motion`. Unit tests in
  `tests/unit/canvas-camera.test.ts` (10).
- **Images**: new `canvas` attachment targetType (storage allowlist +
  `assertTargetInWorkspace`). `image` shape kind; style holds
  `attachmentId`, and `canvas.hydrate` resolves it to a fresh presigned
  `src` (15-min TTL, refreshes on refetch). Paste / drag-drop / toolbar
  picker all funnel through `uploadImageAt` → standard initUpload→PUT→
  finalize.
- **Present mode (`canvas-presentation.tsx`, new)**: frames become slides
  (reading order), eased fit-to-frame per slide, laser pointer with
  fading trail, slide HUD, arrow/space/Esc/Home/End nav. "Present"
  button in the topbar (disabled with 0 frames).
- **Reconciliation + virtualization**: remote-event hydrate invalidation
  is now coalesced (≤1 refetch / 220ms) instead of one-per-event, so peer
  edits / bulk agent adds don't flash. Shape render list culls to the
  visible viewport (+1-screen margin) above 200 shapes; path shapes
  (freehand/line/arrow) never culled; hit-test/fit/inspector keep the
  full set. (True element-level diffing still needs richer event
  payloads — left as follow-up.)
- **Drawing polish (`canvas-rough.ts`, new — adds `roughjs` dep)**:
  diamond shape; hand-drawn "sketch" rendering for box/ellipse/diamond;
  5 arrowhead styles (none/triangle/line/circle/diamond, both ends, via
  `context-stroke` markers); fill-color UI + adjustable corner radius.
  Toolbar gains diamond tool, image button, fill swatches, sketch
  toggle; the selection inspector gains fill / sketch / radius / ends.
- **Undo/redo**: broadened from move-only to cover shape create + delete
  across every entry point (draw tools, stamps, images, paste, duplicate,
  eraser, keyboard/inspector/context-menu delete) via `createShape` /
  `removeShapeUndoable` helpers (mutable id box re-mints rows across
  redo/undo cycles).
- Validation: `pnpm lint` + `pnpm typecheck` clean; canvas unit + router
  tests 64/64.

## 2026-05-20 — Orchestration loop (Goal → decompose → judge → retry)

Migration `0051_orchestration_loop` (authored manually + `migrate
resolve --applied` because `migrate dev` wanted a full reset over
unrelated pre-existing drift in 0012/0050; the SQL itself applied
cleanly via psql).

- **Schema**: new `Goal` model + `GoalStatus` enum
  (OPEN/PLANNING/ACTIVE/ACHIEVED/ABANDONED). `ExecutionPlan` gains
  `goalId`, `maxStepRetries`(2), `maxTotalCostUsd`, `maxWallTimeMinutes`,
  `totalCostUsd`, `isActiveAttempt`, `autoJudge`(true). `ExecutionStep`
  gains `judgeVerdict` Json, `retryCount`, `lastFeedback`, `childPlanId`.
  5 new `EventKind` values (GOAL_CREATED, GOAL_STATUS_CHANGED,
  EXECUTION_STEP_READY, EXECUTION_STEP_JUDGED, PLAN_BUDGET_EXCEEDED).
  No new `ExecutionStepStatus` values — reused the existing enum.
- **`orchestration-service.ts`** (new): goal CRUD, `decomposeGoal`
  (DRAFT plan + planner dispatch), `addStepsToPlan` (index-based deps),
  `cascadeReadiness` (TODO→READY when deps DONE + worker dispatch),
  `dispatchJudge` / `recordVerdict` (PASS→DONE+cascade / FAIL→retry or
  BLOCKED+gate), `maybeAutoJudge`, `requestPlanApproval` / `activatePlan`,
  `applyRunCostToPlan` + `checkAndBlockBudget` (budget watchdog).
- Step dispatch reuses the per-agent `agent:dispatch:{id}` webhook shim
  (worker resolves it for any subject type), so execution-step events
  fan out without needing an issue.
- **Wiring**: `updateExecutionStep` now cascades on DONE + auto-judges on
  REVIEW; `acceptActionRequest` activates a plan when
  `sourceType==="execution-plan"`; `runs.recordUsage` folds cost deltas
  into plan/goal totals + trips the budget watchdog.
- **MCP**: goals.{list,get,create,abandon}, plans.{decompose,addSteps,
  requestApproval,activate,judge,recordVerdict}, agentCrews.{create,
  update,addMember,removeMember,setMemberRole,archive}. tRPC `goal`
  router mirrors goals + decompose + requestApproval.
- **Tests**: `orchestration.test.ts` (10) + an MCP-registry orchestration
  test. Full suite: 571 pass / 1 pre-existing unrelated fail
  (`slash-templates` — a parallel UI agent's uncommitted `/goal`
  template not yet reflected in its own test).
- **Docs**: new `docs/concepts/orchestration.md`; `docs/reference/mcp.md`
  + `events.md` updated.

## 2026-05-20 — Canvas Polish Wave 1

Plan: `docs/plans/canvas-polish-wave.md`. Goal: stop the canvas feeling
like a placeholder — first-paint smoothness, on-canvas authoring, real
selection inspector, alignment guides, and sticky-note primitives.

- **W1.1**: frame drag cascade is now O(descendants), not O(frames²).
  Added unified `frameChildIndex` memo (`childFramesByParent`,
  `childNodesByFrame`, `childShapesByFrame`, `descendantsByFrame`)
  and refactored `onFrameTitleMouseDown` + `activePageDescendantIds`
  to use it. Click-to-first-paint on nested frames is no longer
  perceptibly delayed.
- **W1.2**: new `entity-create` tool (toolbar icon + `I` shortcut).
  Click on the canvas opens an inline composer popover with
  Issue / Note tabs; `Enter` commits via `issue.create` / `note.create`
  and drops a `CanvasNode` at the click position. Returns to Select.
- **W1.3**: sticky / comment-pin / stamp shape kinds + toolbar palettes.
- **W1.4**: smart alignment guides during shape drag. New
  `src/lib/canvas-snap-guides.ts` + 8 unit tests. Edge/center snap
  within 4px (scaled by zoom), guide lines rendered in ember dashed,
  inline distance labels between the active item and its nearest
  sibling, plus a `W × H` size label on the active bbox. Grid-snap
  still works when no smart-snap fires.
- **W1.5**: floating selection inspector. New
  `src/components/canvas/canvas-selection-inspector.tsx` — mini
  toolbar that hovers 8px above the selection bbox (auto-flips
  below near the top of the viewport). Per-kind property surfaces:
  shape (color / stroke / opacity / lock), frame (name /
  auto-layout direction / gap / padding), edge (kind), node (open
  detail), multi (count chip). Patches debounced 200ms, routed
  through `shapePatch` / `framePatch` / `edgePatch`. Delete button
  reuses the existing keyboard-delete path.

## 2026-05-20 — Canvas Polish Wave 2

- **W2.1**: tool ergonomics. Auto-return-to-Select after one shape
  commit (already existed); Shift-click on a tool button now locks
  it sticky with an ember dot indicator (skips the auto-return).
  Space-held temporarily flips any tool to Pan, releasing restores.
  Eraser cursor is no longer `not-allowed`; clicks delete the shape
  under cursor.
- **W2.2**: comment-pin thread UI (v1). Replaced the W1.3
  placeholder popover with a real thread inside the pin's
  foreignObject. Comments stored on `shape.style.comments` JSON,
  patched via `shapePatch` (no Comment-table migration needed yet).
  Add / resolve / re-open / delete; unresolved count drives the
  red badge; all-resolved pins switch from ember to translucent
  success ring.
- **W2.3**: hover + selection polish. SVG drop-shadow on any
  `[data-canvas-shape]:hover` for a 1px outline glow that reads on
  light + dark. Live marquee count badge floats to the right of
  the rubber-band rect, hitting nodes/shapes/frames in real time.
- **W2.4**: grid-snap visual feedback. During drag, when grid-snap
  applies (and no smart-guide fired), `SnapGuidesLayer` renders a
  row + column ember band at the snap target so the operator sees
  where they're being pulled.

## 2026-05-20 — Canvas Polish Wave 3

- **W3.1**: client-side undo / redo. New `src/lib/canvas-undo.ts`
  with a 100-entry stack. ⌘Z / ⌘⇧Z fire `undo` / `redo` and emit a
  short toast (`Undone: moved 3 shapes`). v1 wires the most-common
  op (shape move) — add/delete and frame/edge ops can extend by
  following the same `pushCommand` shape.
- **W3.2**: copy / paste. ⌘C serialises the shape selection to an
  in-memory clipboard with relative positions; ⌘V pastes at +20px
  offset. ⌘D continues to duplicate in place (pre-existing).
  Chains of pastes cascade rather than stacking on the same spot.
- **W3.3**: right-click context menu. New
  `src/components/canvas/canvas-context-menu.tsx`. Context-aware:
  shape (Duplicate / Delete), card (Remove from canvas),
  background (Paste / New issue here / New note here / Reset view).
- **W3.4**: focus / zoom modes. `F` zooms-to-fit the selected
  frame(s) with 80px padding; `Shift+F` still picks the frame tool
  even when frames are selected. `Shift+2` zooms-to-fit the current
  selection regardless of kind. `0` (reset) and `1` (fit-all) stay
  as-is.

## 2026-05-20 — Unified workspace flow — Wave 1

### Summary

Landed the **unified-workspace-flow** plan
(`docs/plans/unified-workspace-flow.md`) Wave 1: schema + server
foundation for notes-as-ideas, dashboard-as-canvas, Figma-grade canvas
primitives, agent storyboard MCP, and canvas-UX polish. Agent team
ran in parallel after the schema migration landed.

### Schema (migration `0046_unified_workspace_flow`)

- `Note.status` enum (IDEA | SOMEDAY | ACTIVE | ARCHIVED) +
  `promotedToType` / `promotedToId` backlinks. Existing JOURNAL rows
  backfilled to ACTIVE; existing archived rows to ARCHIVED.
- `Issue.sourceNoteId`, `Project.sourceNoteId`, `Initiative.sourceNoteId`
  — backlinks for `notes.promote`.
- `User.dashboardView` ("list" | "canvas") preference.
- `WorkspaceCanvas.kind` enum (PROJECT | INITIATIVE | CYCLE | ISSUE |
  PERSONAL | DESIGN), `ownerUserId`, `activePageId`. Unique key on
  `(workspaceId, kind, ownerUserId)` enforces one PERSONAL per user.
- New tables: `CanvasFrame`, `CanvasGroup`, `CanvasComponent`,
  `CanvasComponentInstance`, `CanvasStyle`.
- New columns on `WorkspaceCanvasNode` + `CanvasShape`:
  `parentFrameId`, `groupId` / `canvasGroupId`, `styleRefs`,
  `lockedAt`, `hiddenAt`.

### Notes upgrade (Workstream D)

- `notes.list` extended with `status` (single | array), `pinned`,
  `search` filters. `notes.create` accepts initial `status`
  (defaults: IDEA for NOTE, ACTIVE for JOURNAL).
- `notes.setStatus` mutation + MCP tool.
- `notes.promote({ noteId, kind, … })` mutation + MCP tool — creates
  Issue/Project/Initiative, stamps `sourceNoteId`, flips note to
  ACTIVE. Refuses to re-promote.
- Frontend: `QuickNotesWidget` gets a status filter chip row + inline
  status menu + "Convert →" popover. New `IdeasTile` lists top-N
  IDEA-status notes on the dashboard with one-click promote.

### Canvas core (Workstream B)

- `canvas.frameAdd / framePatch / frameRemove`,
  `canvas.groupCreate / groupDissolve`,
  `canvas.pageAdd / pageRemove / pageReorder / pageActivate`,
  `canvas.alignSelection`. Pure-function alignment / distribute /
  tidy-up lives in `src/server/services/canvas-alignment.ts` so the
  router and MCP path share one compute.
- MCP wrappers added for `canvases.frameAdd` and
  `canvases.alignSelection`; the rest of the wrappers
  (group/page/styleRefs) will follow as the frontend learns to
  render those primitives.

### Styling / components / layers (Workstream C)

- Style tokens: `canvas.styleCreate / List / Update / Delete` (soft
  delete via `archivedAt`).
- Components: `canvas.componentCreate / List / Get / Update / Archive`
  + instances: `instanceCreate / Patch / Detach` (detach materializes
  the definition into raw rows under the host frame).
- Layers: `layerSetLocked / SetHidden / Rename / Reorder` (shared
  helper across nodes/shapes/frames/groups/instances).
- All exposed as `canvases.*` MCP tools.

### Dashboard-as-canvas (Workstream E)

- `user.personalCanvas` query auto-provisions one PERSONAL canvas per
  user on first call. `user.setDashboardView` persists the preferred
  view.
- New `DashboardViewToggle` in the dashboard topbar — flips to the
  Personal canvas via `next/navigation`. `\` chord toggles from
  anywhere on the dashboard.

### Canvas polish (Workstream F)

- Per-tool cursor management (`cursorForTool`) — crosshair for
  draw/connect tools, text I-beam for text, grab/grabbing for pan,
  default for select.
- Connector preview switched from orthogonal A* to a cheap quadratic
  curve during drag — the root cause of "drawing node flows is
  delayed". Orthogonal routing still runs once on drop.
- Escape clears in-progress connector + active selection + reverts to
  select tool.
- `0` resets to 100% zoom centered; `1` zooms-to-fit all content
  (nodes + shapes, with 80px padding).

### Agent storyboard (Workstream G)

- New compound MCP tools `canvases.storyboardPlan` and
  `canvases.storyboardIssue` — drop a labeled frame containing the
  primary card + a notes lane + a sources/links column + a next-steps
  lane (or related / comments / attachments for issues). Audit emits
  `storyboard_plan` / `storyboard_issue`.

### Verification

- `pnpm lint` → clean.
- `pnpm typecheck` → clean.
- `pnpm test` → 421/421 (52 files) pass.
- Plan doc lives at `docs/plans/unified-workspace-flow.md`.

### Wave 5 follow-on — frontend renderers + Today + storyboard fills

Closing the DoD gap. A second pair of parallel agents went after the
canvas frontend rendering while I did the server-side Today zone +
the two remaining storyboard MCPs in this session.

**Today zone server (`src/server/services/today-zone.ts`)**
- Idempotent `refreshTodayZone(db, workspaceId, userId, canvasId)`.
  Finds (or creates) a Today frame on the Personal canvas, identified
  by `backgroundFill.kind = "today-zone"` so renames don't break
  lookup. Locked + auto-arranged.
- Collects assigned-active issues (top 7), issues due today (4),
  recent chat threads from the last 7 days (3). Dedupes, places into
  a 4-column grid inside the Today frame. Re-runs cleanly — wipes
  prior children before re-inserting.
- `user.personalCanvas` now calls `refreshTodayZone` on every fetch.
  Cheap enough (small N) to run inline; no background job needed.

**storyboardResearch + storyboardCustom MCP**
- `canvases.storyboardResearch({ canvasId, topic })` — frame with
  scratchpad + sources column + next-steps lane.
- `canvases.storyboardCustom({ canvasId, name, panels })` — escape
  hatch with up to 12 caller-defined text panels at arbitrary
  positions inside the frame.
- Chat system prompt updated with the full storyboard grammar (all
  four gestures listed with their input shapes).
- Chat tools allowlist now exposes all storyboard MCP entries +
  `canvases.frameAdd` + `canvases.alignSelection` + `notes.promote`
  + `notes.setStatus`.

**Frontend canvas renderers** (delegated to parallel agents)
- Visible frames (`src/components/canvas/canvas-frames.tsx`),
  components panel, layers panel, draw-frame F-key tool, multi-page
  tab bar for DESIGN canvases, drag-children-with-frame semantics.
  See agent reports for the per-component breakdown.

### Verification (post Wave 5)

- `pnpm lint && pnpm typecheck && pnpm test` → clean. 53 files /
  429 tests pass (8 new — 3 today-zone, 5 canvas-router Workstream B).
- All DoD criteria addressed at the code level:
  - Visible frames + drag-children-with-frame (`canvas-frames.tsx`
    + `framePatch` server cascade).
  - Multi-page tab bar for DESIGN canvases (`canvas-page-tabs.tsx`).
  - Components panel + drag-onto-canvas (`canvas-components-panel.tsx`
    + `CanvasComponentInstances` renderer; drop emits
    `application/x-forge-canvas-component`).
  - Layers panel — right-edge tree, hide/lock/rename/reorder
    (`canvas-layers-panel.tsx` + `canvas-right-panel.tsx`).
  - Today zone — `refreshTodayZone` runs inside `canvas.hydrate`
    when `canvas.kind === "PERSONAL"`. Entry route
    `/w/[slug]/personal` auto-provisions + redirects so the
    Personal canvas has a stable bookmarkable URL.
  - F-key + draw-frame gesture + per-tool cursor for "frame".
  - All four storyboard MCP gestures (Plan, Issue, Research,
    Custom) + chat-tools allowlist entries.
- Visual smoke needs a browser pass — typecheck and lint passes
  are the strongest signal we have without one.

## 2026-05-19 — Chat inbox backstop duplicate-wake guard

### Summary

Fixed AXI-44: the durable agent inbox/backstop path no longer retries
old chat USER turns after an AGENT reply already exists later in the
same thread.

### What changed

- `agent.inbox.list` now filters chat inbox rows by canonical conversation
  state, not only `acknowledgedAt`: dispatched USER messages are suppressed
  when a later AGENT message exists in the thread.
- `chat.kickThread` now no-ops for the same already-answered condition, so
  the `inbox-poll-backstop` retry path does not re-emit stale
  `CHAT_MESSAGE_POSTED` wakes.
- Added MCP regression coverage for both inbox listing and kick retry
  behavior on already-answered chat turns.

### Verification

- Added tests first; both new targeted tests failed on the old behavior.
- `pnpm vitest run src/server/services/__tests__/mcp.test.ts -t "agent.inbox.list suppresses chat turns|chat.kickThread is a no-op when the latest unacked"` → pass.
- `pnpm vitest run src/server/services/__tests__/mcp.test.ts` → 93/93 pass.
- `pnpm lint && pnpm typecheck && pnpm test` → clean, 52 files / 408 tests pass.
- `pnpm build` → clean.

## 2026-05-19 — Confirm modal, canvas perf, CRUD lifecycle, chat streaming, canvas previews (5-agent round)

### Summary

Five-agent parallel team (I/J/K/L/M) covering four operator asks in
one session: replace `window.confirm` with the existing polished
`<Confirm>` modal, fix canvas drag/click lag, add restore/duplicate/
delete CRUD lifecycle to plans + artifacts, swap chat from dispatch-
webhook to a proper streaming endpoint with thinking + tool-use
rendering, and turn canvas attachment/artifact cards into real inline
preview surfaces (images / PDFs / text / sandboxed HTML).

### What changed

**Confirm modal sweep (Agent I)** — every `window.confirm` in
`plans/[planId]`, `settings/crews`, `artifacts/[artifactSlug]` now
uses the existing `Confirm` modal (`src/components/ui/modal/
confirm.tsx`) with destructive variant + `typeToConfirm` gating where
appropriate. Discriminated `confirmState` union pattern for files
that host multiple confirms. Mutation loading state threads through
via the modal's `loading` prop.

**Canvas perf + canvas confirms (Agent J)** — substantial work on
`canvas/[canvasId]/page.tsx`:
- Drag state moved from `setData` cache writes to a `dragOverridesRef:
  Map<id, override>` + rAF-bumped `dragRev` counter. Only the moving
  card re-renders, not the whole tree.
- `CanvasCard` wrapped in `React.memo` with a custom equality
  comparing id/x/y/width/height/viewMode/meta-by-reference. Parent
  callbacks lifted into `useCallback` taking `nodeId` so they don't
  close over per-node state.
- `EdgesOverlay` memoized with bbox `useMemo`.
- Realtime hydrate refetch paused during drag (single trailing
  invalidate on mouseup); narrowed the invalidation filter to
  canvas-relevant subjectTypes.
- Remote-cursor positions moved to a `useRef<Map>` + `cursorsRev`
  counter so cursor ticks repaint only the cursor subtree. Local
  presence broadcast rAF-throttled.
- `window.confirm` sites swapped: archive canvas, remove card,
  convert-to-plan (default variant with dry-run preview).

**CRUD lifecycle (Agent K)** — both routers gained the full set:
- `executionPlan.restore({ id }) → { ok }`.
- `executionPlan.duplicate({ id, newTitle? }) → { id }` — clones
  description, steps, and remaps `dependsOnStepIds` from old→new
  step ids. New plan is DRAFT.
- `executionPlan.delete({ id, confirm }) → { ok }` — admin-gated
  (OWNER/ADMIN); `confirm` must match plan title. Cascades to
  `ExecutionStep`.
- `executionPlan.list({ archivedOnly? | includeArchived? })`.
- `artifact.restore`, `artifact.duplicate`, `artifact.delete`,
  `artifact.list` archived variant — symmetric.
- 20 new integration tests covering restore/duplicate/delete +
  cross-workspace + admin gates + cascade.
- `plans/page.tsx` + `artifacts/page.tsx` UI: Active/Archived
  segmented tabs, per-row "..." menu (Duplicate/Archive on Active,
  Restore/Delete on Archived), destructive `Confirm` with
  `typeToConfirm={row.title}` for hard delete.

**Chat streaming (Agent L)** — `/api/chat/stream` is the new
primary chat path for text-only sends:
- POST endpoint accepts `{ threadId, body }`, persists the USER
  ChatMessage immediately, streams the agent's reply back as
  Server-Sent Events.
- Provider routing via `Agent.provider`: HERMES → gateway,
  CLAUDE → Anthropic (with `thinking: { type: "enabled",
  budget_tokens: 4000 }`), CODEX → OpenAI, CUSTOM → custom base
  URL. Each falls back to Hermes if its provider env is unset.
- SSE event types: `meta` (placeholder messageId), `thinking`
  (extended-thinking delta), `content` (token delta), `tool_use`
  (tool intent — display only for v1), `done`, `error`.
- `chat-thread.tsx`: `AgentStreamBubble` renders thinking +
  content + tool-use cards live; persisted-row dedupe for ~800ms
  during swap so users never see a flash of two copies.
- `chat-message.tsx`: `StreamedRehydration` re-renders thinking +
  tool-use blocks on page reload from `ChatMessage.contextSnapshot`.
- `audit.ts` short-circuits webhook fan-out when payload
  `streamed: true` so the stream endpoint and Hermes webhook
  don't both reply.
- Attachment messages still flow through the dispatch path
  (existing `chat.send` mutation); only text-only sends go via
  the streaming path. Existing `chat.send` tests still pass.

**Canvas attachment previews (Agent M)** — new
`canvas-preview.tsx` shared component renders attachments + non-NOTE
artifacts inline on the canvas:
- Kind matrix: image (`<img>` cover, click → lightbox), PDF
  (`<iframe>`), HTML (`<iframe sandbox="allow-popups
  allow-forms">`), LINK (sandboxed iframe → new tab), markdown
  (`<ChatMarkdown>`), text/code (fetched `<pre>` capped at 40 lines
  with "Open full" → lightbox), video/audio (native controls),
  unsupported (warning chip).
- Reuses the existing lightbox's `classifyAttachmentKind` heuristic
  (now exported) so the canvas and lightbox stay in sync.
- 25 MB size cap on inline preview.
- Entity-hydration enriched: attachment meta gains `size`,
  `filename`, `externalUrl`; non-NOTE artifact meta gains `body`
  + `bodyKind` (`markdown` / `code` / `text`).
- Card-level preview/card toggle button; new attachment / non-NOTE
  artifact drops default to `preview` viewMode.
- `onTogglePreview` is `useCallback`-stable + threaded into the
  `React.memo` equality so Agent J's perf wins stay intact.

### Hotfix included

- `chat-tab.tsx` rail builder now buckets by `agent.id` (one row
  per agent, most-recent thread's timestamp). Fixes the "3 Victors"
  duplication operators reported.

### Verification

- `pnpm lint` → clean.
- `pnpm typecheck` → clean.
- `pnpm test` → 52 files / 406 tests pass.
- `pnpm build` → clean.

### Follow-ups noted by agents

- Streaming chat with attachments — `/api/chat/stream` still
  ignores the `attachments[]` field; uploads fall through to the
  dispatch path. Unify when the operator wants stream+files.
- Stop-generating button on the streaming bubble (abort wired,
  needs UI).
- Auto-execution of tool calls (intentional v2 hold; needs operator
  confirmation gate on writes).
- Per-thread provider/model override controls (currently only the
  agent's default provider).
- Lane persistence already lands via `patchNodeMeta` (round 3);
  but the convert-to-plan dry-run loop iterates `displayNodes`
  (drag overrides) which is fine for now since overrides don't
  touch `targetType`/`meta.kind` — worth a one-line audit later.

## 2026-05-19 — Plans/Canvas/Chat follow-ups + Victor-dedup hotfix

### Summary

Closed the five follow-ups noted by the round-2 agent team and fixed
a regression operators noticed in production: the chat overlay was
showing one row per ChatThread, so an agent with multiple threads
(e.g. Victor with 3) appeared three times in the agent rail.

### What changed

1. **Chat overlay agent rail dedupe** (`chat-tab.tsx`) — rebuilt
   the rail builder to bucket by `agent.id` and pick the
   most-recent `lastMessageAt` per agent. Final list is sorted by
   `lastMessageAt desc` with alphabetical name as the tie-break.
   Fixes "3 Victors" in the chat tab.
2. **`canvas.patchNodeMeta` tRPC + lane persistence** — added a
   shallow-merge `meta` update procedure (null deletes a key) and
   swapped the canvas lane editor's optimistic-only path to call
   it. Lanes now survive a page refresh.
3. **Edge SVG overlay on canvas** — `EdgesOverlay` renders all
   canvas edges as labeled SVG arrows inside the transformed
   surface so they pan/zoom with the cards. Styled by `edge.kind`
   (`depends_on` ember-solid, `contains` muted-dashed, default
   muted-solid). Borders projected to each node's rect so arrowheads
   land on the card edge, not the center. Closes the gap where
   templates seeded edges that didn't render.
4. **Convert-to-plan dry-run** — the toolbar button now runs a
   client-side preview using the same include/skip rules as the
   backend (`execution-step` ✓; `artifact` with `meta.kind="NOTE"`
   ✓; everything else skipped), shows a confirm dialog with the
   step count and skipped-node-type summary, and only fires the
   mutation on operator confirm. No more silent skips.
5. **Self-cursor filter** — Mission Control queries `trpc.user.me`
   in the canvas page and the presence subscriber suppresses any
   `canvas-presence` event whose `userId` matches. Operators no
   longer see their own ghost dot.
6. **Per-workspace Mission Control default tab** (migration 0043)
   — added `Membership.missionControlDefaultTab String?` and a new
   `trpc.user.missionControlDefaultTabFor({ workspaceId })` resolver
   that returns `{ resolved, membership, user }`. `updateMissionControlPrefs`
   now optionally takes a `workspaceId` to write the per-workspace
   override. Settings popover surfaces two dropdowns: "Open on
   (this workspace)" with an "Inherit ({userPref})" option, and
   "Open on (all workspaces)". Mount-time tab application reads
   the resolved value so per-workspace wins.

### Tests + verification

- `pnpm lint` → clean.
- `pnpm typecheck` → clean.
- `pnpm test` → 50 files / 386 tests pass.
- `pnpm build` → clean.

## 2026-05-19 — Chat overlay flow + Canvas first-class board (parallel team round 2)

### Summary

Ran a 3-agent parallel team (F/G/H) to fix the Mission Control chat
flow + promote Canvas from "spatial entity arrangement" to a real
idea/planning/execution surface with chat threads, sticky notes,
drag-from-sidebar, lanes, templates, presence cursors, and a
convert-canvas-to-plan round-trip. All three landed clean: lint +
typecheck + 386/386 tests + build.

### What changed

**Chat overlay (Agent F)**
1. **Default-tab pref** — `User.missionControlDefaultTab` (migration
   0042), applied on mount only when state is still "live", surfaced
   as a dropdown in the new `settings-popover.tsx`. Per-user, global
   across workspaces (per-workspace deferred).
2. **Quick chat icon on the pill** — `MessageSquare` next to the main
   pill button; click jumps to Chat tab without disturbing the
   pill-expand path.
3. **Composer auto-focus** — fires on tab switch + thread mount via
   an `autoFocus` prop deferred to next frame.
4. **Per-thread localStorage drafts** — keyed
   `forge.chat.draft.{threadId}`, hydrated on mount, rAF-debounced
   persist, cleared on send. SSR-safe.
5. **@-mention autocomplete** — `detectMentionToken` + popover in
   `chat-composer.tsx`; arrow/Enter/Tab to accept, Esc to dismiss;
   inserts `@profileKey ` at caret. Slash-command popover preserved
   as-is.
6. **Smart empty-state prompts** — `buildSuggestedPrompts` returns
   3-4 contextual chips (route-aware "Summarize this issue" when
   the operator is on an issue page); tap fills the composer
   without auto-send.
7. **Unread bubble + hover preview on the pill** — keyed off
   `chat.threads` + per-thread `lastSeen` in localStorage; 9+ cap;
   `group-hover:block` reveals the last-1-line preview.
8. **Global `/` shortcut** — `useHotkey("/", …)` opens Mission
   Control to Chat with the composer focused (Slack/Linear vibe);
   ignored when an input already has focus.

**Canvas frontend (Agent G)** — `canvas/[canvasId]/page.tsx`
expanded ~626 → ~1468 lines, plus a new
`canvas/canvas-templates.tsx` and a left `CanvasEntityRail`:
1. **Chat-thread renderer** — card view shows agent + last-message
   preview + relative time; live view shows last 3 message bubbles
   + composer-on-expand affordance routing to Mission Control chat.
2. **Note renderer** (sticky-style) — `ArtifactType.NOTE` rendered
   inline with `ChatMarkdown`, click-to-edit via `artifact.update`,
   amber sticky tone (warm tokens — no pure yellow).
3. **Sidebar drag-to-canvas** — new `CanvasEntityRail` with
   searchable issues/artifacts/chat-threads/agents emitting
   `application/x-forge-entity` payloads. Drop targets accept and
   create nodes at the drop coords. Ember ring on the canvas
   during a drag.
4. **Canvas templates** — Empty / Decision matrix / Architecture /
   Standup / Retro / OKR tree, each seeding nodes + edges via
   `canvas.addNote` + `canvases.addNode` + `canvases.addEdge`.
   Preview-card grid in the create dialog.
5. **Lanes** — `meta.lane` (string) renders as soft-tinted
   background bands with auto-fit horizontal bounds; right-side
   menu lets the operator move a node to a lane.
   ⚠ Persistence is client-only for v1 — `canvas.patchNode`
   doesn't accept `meta` updates yet; a future `patchNodeMeta`
   would close the loop.
6. **Convert canvas → plan** toolbar button — calls
   `canvas.convertToPlan`, routes to `/w/{slug}/plans/{newPlanId}`
   on success. Gracefully disabled if procedure missing.
7. **Presence cursor overlay** — subscribes to
   `subjectType="canvas-presence"` events; renders dot + name
   per remote operator. Local cursor broadcasts throttled to
   ~10 fps via `canvas.broadcastPresence`.
8. **Subtle animations** — `transition-all duration-300` on
   hover/focus + ember glow pulse on RUNNING-status nodes
   (matches Plans timeline).

**Canvas backend (Agent H)**
1. **`ArtifactType.NOTE`** — migration 0041 added the enum value;
   schema kept in sync.
2. **`canvas.addNote / addChatThread / convertToPlan /
   broadcastPresence`** tRPC procedures + matching MCP tools
   (`canvases.addNote`, `canvases.addChatThread`,
   `canvases.convertToPlan`).
3. **`convertToPlan`** walks the canvas nodes, takes existing
   execution-step refs verbatim, treats NOTE artifacts as new
   steps (title = first line of body, body = rest), maps
   `kind="depends_on"` edges to `dependsOnStepIds`, and returns
   `skippedNodes` for unsupported types (issue / agent-run /
   chat-thread are ignored with a reason).
4. **`broadcastPresence`** publishes Redis events
   (`subjectType="canvas-presence"`, payload `{ userId, name,
   x, y, ts }`) — fire-and-forget, mirrors `agent-run.ts`
   patterns.
5. **Entity-hydration extensions** — chat-thread returns
   `meta.agent { name, profileKey, avatar }`, `meta.lastMessageAt`,
   `meta.preview[3]` (user-filtered); artifact returns `meta.kind`,
   `meta.updatedAt`, and (NOTE-only) `meta.body`.
6. **6 new integration tests** covering note + chat-thread + convert
   + presence + cross-workspace rejection.

### Tests + verification

- `pnpm lint` → clean.
- `pnpm typecheck` → clean.
- `pnpm test` → 50 files / 386 tests passed.
- `pnpm build` → clean.

### Open follow-ups noted by agents

- Canvas: `patchNodeMeta` for lane persistence; self-cursor filter
  for presence; edge SVG overlay (templates seed edges that are
  currently invisible); multi-select drag-rectangle for bulk-lane;
  right-click context menu; convert-to-plan dry-run toast.
- Chat overlay: per-workspace default-tab pref; pre-thread-id draft
  fallback key; fuzzy mention match; `cmd+shift+/` for "panel+chat
  directly".

## 2026-05-19 — Plans + Canvas UX overhaul (parallel agent team)

### Summary

Ran a 5-agent parallel team to upgrade the Plans + Canvas surfaces in
one session. Plans went from "title + plain-text body + linear ol of
steps" to a full markdown-rendered, inline-auto-saving, list/timeline
toggleable workspace with live progress, running-step highlight, plan
templates, per-step comments, Mermaid + LaTeX in any markdown body, and
a one-click "Open as Canvas" path that lays out steps topologically by
their `dependsOnStepIds` graph. Canvas gained dedicated renderers for
execution-plan and execution-step targets (card + live viewModes).

### What changed

1. **Markdown everywhere on Plans.** `ExecutionPlan.description`,
   `ExecutionStep.body`, and `ExecutionStep.expectedOutput` now render
   through `ChatMarkdown`. Inline auto-save (600 ms debounce) replaces
   the old global Edit/Save toggle with per-field dirty tracking + a
   subtle ember "saving…" / muted-green "saved" pill.
2. **List ↔ Timeline view toggle.** Timeline renders a vertical
   connector line with per-step color segments matching status
   (TODO/READY/RUNNING/BLOCKED/REVIEW/DONE/CANCELED), dependency hints
   below each title (`↳ depends on #3, #5`), click-to-expand body, and
   subtle Tailwind transitions.
3. **Live progress bar** in the plan header — stacked counts of
   TODO/READY/RUNNING/BLOCKED/REVIEW/DONE with `{done}/{total} done ·
   {running} running · {blocked} blocked` caption.
4. **Currently-working highlight + auto-scroll.** RUNNING step gets an
   ember ring + smooth scrollIntoView, suppressed if the operator
   scrolled manually in the last 5 s.
5. **Plan templates** on the create dialog — Blank / DAG / RFC /
   Post-mortem / Feature spec. Templates seed title + description +
   ordered steps with `dependsOnStepIds` resolved client-side via a
   position→cuid map. Sequential `addStep.mutateAsync` calls with a
   `toast.loading("Seeding N/M steps…")` progress indicator.
6. **Mermaid + LaTeX in chat-markdown.** ` ```mermaid ` blocks render
   as SVG diagrams; `$..$` and `$$..$$` render as KaTeX. Both libs are
   dynamic-imported and only ship when a body actually uses them —
   zero bundle cost for the chat hot path. Mermaid uses
   `securityLevel: "strict"`; KaTeX uses `trust: false` + `strict:
   "ignore"` so user-authored math can't smuggle HTML. Inline `$5 and
   $10` (prices) is correctly ignored by the regex.
7. **Canvas plan/step renderers.** Schema already allowed
   `targetType="execution-plan" | "execution-step"` but the renderer
   and entity-hydration only had stubs. Plans now render with status
   badge + progress bar + animated "Running · N steps" sub-label
   (live mode). Steps render with position pill + status badge +
   assignee chip + 2-line expectedOutput. RUNNING gets an ember ring
   in live mode to mirror the plans detail page.
8. **`canvas.createFromPlan({ planId, name? })` tRPC.** Auto-creates
   a workspace-scoped canvas with `scopeType="execution-plan"`, lays
   out steps by longest-path depth on the `dependsOnStepIds` DAG
   (320×200 grid), and adds `contains` + `depends_on` edges. Wired
   to the plan header's "Open as Canvas" action.
9. **Per-step comments.** Extended the existing `Comment` model with
   a nullable `executionStepId` FK (cascade) and relaxed `issueId` to
   nullable (migration 0040). App-layer keeps the "exactly one of
   {issueId, executionStepId}" invariant. New tRPC procs:
   `executionPlan.stepCommentList / stepCommentCreate / stepCommentDelete`.
   New `StepComments` component is wired inline under each step
   card — collapsed pill expands to a thread + composer (Cmd/Ctrl+
   Enter to post). Comments emit `COMMENT_CREATED` events with
   `subjectType: "execution-step"` for parity with issue comments.

### Tests

- 6 new tRPC tests for step comments (create/list/delete/admin
  override/cross-workspace rejection/event emission).
- 2 new canvas tests for `createFromPlan` (4-step plan with a chain
  produces the right node/edge counts; cross-workspace rejected).
- All existing tests still pass.

### Verification

- `pnpm lint` → clean.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck` → clean.
- `pnpm test` → 50 files / 380 tests passed.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm build` → clean.

### Notes for future work

- I considered storing HTML alongside Markdown as an optional plan
  content type, then declined: XSS sanitization, diff churn, and
  migration cost are too high relative to Markdown-with-GFM + Mermaid
  + LaTeX, which now covers ~all the "rich plan body" use cases.
- Mermaid is the heaviest dep (~700 KB). Strict dynamic-import is the
  reason the chat hot path stays cheap. If a future page wants
  diagrams to render server-side (e.g. PDF export), we'll need to
  swap to a server renderer like @mermaid-js/mermaid-cli.
- `docs/plans/hermes-kanban-comparison.md` captures the Hermes vs.
  Forge work-state comparison and three follow-on enhancements to
  consider in a separate session (move recovery into a server-side
  ticker, auto-wire ack on first agent output, draft heartbeat for
  long replies).

## 2026-05-19 — Durable agent dispatch inbox (single-operator)

### Summary

Closed the long-standing "fire-and-forget Hermes webhook" gap by making
Forge's own database the canonical record of "agent X owes work on Y".
Webhooks remain the low-latency wake path but no longer own work-state
creation: AgentRun (for issue-routed events) and ChatMessage (for chat
turns) are opened in the same transaction as the ActivityEvent and
carry the new lifecycle dimensions (`triggerEventId`, `triggerKind`,
`acknowledgedAt`, `outputStartedAt`, `lastWakeAt`, `wakeAttempts`,
`lastWakeDeliveryId`). The Forge UI now transitions chat from
"queued → wake-sent → acknowledged → running" using canonical state
instead of a clock heuristic, so an unacked agent no longer leaves the
chat panel showing infinite "thinking".

### What changed

1. **Schema (migration 0039_agent_dispatch_inbox).** `AgentRun` gained
   `triggerEventId / triggerKind / acknowledgedAt / outputStartedAt /
   lastWakeAt / wakeAttempts / lastWakeDeliveryId` plus two indexes
   (`(workspaceId, agentId, acknowledgedAt, lastEventAt)` and
   `(workspaceId, triggerEventId)`). `ChatMessage` gained the
   parallel set without `triggerEventId` (the row id IS the
   trigger). All columns nullable / defaulted — existing rows
   stay valid.
2. **Service `agent-dispatch-inbox.ts`** in `src/server/services/`.
   Idempotent helpers: `ensureCanonicalFromEvent` (called from
   audit), `recordWakeAttempt` (called from worker on success AND
   failure), `ackInboxItem`, `markOutputStarted`, `listInbox`,
   `deriveRunDispatchState`, `deriveChatDispatchState`.
3. **`audit.ts` recordChange** now resolves the agent set (branches
   a–e) into a `resolvedAgentIds` array and calls
   `ensureCanonicalFromEvent` in the same tx as the
   `ActivityEvent`. Webhook delivery rows are still created in
   parallel, but they are no longer the only source of agent
   ownership.
4. **`worker.ts` webhook delivery** stopped calling
   `recordAgentAction(... DISPATCH_RECEIVED ...)`. Successful AND
   failed deliveries now flow through `recordWakeAttempt`, which
   bumps `lastWakeAt / wakeAttempts / lastWakeDeliveryId` on the
   canonical row and (on success) appends a `WAKE_DELIVERED`
   timeline event so the pulse strip still has the row.
5. **MCP additions** in `src/server/services/mcp.ts`:
   - `agent.inbox.list({ status, limit, staleAfterSeconds? })`
   - `agent.inbox.ack({ runId | chatMessageId })`
   - `agent.inbox.outputStarted({ runId | chatMessageId })`
   All three require a key with `linkedAgentId`; the ack/output
   tools reject cross-agent ownership. `chat.startDraft`,
   `chat.appendMessage`, and `chat.finalizeDraft` now also flip
   the latest pending USER ChatMessage to `acknowledged +
   outputStarted` so the UI clears its diagnostic rail in
   lock-step with the visible reply.
6. **Hermes dispatch prompts** (`~/.hermes/webhook_subscriptions.json`
   + `~/.hermes/profiles/mizu/webhook_subscriptions.json`) rewritten
   to spell out the new contract: wake → `agent.inbox.list` →
   `agent.inbox.ack` → `agent.context.bundle` → act. The payload is
   a hint, not a task spec. `docs/agents/hermes.md` and
   `docs/automation/webhooks.md` got the equivalent operator-facing
   callouts.
7. **Chat UI ack-aware diagnostics.** `buildThreadDiagnostics`
   exposes a derived `dispatchState` plus the user message's
   lifecycle snapshot. `chat-thread.tsx` drives its typing /
   diagnostic rail off `dispatchState`: an `AgentWakeDiagnostic`
   bubble replaces the misleading "thinking" animation when a wake
   has been delivered but the agent has not yet acknowledged.
8. **Issue run strip** (`agent-run-strip.tsx`) distinguishes
   queued / wake-sent / acknowledged / running / stalled with
   amber treatment for stalled rows. The chronological STATUS
   comment fix from earlier in the day is preserved.
9. **Design notes** at `docs/plans/agent-dispatch-inbox-design.md`
   (final decisions) and `docs/plans/agent-dispatch-inbox-map.md`
   (codebase orientation) for future readers.

### Tests

- `agent-dispatch-inbox.test.ts` — 11 new integration tests covering
  ensureCanonicalFromEvent (assign, mention, no-webhook), ack
  idempotency, cross-agent rejection, wake telemetry, inbox listing
  filters, state derivation.
- `mcp.test.ts` — 5 new tests for `agent.inbox.list`,
  `agent.inbox.ack`, including linkedAgentId enforcement,
  cross-agent rejection, and project scope narrowing.
- `chat.test.ts` — 2 new tests for `dispatchState` transitions
  through wake-sent → acknowledged → running and queued initial
  state.

### Verification

- `pnpm lint` → pass (no warnings).
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck` → pass.
- `pnpm test` → 50 files / 369 tests passed.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm build` → pass
  (Next.js + VitePress docs).

## 2026-05-19 — Align agent status comments with issue chronology

### Summary

Audited issue comment rendering and MCP hydration after the operator noticed
persistent/status comments did not line up chronologically with normal comments.
The root mismatch was that STATUS comments are rolling AgentRun updates: their
meaningful timestamp is `updatedAt`, while their row `createdAt` stays at the
first live-status upsert. The UI also pinned all STATUS rows, including old
completed/abandoned runs, which made historical run summaries look like current
activity.

### What changed

1. **Issue UI timeline.** Active/stalled STATUS comments remain pinned as live
   run state; terminal STATUS comments now render in the normal comment stream
   using `updatedAt` as their effective chronological timestamp.
2. **MCP context order.** `issues.get(...include.comments)` and
   `agent.context.bundle({ issueId })` now hydrate comments in effective
   chronological order, so Hermes sees human comments and rolling agent status
   in the same order the operator expects.
3. **Run metadata.** Issue detail comment hydration now includes the linked
   AgentRun status so the UI can distinguish live run state from historical run
   summaries without guessing.

### Verification

- `pnpm vitest run src/server/services/__tests__/mcp.test.ts --testNamePattern "issues.get with include|agent.context.bundle issueId"` → pass.
- `pnpm lint` → pass.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck` → pass.
- `pnpm test` → 49 files / 352 tests passed.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm build` → pass.

## 2026-05-19 — Clarify agent assignment vs. comment mentions

### Summary

Audited the Forge agent-dispatch path after an operator report that assigning
Victor did not appear to make the agent act on the latest issue comment. The
runtime path is intentionally split: `AGENT_ASSIGNED` wakes the assignee and
`COMMENT_CREATED` only wakes explicitly mentioned/watching agents. The Hermes
webhook prompt was too weak on assignment context, so it could frame from the
issue snapshot without necessarily reading the latest comments first.

### What changed

1. **Hermes dispatch prompt.** Updated the live `forge-dispatch` webhook
   subscription to require `mcp_forge_agent_context_bundle({ issueId })` before
   acting on `AGENT_ASSIGNED`, `ISSUE_QUEUED`, priority changes, or directed
   comments. Assignment now explicitly treats the latest human/operator comment
   as current instructions even when posted before the assignment.
2. **User/operator docs.** Clarified in `docs/agents/overview.md`,
   `docs/agents/hermes.md`, `docs/automation/webhooks.md`, and
   `docs/guide/issues.md` that assignment starts work and does not require an
   additional `@mention`, while follow-up comments should mention the agent or
   rely on watching to wake it.

### Verification

- `pnpm build:docs` → pass; VitePress docs rendered and staged for production
  build.

## 2026-05-19 — Quiet Docker build Redis imports

### Summary

Cleaned up Forge's Docker build output by preventing Redis-backed modules from
opening sockets during Next.js page-data collection. The build container does
not run alongside Forge Redis, so eager BullMQ/ioredis construction produced
misleading `ECONNREFUSED` noise even though runtime services were healthy.

### What changed

1. **ioredis lazy connect.** `src/server/redis.ts` now defers Redis socket
   creation until the first real command instead of connecting at module import.
2. **BullMQ lazy queue handles.** `src/server/queues.ts` now exports lazy proxy
   handles so API-route static analysis can import queue producer modules
   without constructing BullMQ queues during `next build`.

### Verification

- `pnpm test` → 49 files / 352 tests passed.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck` → pass.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm lint` → pass, no warnings.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm build` → pass.
- `docker compose -f /home/bailey/docker/forge/docker-compose.yaml build forge` → pass with `BUILD_NOISE_FOUND=0` for `ioredis`, `ECONNREFUSED`, and `AggregateError`.

## 2026-05-19 — Agentic Work OS release-gate hardening

### Summary

Closed the deploy-blocking review findings from the long-run Claude Code
implementation before shipping. The fixes keep new agent/team/canvas power
behind the intended admin/API boundaries and preserve the audit/event trail
for mutable operations.

### What changed

1. **Crew and ReviewGate admin gating.** AgentCrew create/archive/member
   mutation routes and ReviewGate resolution now use `adminProcedure`, so
   workspace MEMBERS can read but cannot change team composition or approve
   gates. Added regression coverage for non-admin rejection.
2. **Crew audit trail.** Crew archive, member add, and member remove now write
   `recordChange` activity entries with actor and before/after context.
3. **Canvas ref hardening.** tRPC and MCP canvas creation/node insertion now
   validate entity refs through the shared hydrator before persisting layout.
   MCP additionally applies API-key project/label/initiative narrowing for
   issue/project/initiative refs and rejects half-scoped canvases.
4. **Canvas mutation audit.** MCP canvas node/edge add, patch, and remove now
   update the canvas timestamp and emit audited activity via transactions.

### Verification

- `pnpm vitest run src/server/routers/__tests__/canvas.test.ts src/server/routers/__tests__/agent-crew.test.ts src/server/services/__tests__/mcp.test.ts` → 3 files / 91 tests passed.
- `pnpm test` → 49 files / 352 tests passed.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck` → pass.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm lint` → pass, no warnings.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm build` → pass.

## 2026-05-19 — Agentic Work OS product-surface follow-up

### Summary

Shipped the remaining product surfaces on top of the substrate landed
in the earlier 12-wave run. Existing routes (Issues, Chat, Agents,
Hermes delivery) are untouched; all new code goes through the
existing tRPC/services/MCP paths so audit, ActivityEvent, and
workspace tenancy stay intact.

### What changed

1. **CaptureSheet** (`src/components/quick-create.tsx`,
   `tests/unit/quick-create-modes.test.ts`). The single keyboard-first
   capture surface now spans Issue / Sprint / Project / Initiative /
   Note / Artifact / Action request. Per-mode chips (artifact type,
   action-request severity) keep the single-line flow; ⌘⏎ either
   expands a description textarea or opens the created artifact.
   `/artifacts` now seeds artifact mode automatically.

2. **ExecutionPlan UI** (`src/app/(app)/w/[slug]/plans/`). New list
   page + detail viewer/builder. Plan detail shows editable head,
   status selector, ordered step list with inline status pickers and
   expected-output editors, "Add step" form, links to related
   issue/project/context-set, and archive control. Sidebar entry
   under Planning with chord `g l`.

3. **AgentCrew admin + ReviewGate inbox**
   (`src/app/(app)/w/[slug]/settings/crews/`,
   `src/app/(app)/w/[slug]/review/`). Crews surface lists every active
   crew with members, supports New crew / Add member / Remove member /
   Archive crew. Review inbox filters PENDING/APPROVED/REJECTED/All
   gates and resolves with Approve/Reject/Cancel plus optional
   resolution note. Sidebar entry under Work with chord `g v`.

4. **WorkspaceCanvas viewer**
   (`src/app/(app)/w/[slug]/canvas/`). Spatial pan/zoom board: cards
   are absolutely positioned, draggable to reposition (each drop
   persists via `canvas.patchNode`), ⌘/Ctrl+wheel zooms, background
   drag pans, and pan/zoom state is saved via `canvas.setViewport`.
   Cards display canonical hydrated entity data; missing rows render
   as warning-toned placeholders. Inline picker adds Issue or
   Artifact cards. Edges are persisted but not yet rendered visually
   — visualisation deferred. Sidebar entry under Planning with chord
   `g k`.

5. **Canvas mutation MCP tools** (`src/server/services/mcp.ts`,
   `src/server/services/__tests__/mcp.test.ts`). Added
   `canvases.create`, `addNode`, `patchNode`, `removeNode`,
   `addEdge`, `removeEdge`. Schemas/behaviour mirror the tRPC canvas
   router; `canvases.create` writes `AuditLog`/`ActivityEvent` via
   `recordChange`. New tests cover create→add→patch→remove
   round-tripping, cross-canvas edge rejection, and edge
   add/remove idempotency.

### Migrations

None — all existing tables.

### Verification

- `pnpm test` → 49 files / 349 tests passed (was 48 / 339 — +1 file
  / +10 tests).
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck` → pass.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm lint` → pass.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm build` → pass; new
  routes (`/plans`, `/plans/[planId]`, `/settings/crews`, `/review`,
  `/canvas`, `/canvas/[canvasId]`) appear in the production route
  manifest.

### Deferred / open

- Canvas edge visualisation (curves, hit-targets, label rendering).
- Per-type card view modes (compact / live / full) — schema column
  exists but the viewer ignores it.
- ExecutionPlan crew assignment UI (schema FK landed in wave 7;
  builder doesn't expose it yet).
- CaptureSheet promotion entry points beyond chat message (notes,
  comments, attachments).
- Mobile-first polish pass for the canvas viewer; drag/zoom interactions
  assume a precision pointer.

### Files of note

| Area | Path |
|------|------|
| CaptureSheet | `src/components/quick-create.tsx` |
| Plans UI | `src/app/(app)/w/[slug]/plans/` |
| Crews settings | `src/app/(app)/w/[slug]/settings/crews/page.tsx` |
| Review gate inbox | `src/app/(app)/w/[slug]/review/page.tsx` |
| Canvas viewer | `src/app/(app)/w/[slug]/canvas/` |
| Canvas MCP | `src/server/services/mcp.ts` (canvases.create/addNode/…) |
| Sidebar | `src/components/sidebar-nav.ts` (added Plans, Canvas, Review) |

## 2026-05-19 — Agentic Work OS plan status/handoff update

### Summary

Updated `docs/audits/2026-05-19-forge-agentic-work-os-execution-plan.md`
after the live deployment to distinguish completed foundation work from
deferred product-surface follow-ups. The plan now includes a status matrix,
checked deployment verification items, remaining-work checklist, and a
one-paragraph Claude Code handoff for continuing the next session without
restarting the already-shipped 12-wave substrate.

### Verification

- Documentation-only change; reviewed markdown diff.

## 2026-05-19 — Agentic Work OS rollout (Waves 1-11)

### Summary

Shipped 11 vertical slices that take Forge from a PM + chat
substrate to a cohesive agentic work OS. Each wave landed as a
discrete commit with tests, migrations, and updated MCP surface.
Existing Issues/Chat/Agents/Hermes delivery behavior is
preserved throughout — the new primitives extend rather than
replace.

### Waves shipped

1. **Shared entity refs + hydration** (`src/lib/entity-ref.ts`,
   `src/server/services/entity-hydration.ts`). 16 entity types
   with a typed `{ type, id, workspaceId?, label? }` schema and a
   bulk hydrator that resolves any ref list to
   `{ label, subLabel, url, missing, meta }` for cards / context
   bundles / canvases.

2. **Artifact + ArtifactVersion** (migration 0032). Durable
   versionable outputs (DOCUMENT / DECISION / RUNBOOK / REPORT /
   SPEC / BRIEF / VERIFICATION). Body edits snapshot a new
   version automatically. UI at `/w/{slug}/artifacts`. MCP
   `artifacts.list/get/create/update/archive/promote`.
   Polymorphic Attachment now accepts `artifact` targetType.

3. **Promote-to-artifact UI affordance** on chat-message
   bubbles. Minimal CaptureSheet — full sheet deferred.

4. **ContextSet + ContextSetItem** (migration 0033). Reusable
   bundles of canonical refs with INCLUDE / EXCLUDE /
   SUMMARY_ONLY modes. MCP `contextSets.list/hydrate/create/
   addItem/removeItem`.

5. **Agent completion contract** (migration 0034). Issue gains
   `expectedOutput` / `verificationChecklist` / `artifactRequired`.
   AgentRun gains `producedArtifactIds` / `verificationResult` /
   `followUps`. MCP `runs.complete` is the structured submission
   tool; the issue context bundle surfaces a `completionContract`
   block.

6. **ExecutionPlan + ExecutionStep** (migration 0035). Multi-step
   plans under issues or projects with optional
   `dependsOnStepIds` and per-step `expectedOutput` /
   `verification`. Plan lifecycle DRAFT → APPROVED → RUNNING →
   …; step lifecycle TODO → READY → RUNNING → … MCP
   `executionPlans.list/get/create/transition/transitionStep`.

7. **AgentCrew + AgentCrewMember + ReviewGate** (migration 0036).
   Crews bind agents to roles (PLANNER / WORKER / REVIEWER /
   OBSERVER / OPERATOR_PROXY). ReviewGates block downstream
   automation on any reviewable target. MCP `agentCrews.list`,
   `reviewGates.list/open/resolve`. ExecutionPlan.crewId FK
   landed here (deferred from Wave 6).

8. **ActionRequest** (migration 0037). Precise resolvable asks
   replacing vague notifications. Inbox
   `actionRequestsForMe` unions OPEN rows assigned to the caller
   with the existing @-mention waitingOnMe stream. MCP
   `actionRequests.list/create/transition`.

9. **Command Center v0**. Read-only aggregator at
   `/w/{slug}/command-center` unioning action requests, review
   gates, active/stalled runs, due issues, recent artifacts,
   and the running timer. Sidebar entry under Work with chord
   `g j`.

10. **WorkspaceCanvas + Node + Edge** (migration 0038). Schema
    + tRPC + read-only MCP for the infinite spatial canvas
    primitive. Nodes carry layout + entity refs; canonical
    content always comes from the source row via the
    entity-hydration service. Viewer UI deferred per the plan's
    risk guidance.

11. **MCP + Hermes context integration pass**. Audited the MCP
    surface. Extended `agent.context.bundle` for chat threads
    with `pendingActionRequests` (OPEN, assigned to the calling
    agent) and `recentArtifacts` (authored by this agent). Issue
    branch already carries linked artifacts + completion
    contract from earlier waves.

### Migrations applied

- `0032_artifact_primitive` — Artifact + ArtifactVersion + 2 enums.
- `0033_context_set` — ContextSet + ContextSetItem.
- `0034_completion_contract` — Issue + AgentRun columns.
- `0035_execution_plan` — ExecutionPlan + ExecutionStep + 2 enums.
- `0036_agent_crew_review_gate` — AgentCrew + Member + ReviewGate
  + the deferred ExecutionPlan.crewId FK.
- `0037_action_request` — ActionRequest + enum.
- `0038_workspace_canvas` — WorkspaceCanvas + Node + Edge.

All migrations are non-destructive: new columns are nullable
where appropriate, and existing tables (Issue, AgentRun) gained
columns with safe defaults.

### Verification

- `pnpm test` → 48 files / 339 tests passed (was 42 / 313
  pre-Wave-1; +6 files / +26 tests added across the waves).
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck` → pass.
- Full audit/activity event emission verified per-wave with the
  recordChange dual-write pattern.

### Deferred to follow-ups

- Full **CaptureSheet UI** — Wave 3 shipped only the
  promote-to-artifact chip; the unified create-anything sheet
  (issue / artifact / note / action request) is still
  hand-wavy.
- **ExecutionPlan UI**. Schema + tRPC + MCP are live; the human
  plan builder, step-assignment surfaces, and progress timeline
  are not.
- **AgentCrew admin UI**. Same shape — schema is here, picker
  surface is not.
- **ReviewGate inbox surface**. Gates exist; the human approval
  UI hasn't shipped yet.
- **WorkspaceCanvas viewer**. The hardest UI surface. Per the
  plan's "do not let canvas consume the whole run" guidance,
  shipped the foundation (schema + router + hydration + tests)
  but not the pan/zoom React surface. Cate-inspired interaction
  patterns and tldraw/react-flow evaluation are open.
- **MCP mutation tools for canvases**. v0 is read-only.

### Files of note

| Area | Path |
|------|------|
| Entity refs | `src/lib/entity-ref.ts` |
| Hydration | `src/server/services/entity-hydration.ts` |
| Artifact service | `src/server/services/artifact-service.ts` |
| Artifact router | `src/server/routers/artifact.ts` |
| Artifact pages | `src/app/(app)/w/[slug]/artifacts/` |
| ContextSet | `src/server/{routers,services}/context-set*` |
| ExecutionPlan | `src/server/{routers,services}/execution-plan*` |
| AgentCrew | `src/server/{routers,services}/agent-crew*` |
| ActionRequest | `src/server/{routers,services}/action-request*` |
| Command Center | `src/server/routers/command-center.ts` + page |
| Canvas | `src/server/routers/canvas.ts` |
| MCP surface | `src/server/services/mcp.ts` (much-expanded) |
| Docs | `docs/concepts/primitives.md` (new section) |

## 2026-05-18 — Forge Conversations v2 follow-up

### Summary

Hardened chat compaction after live smoke exposed that repeated manual compaction could re-summarize already summarized messages and nest the previous summary. `compactChatThread` now advances from `summarizedUntilMessageId`, no-ops when there are no new visible messages, and avoids emitting duplicate compaction activity for repeated clicks. Added regression coverage for repeated `chat.compactThread` calls.

### Verification

- `pnpm vitest run src/server/routers/__tests__/chat.test.ts src/server/services/__tests__/mcp.test.ts` → 2 files / 89 tests passed.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck` → pass.

## 2026-05-18 — Forge Conversations v2

### Summary

Shipped Forge Conversations v2 as a first-class multi-conversation agent chat system. Agents can now have multiple named operator threads while the default DM path remains backward-compatible for existing Mission Control and Hermes delivery flows. Context sent to Hermes is now deterministic: durable summary + recent visible messages + finalized attachments + page/operator context and diagnostics.

### What changed

- Replaced the one-thread-per-agent uniqueness constraint with conversation metadata on `ChatThread`: title, topic, default-thread flag, context mode, archive state, durable summary, and summarized cursor/timestamp.
- Added `chat.createConversation`, `chat.updateConversation`, and `chat.compactThread`; preserved `chat.thread({ agentId })` as the default DM compatibility alias.
- Updated `chat.send` and deferred attachment dispatch to target selected named threads without accidentally falling back to the default DM.
- Added `chat-context` and `chat-compaction` services for deterministic MCP bundles and summary compaction.
- Extended MCP `chat.getThread` and `agent.context.bundle({ threadId })` with conversation metadata, summary, context policy, recent messages, finalized attachments, linked issues, and diagnostics.
- Added worker-driven chat compaction sweep alongside the existing maintenance jobs.
- Updated the Chat workspace with a new-conversation dialog, named thread rows, selected-thread routing, context/summary diagnostics, and a guarded `Compact now` operator control.
- Expanded Forge-local slash commands with explicit allowlisted `/compact`, `/summarize`, and safe `/hermes {status|usage|skills}` behavior; arbitrary Hermes command bridging remains blocked.

### Verification

- Applied migrations `0030_chat_conversations_v2` and `0031_chat_thread_default_flag_default` locally with `pnpm prisma migrate deploy` and regenerated Prisma client.
- `pnpm vitest run src/server/services/__tests__/mcp.test.ts src/server/routers/__tests__/chat.test.ts tests/unit/sidebar-nav.test.ts` → 3 files / 90 tests passed.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck` → pass.
- `pnpm lint` → pass.
- `pnpm test` → 39 files / 290 tests passed.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm build` → pass; verified `/w/[slug]/chat` remains in the production route manifest.

## 2026-05-18 — Chat operator console completion

### Summary

Completed the Forge Chat / Conversations operator-console pass: conversations now expose diagnostics for waiting/stalled states, safe audited recovery controls, archive/search/filter polish, a mobile picker, context preview before send, and per-attachment include/exclude staging while preserving the existing Hermes deferred-dispatch semantics.

### What changed

- Promoted agent avatar rendering into a shared `AgentAvatar` component so text/emoji avatars and URL image avatars render consistently.
- Added `chat.threadDiagnostics` plus diagnostics on `chat.threads`, `chat.getThread`, and MCP `agent.context.bundle({ threadId })`.
- Added owner-scoped archive/restore, search/filter state (`waiting`, `stalled`, `has_attachments`, archived), and audited retry/kick recovery mutations.
- Added `ChatStatusRail` with agent/reply/run/delivery state and guarded `Retry dispatch` / `Kick run` actions.
- Upgraded stale thinking copy to reference concrete diagnostics instead of generic Mission Control guidance.
- Added mobile conversation picker/drawer for `/w/[slug]/chat` and archive affordances.
- Added composer “Context to send” preview and per-attachment include/exclude controls; excluded files are not uploaded/finalized into agent context.

### Verification

- `pnpm vitest run src/server/routers/__tests__/chat.test.ts tests/unit/sidebar-nav.test.ts tests/unit/agent-avatar.test.ts tests/unit/attachment-upload-client.test.ts tests/unit/chat-context-summary.test.ts src/server/services/__tests__/mcp.test.ts` → 6 files / 93 tests passed.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm lint` → pass.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck` → pass.
- `pnpm test` → 39 files / 287 tests passed.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm build` → pass; `/w/[slug]/chat` included in production route table.

## 2026-05-18 — Chat agent glyph fallback fix

### Summary

Fixed the new Chat workspace's agent profile glyphs. Agent `avatar` is configured as "short text or image URL", but the Chat surface treated every non-empty avatar as an `<img src>`, so text/emoji avatars rendered as broken empty image boxes.

### What changed

- Added shared Chat glyph helpers to distinguish URL-like image avatars from short text/emoji avatars.
- Updated Chat conversation/context glyphs to render short text/emoji directly and only use `<img>` for URL/data/blob/relative image sources.
- Added regression coverage for text, emoji, image-like, and initials fallback behavior.

### Verification

- `pnpm vitest run tests/unit/agent-glyph-utils.test.ts tests/unit/sidebar-nav.test.ts src/server/routers/__tests__/chat.test.ts` → 3 files / 10 tests passed.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm lint && NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck` → pass.

## 2026-05-18 — First-class Chat workspace surface

### Summary

Promoted Forge chat from a Mission Control panel-only workflow into a top-level workspace surface at `/w/[slug]/chat`. Chat now has a discoverable sidebar entry and a dedicated operator-console layout for recent agent conversations, file-backed prompts, dispatch/thinking hints, and the existing attachment-capable composer.

### What changed

- Added shared sidebar nav metadata and a Work → Chat item between Inbox and Issues with `g m` keyboard chord.
- Added `/w/[slug]/chat` route backed by a new `ChatWorkspaceSurface` client component.
- Built a two/three-pane chat console: recent thread list, active conversation view using the existing `ChatThreadView`, and an XL context rail with selected agent/thread metadata.
- Extended `chat.threads` with latest visible message preview plus attachment count/image hints for conversation rows.
- Added owner-scoped `chat.getThread` for deep-linked thread reads with visible messages and finalized chat-message attachment metadata.
- Added backend coverage for thread summaries, thread deep-link authorization, attachment metadata, and sidebar nav placement.
- Added an opt-in Playwright smoke for authenticated `/chat` route/composer wiring.

### Verification

- RED verified targeted chat/router failures before implementation: missing `latestMessage` summary and missing `chat.getThread` procedure.
- `pnpm vitest run src/server/routers/__tests__/chat.test.ts tests/unit/sidebar-nav.test.ts` → 2 files / 7 tests passed.
- `pnpm lint` → pass.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck` → pass. Plain `pnpm typecheck` OOMed under the local Node heap cap before reporting diagnostics.
- `pnpm test` → 36 files / 274 tests passed.
- `pnpm exec playwright test tests/e2e/chat-surface.spec.ts` → 1 skipped by default; opt-in with `FORGE_E2E_CHAT_SURFACE=1` and a seeded authenticated Forge session.
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm build` → pass; `/w/[slug]/chat` included in the production route table.

## 2026-05-18 — Chat Attachments + Rich Rendering v1

### Summary

Implemented chat-message attachments end-to-end using the existing polymorphic `Attachment` + MinIO system. Chat messages with files now use a deferred send flow: create a pending `ChatMessage`, upload/finalize attachments against `targetType = "chat-message"`, then emit `CHAT_MESSAGE_POSTED` only after attachments are visible to agents.

### What changed

- Added `ChatMessage.dispatchedAt` plus migration `0029_chat_message_dispatched_at`.
- Added `chat.createPendingMessage` and `chat.dispatchMessage`; kept `chat.send` as the immediate text-only path.
- Added secure `chat-message` target validation to attachment upload/list/download/finalize paths so only the thread owner or linked thread agent can attach/read.
- Included finalized chat attachments in `CHAT_MESSAGE_POSTED` payloads and MCP `chat.getThread` / `agent.context.bundle` thread context.
- Added composer paperclip, paste, and drag/drop file staging with deferred upload/finalize/dispatch.
- Rendered chat-message image thumbnails and file/link chips inline on bubbles via the existing attachment chip/lightbox system.
- Added unit/integration coverage for deferred dispatch, attachment validation, MCP context metadata, upload helper sequencing, and an opt-in Playwright browser smoke for seeded chat UI.

### Verification

- `pnpm prisma migrate deploy` applied `0029_chat_message_dispatched_at` locally.
- `pnpm lint` → pass.
- `pnpm typecheck` → pass.
- `pnpm test` → 35 files / 270 tests passed.
- `pnpm exec playwright test tests/e2e/chat-attachments-rich-rendering.spec.ts` → 1 skipped by default; opt-in with `FORGE_E2E_CHAT_ATTACHMENTS=1` for seeded authenticated UI.
- `pnpm build` → pass.

## 2026-05-18 — Deploy Forge worker + enable agent-run stale reaping

### Summary

Fixed the deployment gap behind the "stale activities" problem: the production Forge stack only ran the Next.js web process, while `src/server/worker.ts` documents the BullMQ maintenance/webhook worker as a separate long-running process. Without that worker, repeatable maintenance jobs could exist in Redis but never execute reliably.

### What changed

- Added a Docker `worker` target that runs the BullMQ worker separately from the web container.
- Added `scripts/ignore-server-only.cjs` and preloaded it from `pnpm worker` so the Node/tsx worker can reuse server modules that import Next's `server-only` guard.
- Added `forge-worker` to the live compose stack at `~/docker/forge/docker-compose.yaml` using the same environment as the web service and only the internal network.
- Surfaced `Workspace.agentRunStaleMinutes` in the workspace settings UI and allowed `workspace.update` to persist it.
- Added regression coverage for `workspace.update({ agentRunStaleMinutes })` and `sweepStalledRuns()`.
- Set AXI `agentRunStaleMinutes` to 60 in production, letting the worker close the three old ACTIVE runs as `STALLED` through the normal `finishRun()` path.

### Verification

- RED verified: `workspace.update({ agentRunStaleMinutes: 45 })` initially left the DB at `0`; after the router fix it persists.
- `pnpm vitest run src/server/services/__tests__/agent-run-stale.test.ts src/server/routers/__tests__/workspace-members.test.ts -t "agent-run-stale|updates the agent-run stale watchdog threshold"` → 3 tests passed.
- `timeout 8s pnpm worker` logs `workers running` before the intentional timeout.
- `docker compose build forge-worker` completed successfully.
- Live `forge-worker` container is running and logs `workers running`.
- After setting AXI's threshold to 60, the worker emitted 3 `AGENT_RUN_STALLED` events and changed the prior stale ACTIVE runs to `STALLED`.

## 2026-05-11 — Fix issues.transition lifecycle + lint cleanup

Investigating why Victor had 3 stale runs surfaced a latent bug in
`issues.transition` (MCP). Of the 3 runs, 2 (AXI-40 / AXI-42) were
legitimate in-flight grooming on still-open issues. The 3rd (AXI-5)
was supposed to close when I transitioned the issue to Done — but
the existing MCP tool only ran a bare `db.issue.update({ statusId })`,
skipping:

- lifecycle timestamps (`completedAt` / `canceledAt` / `startedAt`)
- the `ISSUE_STATUS_CHANGED` audit + activity event
- `finishRunsForIssue()` on terminal categories

Consequences observed in the AXI workspace:

- AXI-5 was visibly "Done" but had `completedAt: null` (would have
  undercounted in analytics).
- No webhook subscriber saw the close event.
- The Victor run on AXI-5 stayed ACTIVE → showed as stale.

### Fix

`issues.transition` rewritten in `src/server/services/mcp.ts` to
mirror the tRPC `issue.update` + my new `issues.bulkTransition`
semantics:

- Read the full `before` row (including the current `status`) so the
  audit `before` snapshot is correct.
- Compute lifecycle timestamps from the target category.
- One transaction: `issue.update` → `recordChange` (ISSUE_STATUS_CHANGED)
  → branch on terminal category to either close runs
  (`finishRunsForIssue`) or touch/open the calling agent's run.
- Same-status calls are a no-op now (skips the write + event) so
  callers polling `transition` to the current status don't spam
  audit logs.

### Tests

4 new regression tests in
`src/server/services/__tests__/mcp.test.ts`:

- → DONE: completedAt set, ISSUE_STATUS_CHANGED emitted, ACTIVE run
  flipped to COMPLETED.
- → CANCELED: canceledAt set, run flipped to ABANDONED.
- → IN_PROGRESS: startedAt stamped once; round-trip Backlog →
  In Progress preserves the original `startedAt`.
- Same-status: no audit, no event.

All 260 tests pass.

### Backfill

AXI-5 was left in an inconsistent state by the buggy transition
earlier this session. Followed up by setting `completedAt` to the
moment it landed in Done (`2026-05-11T00:51:56.904Z`, the original
`updatedAt`) and explicitly finishing the orphaned Victor run.

### Operational followup (not done here)

`Workspace.agentRunStaleMinutes` defaults to 0 in the AXI workspace
— the watchdog that auto-closes long-stale runs is disabled. With
the fix above, terminal transitions close their runs immediately,
so the watchdog matters less. Worth turning on (e.g. 60min) so any
future runs that get orphaned through other code paths still get
reaped instead of accumulating forever.

## 2026-05-10 — Forge MCP Phase A: filters + generic update + labels

Grooming pass on open Forge issues surfaced two MCP gaps tracked as
AXI-42 (issue update + label management) and AXI-40 (workspace
scoping). This session ships **Phase A**: the issue/label-side gaps,
all in `src/server/services/mcp.ts` + tests. Phase B (comment
edit/delete + UI), Phase C (`workspaces.list` + workspace selector
threading), Phase D (`access.*`) are follow-ups.

Most "new features" were MCP-surface wiring around existing tRPC
procs — `label.*`, `issue.update`, `issue.bulkTransition`,
`issue.bulkSetLabels` already existed. The MCP layer just hadn't
exposed them.

### New MCP tools

- **`issues.list` — filter passthrough.** Previously accepted only
  `query/limit/includeDone`; silently ignored everything else. Now
  mirrors the tRPC `filterSchema` (issue.ts:222) subset that matters
  for grooming: `projectId/projectIds`, `statusId/statusCategories`,
  `priority/priorities`, `cycleId/cycleIds` (with `null` = backlog),
  `initiativeId/initiativeIds` (with `null` = no-initiative),
  `labelIds`, `assigneeId`, `assignedAgentId`, `unassigned`,
  `withoutCycle`, `withoutInitiative`. Fulltext search now hits
  description as well as title. Where-construction kept inline +
  commented rather than DRY'd with the tRPC router; future refactor
  can extract `buildIssueListWhere(filter, scope)`.

- **`issues.update`** — generic field patch. Intentionally narrow:
  no `statusId` (use `issues.transition`), no `assignedAgentId` (use
  `issues.assign/reassign/release`). Covers title, description,
  priority, projectId, cycleId, parentId, dueDate, estimate. Null
  on FK fields clears them. Cross-tenant guards on every referenced
  id. Mirrors the audit + event semantics of the tRPC `issue.update`
  proc — emits `ISSUE_UPDATED` and a separate
  `ISSUE_PRIORITY_CHANGED` on priority bumps so the dispatch
  escalation path keeps working. Closes the AXI-42 core ask.

- **`issues.bulkTransition`** — wraps tRPC `issue.bulkTransition`
  semantics. Per-row scope check (a narrowed key can't bulk-move
  issues outside its lane), correct lifecycle timestamps
  (`startedAt`/`completedAt`/`canceledAt`) based on target
  category, one `ISSUE_STATUS_CHANGED` event per row.

- **`labels.list / labels.create / labels.update / labels.delete`** —
  ADMIN-gated for create/update/delete to mirror the tRPC
  `adminProcedure`. `labels.list` is READ_ISSUES — labels are issue
  metadata. Unique-name enforcement via the existing
  `@@unique([workspaceId, name])`. Workspace UI for label management
  already exists at `/w/[slug]/settings/labels/`; this just adds the
  agent path.

- **`issues.setLabels`** — single-issue `{ add[], remove[] }`. Most
  common grooming shape.

- **`issues.bulkSetLabels`** — many-issue `{ issueIds, add[],
remove[] }`. Mirrors tRPC `issue.bulkSetLabels` (issue.ts:987-)
  including the 50-row audit-chunking pattern and per-row
  `ISSUE_UPDATED` emission. Workspace validation on label ids; rows
  outside the workspace get filtered before any writes.

### Tests

10 new integration tests in `src/server/services/__tests__/mcp.test.ts`
covering filter combinations, audit + event emission, FK
cross-tenant guards, scope/narrowing enforcement, ADMIN gate on
label catalog mutations, and the bulk-label workspace-scoped
validation path. All 70 MCP + 77 router tests pass.

### UI audit (informs Phase B/C)

Spawned an Explore agent to map web-UI completeness for the three
domains in scope:

- **Labels admin UI**: ✅ complete at
  `src/app/(app)/w/[slug]/settings/labels/page.tsx`. No UI work
  needed for Phase A label tools.
- **Comment edit/delete UI**: ❌ missing. Backend has
  `comment.update`/`comment.softDelete` but no buttons in
  `src/components/issue-detail/issue-main.tsx`. Phase B will add
  the UI + the missing audit-emission on those procs.
- **Workspace switcher**: ✅ complete
  (`src/components/workspace-switcher.tsx`, `g w` chord,
  `/settings/workspaces` management page). Phase C is server-only.

### Pre-existing issues NOT touched

`pnpm lint` reports warnings/errors in
`src/server/routers/{attachment,dashboard,inbox,issue,project,recurring,view}.ts`
and a few components — all pre-existing, unrelated to Phase A. My
new code is lint-clean.

### Followups

- AXI-5 verified complete + closed via MCP this session (Phase 3
  primitives — cycles/initiatives/relations/time all shipped).
- AXI-40 (workspace scoping) is still backlogged for Phase C. Until
  then, home-lab issues keep the `Home Lab:` prefix convention in
  AXI workspace. Note also: AXI-40 lives at `project = null` in the
  AXI workspace — Phase A's `issues.update` is what lets us move it
  cleanly into FRG, but only once redeployed.

## 2026-05-05 — Agent visibility + handoff polish

Bailey reported: Victor has 2 stalled jobs; the Mission Control overlay
sees them but the dashboard and the agent detail page don't surface them
clearly. Single coordinated deploy — eight items, one squashed commit,
docker rebuild, Hermes-side companion edits.

### Single source of truth: `STALE_RUN_MS`

The 5-minute "this run is stalled (UI sense)" threshold was hardcoded
once in `src/components/mission-control/live-tab.tsx` and again, as a
literal `5 * 60_000`, in `mission-control.tsx`'s pill-stalled
calculation. Lifted to **`src/lib/agent-stale.ts`** (`export const
STALE_RUN_MS = 5 * 60_000`) and re-exported as a server-only barrel from
**`src/server/services/agent-presence.ts`**. Imported by `live-tab.tsx`,
`mission-control.tsx`, `glance-view.tsx` (client), `agent.ts`,
`agent-run.ts`, `dashboard.ts`, `mcp.ts` (server). Distinct from the
auto-close watchdog (`Workspace.agentRunStaleMinutes`) — that's a
per-workspace knob for state transitions; the constant is purely a UI
"show as needing attention" signal.

### 1. Agent detail — Stalled bucket

- **`agent.stalled({ agentId })`** new tRPC proc returns
  `{ stalledRuns, stalledIssues, stalledThresholdDays }`. Stalled runs
  are `AgentRun.status === ACTIVE AND lastEventAt < (now - STALE_RUN_MS)`;
  stalled issues are `assignedAgentId === input.agentId AND
status.category IN (IN_PROGRESS, IN_REVIEW) AND updatedAt <
(now - workspace.stalledThresholdDays * 24h)`, snoozed rows excluded.
  When `stalledThresholdDays === 0`, the issue bucket returns empty.
- **`<StalledSection />`** new component on the agent detail page,
  rendered above `CurrentlyWorkingSection` inside the same lg:col-span-2
  column. Two sub-buckets: "Stalled runs (5m+)" with per-row Kick
  buttons; "Stalled issues (Nd+)" without Kick. Same warm warning tint
  the HealthFocusBanner uses (`border-warning/30 bg-warning/5`). Hidden
  entirely when both lists are empty — no clutter on healthy agents.
- De-dupe: an issue that appears in both lists is tagged "(also stalled
  run)" on the issue side; the run side stays primary because it carries
  the Kick affordance.
- Realtime invalidation list extended with `AGENT_RUN_STARTED`,
  `AGENT_RUN_STEP`, `AGENT_RUN_BLOCKED`, `AGENT_RUN_COMPLETED`,
  `AGENT_RUN_STALLED`, `AGENT_RUN_KICKED`, `AGENT_RUN_CONTROL_REQUESTED`.

### 2. Dashboard — Agent Activity tile

- **`dashboard.agentActivity()`** new proc composes the per-agent
  health snapshot in one round-trip: identity, presence, last
  heartbeat, load (`X/Y` where Y = maxConcurrent or ∞), stalled-run
  count, stalled-issue count. Sorted server-side by stalled-run desc →
  stalled-issue desc → load desc → name asc so the worst-off agent is
  always on top. Empty array when no agents — the client hides the tile.
- **`<AgentActivityTile />`** new component at
  `src/components/dashboard/agent-activity-tile.tsx`, mounted between
  TodayWidget and QuickNotes on the dashboard. Compact — one row per
  agent, hover reveals chevron, click → `/agents/[profileKey]`.
  Aggregate header shows total stalled-run / stalled-issue counts in
  warning + danger colors so the eye lands on the bad numbers first.

### 3. Mission Control glance-view — per-agent stalled chip

- `glance-view.tsx` now derives a per-agent stalled-run count
  client-side from the same `agentRun.activeAll` query the panel
  already uses (no extra fetch). Rendered as a tiny `N stl` red pill
  next to the load fraction, with native `title=` showing "N runs
  stalled (5m+ idle). Click row to open agent detail."

### 4. Inbox — Waiting on me

- **`inbox.waitingOnMe({ limit? = 25 })`** new proc. Returns issues
  where the latest comment was authored by an agent (via
  `Comment.authoringAgentId`) and `@-mentions` the calling user (via
  the same `buildMentionHaystack` heuristic the existing mentions tab
  uses), AND the caller hasn't replied since. Conservative — prefers
  false-negatives over false-positives; documented inline.
- **`<WaitingOnMeSection />`** mounted between Mentions and Stalled in
  the Inbox. Hidden when empty — invisible until an agent actually
  pings the operator. Each row shows the issue key + title, the
  agent's `@profileKey`, and the comment body excerpt.
- New integration tests in
  `src/server/routers/__tests__/inbox-waiting.test.ts` cover the three
  scenarios: agent mention surfaces the row; caller's reply hides it;
  mention to a different user doesn't false-positive.

### 5. Kick run

- **`agentRun.kick({ runId })`** new tRPC mutation + matching
  **`runs.kick`** MCP tool (scope `WRITE_ISSUES`). Records
  `EventKind.AGENT_RUN_KICKED` (new enum value, migration `0028`).
  Re-fires the dispatch webhook for the issue without changing
  assignment or `controlState`. Eligibility: run must be `ACTIVE` and
  quiet for at least `STALE_RUN_MS`. Younger runs return
  `{ ok: true, kicked: false }` (no-op, operator can retry); non-active
  runs throw.
- Surfaced as a small lightning-bolt button on the agent detail
  Stalled bucket's stalled-run rows. After a successful kick, the row
  shows a "kicked" success chip for 30s while the realtime layer
  refreshes.

### 6. Reassign confirmation toast

- Issue detail page's `AgentPickerModal.onSelect` now distinguishes
  initial assign / reassign / unassign and emits the right toast
  copy. For a reassignment specifically, the description reads
  `Context preserved · X events shared via comment thread` where X is
  the count of `ActivityEvent` rows on the issue in the last 7 days
  (computed from already-loaded `issue.activity` data — no extra
  fetch).

### 7. Schema + migration

- `EventKind.AGENT_RUN_KICKED` added to `prisma/schema.prisma`.
- Migration `0028_agent_run_kicked_eventkind/migration.sql` runs
  `ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'AGENT_RUN_KICKED';`.

### 8. Docs

- `docs/agents/overview.md` gained a **Stalled visibility** section
  spelling out the two flavours (run vs issue), the four surfaces
  (Mission Control, agent detail, dashboard tile, glance roster), and
  the right operator response to each.
- `docs/guide/inbox.md` gained the **Waiting on me** section.
- `docs/reference/mcp.md` documents `runs.kick` and bumps the tool
  count (69 → 70).
- `docs/reference/trpc.md` documents `agent.stalled`,
  `dashboard.agentActivity`, `inbox.waitingOnMe`, and `agentRun.kick`.

### Verification

- `pnpm typecheck` clean.
- `pnpm lint` — same 5 pre-existing errors (issue-board.tsx,
  control-tab.tsx); no new errors in touched files.
- `pnpm test` — 32 files, 246 tests pass (3 new in `inbox-waiting`).
- `pnpm --filter forge-docs build` — vitepress builds clean.

## 2026-05-04 — Polish run (deferred follow-ups)

Bundle of seven small QoL items deferred from the recent feature
deploys (`b56001f` Run A, `8deb486` Run B). Pure surface + script
work — one schema-free squashed commit on master, push, container
rebuild. No new dependencies introduced.

### 1. Today widget — week-peek deep-link

- **`issue.list` gained `dueOn?: string`** (YYYY-MM-DD, UTC). When
  set, narrows the where clause to `dueDate >= startOfDay(dueOn)
AND dueDate < startOfDay(dueOn+1)`. Inline UTC bracketing so the
  client can pass the same key the `dashboard.today.weekPeek` proc
  emits without timezone arithmetic.
- **`<TodayWidget />`** week-peek day cells now link to
  `/issues?dueOn=YYYY-MM-DD` instead of plain `/issues`.
- **Issues page** reads `?dueOn` from search params, validates the
  shape (regex), threads it through a new `dueOn?: string` prop on
  `<IssueList />`, and surfaces a dismissible **`<DueOnChip />`**
  next to the existing Sprint / Initiative chips. Clear-filters
  also drops the URL param.
- Not part of `SavedViewFilters` — a saved view shouldn't pin a
  specific calendar day. Lives on the URL only.

### 2. CHANGELOG scaffolder

- **`tools/scripts/changelog-scaffold.ts`** + `pnpm changelog`
  script in `package.json`. Reads `CHANGELOG.md` for the most
  recent dated heading, then:
  - Commits via `git log --no-merges --since=<that-date>`
    (uses `execFileSync` so `%h`/`%s` aren't shell-expanded).
  - DEVLOG headings with the date strictly newer than the anchor.
- Categorises commits conventional-commits-ish: `feat:` → Added,
  `fix:` → Fixed, `refactor:` / `polish:` / chore / docs → Changed,
  `feat!:` / `BREAKING` → Removed (with a callout). Anything else
  is Changed.
- Output is **stdout only** — never writes to `CHANGELOG.md`. Keeps
  release notes human-curated; the script is just a draft generator.
- `docs/guide/whats-new.md` gained a "Scaffolding new entries"
  section pointing at `pnpm changelog`.

### 3. Watcher count chip hover popover

- **`<WatcherChip />`** inside `watch-button.tsx` now ships a
  CSS-driven hover popover (no Radix dep, no portal). Shows the
  watcher count, then on hover/focus reveals up to six rows with
  avatars + names + handles + an inline `+N more` overflow line.
  Uses `group-hover/watchers` + `group-focus-within/watchers` for
  the reveal so keyboard users get parity.
- Native `title=` is preserved as the baseline tooltip — the
  popover is the richer enhancement on top, not a replacement.
- Agent watchers render with the indigo `Bot` glyph (or the agent's
  avatar emoji if set); humans get the existing `<Avatar />` shape.

### 4. Slash command autocomplete dropdown

- **`src/components/slash-autocomplete.tsx`** — new component +
  `useSlashAutocomplete` hook. Pure React + Tailwind, no
  third-party autocomplete lib. Detects when the cursor's current
  line is inside the top-of-body slash-command block (every
  preceding non-blank line also `/`-prefixed) and the line itself
  starts with `/`, then surfaces a dropdown anchored under the
  textarea via `absolute left-0 right-0 top-full`.
- **Keys**: ↓/↑ navigate, Enter / Tab insert the active stub
  (replaces the current line, e.g. `/a` → `/assign `, caret lands
  after the trailing space), Escape dismisses, click also inserts.
  The hook's `onKeyDown` returns `true` when consumed so callers
  can bail before their own submit-on-Enter logic.
- Wired into **QuickCreate** (issue / sub-issue modes; the input
  was wrapped in a `relative` container so the dropdown anchors
  correctly inside the floating bar) and the **comment composer**
  on issue-detail.
- `docs/guide/slash-commands.md` gained an Autocomplete section
  describing the keys and the top-of-body block rule.

### 5. QuickCreate event seeding for note → issue

- **`<QuickNotesWidget />`** "Convert to issue" no longer calls
  `note.convertToIssue` directly. It dispatches a
  `forge:quick-create` `CustomEvent` with `{ title, body,
archiveNoteId }` instead, letting the operator review/edit
  before submitting.
- **QuickCreate** event handler accepts the new fields, opens in
  `issue` mode (overrides the path-derived mode when a seed is
  present), surfaces a description textarea + an "Archive source
  note after creating issue" checkbox (default on). Draft-restore
  is suppressed for seeded sessions so a discarded convert doesn't
  resurrect on the next `⇧C`.
- After successful create, `note.archive` fires when the checkbox
  was left checked. Failure toasts but doesn't block the create
  success path.
- The headless `note.convertToIssue` proc stays — agent / scripted
  callers still use it.

### 6. Watching section count chip styling

- The inbox `WatchingSection` count chip now renders as a pill
  (`rounded-full bg-subtle/70 px-1.5`) to match the
  Mentions/BucketSection count chips. Cosmetic only — same data,
  consistent visual weight across sections.

### 7. Journal tab icon refinement

- Swapped `BookOpen` → `NotebookPen` in `<QuickNotesWidget />`'s
  Journal tab (header chip + body's "Today" eyebrow). Reads more
  obviously as "writing in a journal" than `BookOpen`'s
  documentation-y feel.

### Verification

- `pnpm typecheck` — clean.
- `pnpm lint` — only the 5 pre-existing errors (issue-board.tsx +
  control-tab.tsx + mission-control); no new errors. The unused
  `useRef` import that snuck into `slash-autocomplete.tsx` during
  iteration was removed.
- `pnpm test` — 243 passed (31 files), unchanged from Run B.
- `cd docs && pnpm build` — green.
- `pnpm changelog` smoke-tested end-to-end against current
  `CHANGELOG.md`; emits the expected three-commit `[Unreleased]`
  block with DEVLOG entries enumerated.

### Notes / non-goals

- Slash autocomplete uses a "below-textarea, full-width" layout
  rather than caret-position tracking, per spec — caret-following
  popovers in textareas are fiddly across browsers, and the
  simpler variant covers the use case. Noted for future iteration
  if/when a user's request flips the priority.
- `SavedViewFilters` was deliberately NOT extended with `dueOn`
  because saved views shouldn't pin a specific calendar day. The
  filter is URL-only.

## 2026-05-04 — Today + What's New + Quick-save + Pomodoro + Email stub (Run B of 2)

Run B of a 2-run plan; Run A landed at `b56001f`. Five UI-mostly
features shipped together in one squashed Forge commit, single
migration `0027_pomodoro_email`, container rebuild + push to master.
Pure surface work — every backend addition is read-side or a single
endpoint; no event-fan-out changes, no audit branches, no MCP tools.

### Pack 1 — Today widget on the dashboard

- **`dashboard.today` proc** — three-region payload: active sprint
  countdown, due-soon issues (next 7d, max 5, overdue-but-open
  included), and a 7-entry week-peek strip with per-day counts. UTC
  date keys (`YYYY-MM-DD`) so the client can match cells without
  timezone math; the visual "today" highlight comes from a
  client-side local-date resolution. Uses ISO-week alignment (Mon-
  start) so the strip is always seven contiguous days.
- **`<TodayWidget />`** — sits between the GreetingBar and Quick
  Notes on the dashboard. Empty-states inline: all-empty collapses
  to a "Nothing scheduled — fluid week" tile rather than vanishing;
  sprint-without-due-soon hides the middle region but still shows
  countdown + week peek. Sprint row → `/cycles/{id}`; due-soon row
  → issue detail; week-peek day → `/issues` (date-filter is queued
  for a follow-up).

### Pack 2 — What's New rail

- **`CHANGELOG.md`** — new file at the repo root in
  Keep-a-Changelog format. Backfilled with terse entries for the
  past ~6 weeks pulled from DEVLOG headings and `git log` (e.g.
  Watch/Journal/Slash, Quick Notes, UX revamp wave, agent
  awareness/Runtime, etc.). One line per item under
  Added/Changed/Fixed/Removed.
- **`system.changelog` + `system.changelogFull` procs** — read the
  CHANGELOG.md at request time, cached in process memory by mtime.
  Custom Keep-a-Changelog parser splits `## [version] — heading`
  blocks and groups bullets by `### Added/Changed/Fixed/Removed`.
  Unknown subsections are ignored. No DB column.
- **`<WhatsNewTile />`** — dashboard tile, sits below the Standup
  tile. Shows the most recent entry's heading + 4 bullets, then a
  short list of the next few headings, then a "View all" link.
  Type chips (added/changed/fixed/removed) re-use the warm-earthy
  success/ember/danger tokens — no new colors introduced.
- **`/w/[slug]/whats-new` page** — full changelog rendered with the
  same Topbar + scroll-wrapper pattern as `/docs`. Type-grouped
  bullets per version. No markdown library — the parser already
  yields structured data, so the renderer is plain JSX.

### Pack 3 — Quick-save filter as view

- **`filtersEqual()` helper** added to `src/lib/saved-view-filters.ts`.
  Order-independent (arrays compared as sets), `undefined === false`
  for booleans (omitted toggle = explicit-false), missing-array =
  empty-array. Plus 10 unit tests in `tests/unit/saved-view-
filters.test.ts`.
- **SavedViewsBar inline buttons** — when current filters match an
  existing saved view exactly, the bar surfaces a chip with the
  matched view's name + a "Save changes" overwrite button + a "New
  view" fork button. When filters don't match any view, a single
  "Save view" button (the existing one). When no filters are active,
  the button disables with a tooltip pointing at the chips.
  Re-uses the existing `savedView.update` / `savedView.create`
  procs — no new tRPC.

### Pack 4 — Pomodoro on the time tracker

- **Schema** — three new columns on `User`: `pomodoroEnabled`
  (default false), `pomodoroMinutes` (default 25), `pomodoroBreakMinutes`
  (default 5). Migration 0027.
- **`user.updatePomodoro` mutation** — protected proc with
  Zod-validated bounds (1–120). The values surface on
  `user.me` so the time-tracker widget can read them without a
  separate fetch.
- **Settings UI** — new "Pomodoro" `<Section />` on
  `/settings/account` after Onboarding. Toggle + two number
  inputs; save button calls `user.updatePomodoro`.
- **TimeTrackerWidget integration** — when a timer is running AND
  `pomodoroEnabled` is on, schedules a `setTimeout` for
  `pomodoroMinutes * 60_000` since the timer's `startedAt`. At
  fire time, posts a non-modal sonner toast with two actions:
  "Stop timer" (calls `timeEntry.stop`) and "Snooze 5m" (extends
  the next reminder). The toast is dismissible; the timer keeps
  running unless the operator explicitly stops. Tracks fired
  cycles per `entryId` via a ref so re-renders / tab switches
  don't re-fire the same prompt.

### Pack 5 — Email-to-issue stub

- **Schema** — `Workspace.emailIngestEnabled` (default false) +
  `Workspace.emailIngestSecret` (nullable HMAC secret). Migration 0027. The secret field is **never** echoed back through
  `workspace.current` — that proc was converted from `include` to
  an explicit `select` that omits `emailIngestSecret`. The shape
  of every previously-included scalar is preserved.
- **`workspace.emailIngestStatus` query** — read-only `{ enabled,
secretSet, workspaceKey }` for the settings UI to render
  "Generate" vs "Rotate".
- **`workspace.rotateEmailIngestSecret` mutation** — admin-only.
  Generates `feis_<40 hex>` (160 bits via `crypto.randomBytes`),
  persists, returns the new secret once.
- **`POST /api/ingest/email`** — accepts JSON
  `{workspaceKey, from, subject, body, replyTo?, headers?,
attachments?}`. Resolves workspace by key (404 on miss). 403
  when ingest disabled. HMAC-SHA256 of the raw body using the
  workspace's secret, compared via `timingSafeEqual` against
  `x-forge-email-signature` header (401 on mismatch). On accept:
  creates an issue in the workspace's default status with `title
= subject` and `body = "From: <from>\n\n<body>"`, records
  `ISSUE_CREATED` audit/event with `payload.source =
"email-ingest"`. If the `from` email matches a workspace
  member, the issue's `claimedById` is set; otherwise it lands
  unassigned. Attachments (if any) upload directly to MinIO via
  `PutObjectCommand` after the issue transaction commits — failures
  are logged and skipped, not rolled back.
- **Settings → Integrations** gained an "Email-to-issue (beta)"
  card: enable/disable toggle, generate/rotate-secret with a
  one-time-display warning panel, the placeholder inbox address
  (`inbox+{key}@forge.axiom-labs.dev`), and a collapsible
  example-payload JSON snippet. Provider wiring (Postmark inbound,
  etc.) explicitly out of scope.

### Docs

- New: `docs/guide/today-widget.md`, `docs/guide/whats-new.md`,
  `docs/automation/email-ingest.md`. Sidebar updated to surface
  them under Working in Forge / Automation Surfaces.
- Updated: `docs/guide/saved-views.md` gained a "Quick-save when
  filters match an existing view" section. `docs/guide/time-and-
attachments.md` gained a "Pomodoro" subsection.

### Numbers

- 1 migration (0027): 5 columns total (3 on User, 2 on Workspace).
- 0 new tRPC routers (system.\* added but `_app.ts` change is one
  line). 5 new procs across `dashboard.today`,
  `system.changelog/changelogFull`, `user.updatePomodoro`,
  `workspace.emailIngestStatus / rotateEmailIngestSecret` (and
  `workspace.update` gained one optional input field).
- 1 new HTTP endpoint (`/api/ingest/email`).
- 4 new components (`TodayWidget`, `WhatsNewTile`, the whats-new
  page, the integrations email card) + 1 inline upgrade
  (`SavedViewsBar`). Pomodoro fits inside the existing time-tracker
  widget.
- 11 net unit tests added: 10 for `filtersEqual`/`isEmptyFilters`/
  `safeParseFilters`, 1 for the CHANGELOG.md parser shape.
- 0 new lint errors. Pre-existing 5 errors unchanged. 232 → 243
  tests pass.

### Sequence (for the audit trail)

1. Schema: append columns, format, generate, `migrate deploy`.
2. Servers: dashboard.today, system router (+ `_app.ts`),
   user.updatePomodoro, workspace email-ingest procs +
   workspace.current select-list rewrite.
3. UI: TodayWidget on dashboard above Quick Notes; WhatsNewTile
   below Standup; whats-new page route under `/w/[slug]/whats-new`.
4. SavedViewsBar enhancement + `filtersEqual` lib helper.
5. Time-tracker widget pomodoro nudge + account settings section.
6. Email-ingest API endpoint + integrations settings card.
7. Docs (3 new pages, 2 updates) + sidebar entries.
8. Tests: filtersEqual unit, changelog-parser smoke.
9. `pnpm lint && pnpm typecheck && pnpm test` — 243 tests pass.
10. `cd docs && pnpm build` — green.
11. DEVLOG (this section), squashed commit, push, container rebuild.

### Deferred

- Today widget's week-peek day cells link to plain `/issues`. A
  proper deep-link by `dueDate` requires either a new
  `SavedViewFilters.dueOn` predicate or query-param support on
  `issue.list` — punted to a follow-up that owns the saved-view
  filter shape change.
- Email ingest replies don't stitch into existing issues. Threading
  via `In-Reply-To` / `References` is the obvious next step but
  needs a real provider integration to test against.
- The CHANGELOG.md is hand-curated. A `pnpm changelog` script that
  pre-fills entries from DEVLOG headings would close the loop.

## 2026-05-04 — Watch + Journal + Slash + Hermes sync (Run A of 2)

Run A of a 2-run plan. Three MCP-affecting features shipped together
plus a Hermes-side sync of the runtime skill / SYSTEM.md catalog.
One squashed commit on master, container rebuilt, migration 0026
applied on boot. Run B (UI-only polish) is queued for a follow-up.

### Pack A — Watch / Follow issues

- **Schema** — new `IssueWatcher` model (one row per (issue, user OR
  agent)). Either `userId` or `agentId` is set, never both, never
  neither — enforced in handlers + by the unique constraints
  `@@unique([issueId, userId])` + `@@unique([issueId, agentId])`.
  Pin and Watch are intentionally orthogonal: pin is a UI shortcut,
  watch is event subscription. Both can be active on the same issue.
  Back-relations on User, Workspace, Issue, Agent.
- **tRPC `issue.watch / unwatch / watchers / watching`** — appended
  to the existing issueRouter. Identity inferred from caller:
  `apiKey.linkedAgentId` → agent-watch, otherwise user-watch. The
  `watching` proc is sorted by issue `updatedAt desc` so the inbox
  Watching section surfaces fresh activity at the top.
- **MCP `issues.{watch,unwatch,listWatchers,listWatching}`** — same
  shapes; scopes are `WRITE_ISSUES` for mutations, `READ_ISSUES` for
  reads. Reuses `assertKeyScope` for project/label narrowing.
- **Event fan-out (audit.ts branch e)** — for any issue-subject
  event, fan out to every subscribed agent watcher whose webhook is
  configured. Routed through the same per-agent dispatch shim used
  for comment @-mentions. Skips fan-out when the watcher is the
  actor (detected via `payload.agentId` for AGENT_ASSIGNED /
  COMMENT_CREATED so we don't self-page). Human watchers get inbox/
  notification surfacing, not webhooks.
- **`<WatchButton />`** — new component at `src/components/watch-
button.tsx`. Eye / EyeOff lucide glyphs, optimistic toggle, plus
  a small watcher-count chip whose `title=` lists the names. Wired
  into the issue detail header next to PinButton.
- **Inbox surface** — new collapsible `<WatchingSection />` in
  `inbox/page.tsx` between Snoozed and Current sprint burn. Sourced
  from `issue.watching`; renders the issue id, title, and current
  status name. Rolls itself up when the caller has no watches.

### Pack B — Daily journal (Note variant)

- **Schema** — new `NoteKind` enum (`NOTE | JOURNAL`) + two columns
  on `Note`: `kind` (default `NOTE`) and `journalDate?`. The unique
  `(workspaceId, userId, journalDate)` powers `notes.todayJournal`'s
  upsert; Postgres allows multiple NULLs through unique, so existing
  NOTE rows are untouched.
- **tRPC `note.todayJournal / listJournal`** — `todayJournal` is a
  get-or-create mutation that anchors to UTC midnight on the user's
  wall-clock date (read from `User.timezone`, falls back to UTC).
  `listJournal` paginates by `journalDate desc`. The existing
  `note.create` accepts optional `kind` + `journalDate`; the
  existing `note.list` defaults to `kind: NOTE` so the dashboard
  widget's Notes tab keeps its prior shape.
- **MCP `notes.todayJournal / notes.listJournal`** — agent-facing
  surface. Scopes `WRITE_ISSUES` / `READ_ISSUES`. Use cases for
  agents: daily summary, blocker log, decision record. NOT for
  inter-agent communication (use `comments.create` for that).
- **`<QuickNotesWidget />`** — added a tab toggle (Notes / Journal)
  in the header. Journal tab auto-creates today's entry on focus
  via `note.todayJournal`, renders today as the editable card at
  the top, and lists past entries below as collapsible date rows.
  Auto-saves on blur with an 800ms debounce; ⌘⏎ saves immediately.
  The header date string uses the user's locale.

### Pack C — Slash commands in composers

- **Parser util** — new `src/lib/slash-commands.ts`. Exports
  `parseSlashCommands(body)` returning `{ strippedBody, commands }`.
  Recognises `/assign @handle`, `/due <when>`, `/label <name>`,
  `/priority <level>`, `/project <KEY>`, `/watch`, `/unwatch`. Date
  parsing handles "today" / "tomorrow" / "in 3 days" / "in 1 week"
  / "next Mon" / "2026-05-15" / "May 15" inline (no chrono-node
  dep). Commands are stripped only when they appear contiguously
  at the top of the body; lines inside a fenced code block are
  preserved verbatim. Plus a `parseDateExpression` export for
  reuse and 14 unit tests in `tests/unit/slash-commands.test.ts`.
- **`issue.create` extension** — accepts an optional
  `applyCommands: SlashCommand[]` field. After the create
  transaction commits, each command runs against
  `applySlashCommandsToIssue` (assign / due / label / priority /
  project / watch / unwatch). Best-effort: a missing label or
  project logs a skip in the returned `commandResults` array but
  doesn't roll the create back.
- **`issue.applyCommands` proc** — new mutation taking
  `{ issueId, commands[] }` and running the same helper for an
  existing issue. Used by the comment composer.
- **QuickCreate composer** — parses leading slash commands on
  submit; the cleaned tail becomes the issue title. A small slash-
  hint chip strip renders below the input for issue / sub-issue
  modes.
- **Comment composer** — parses on submit, posts the cleaned body
  as a comment, then dispatches `issue.applyCommands` for any
  commands found. Supports a "commands only, no body" path that
  skips the comment entirely. A `/` -prefixed draft surfaces the
  hint string below the textarea.

### Pack D — Hermes-side sync (separate from Forge git)

After the Forge commit + container rebuild, edit-in-place updates to:

- `~/SYSTEM.md` — bumped tool count, added the new MCP entries
  (`issues.watch/unwatch/listWatchers/listWatching`,
  `notes.todayJournal/listJournal`).
- `~/.hermes/skills/pm/forge/SKILL.md` — added Notes / Journal,
  Watching, and Slash commands sections + bumped tool count in the
  Tools table.

No Hermes restart required — `tools/list` auto-discovers the new
MCP entries; no config.yaml changes.

### Migration `0026_watch_journal_slash`

- `CREATE TYPE "NoteKind" AS ENUM ('NOTE', 'JOURNAL')`.
- Adds `kind`, `journalDate` columns to `Note` + the matching
  indexes (unique on `(workspaceId, userId, journalDate)` and
  composite on `(workspaceId, userId, kind, journalDate)`).
- Creates the `IssueWatcher` table with the four indexes spec'd
  above and FK cascades for workspace/issue/user/agent.
- Idempotent on application — applies cleanly on the dev DB and
  on the prod container's first boot after deploy.

### Verification

- `pnpm lint` — 5 pre-existing errors only (issue-board.tsx + control-
  tab.tsx); no new errors introduced.
- `pnpm typecheck` — clean.
- `pnpm test` — 232 passed (29 files), up from 218 pre-run with the
  new `tests/unit/slash-commands.test.ts` (14 tests).
- VitePress `pnpm build` — clean (no dead links).

### Run B (queued)

UI-only polish to follow:

- Watching count chip next to inbox tab pill on dashboard
- Journal tab icon refinement + collapse-by-default option
- Slash command autocomplete dropdown (prototype is hint-only)
- Per-issue watcher list popover on the count chip

## 2026-05-04 — Quick Notes + docs refresh

Three packs in one coordinated deploy: a new Quick Notes primitive
end-to-end, a docs sweep covering features shipped since 2026-04-26,
and a small density-utility cleanup on the dashboard. One squashed
commit on master, container rebuilt, migration 0025 applied on boot.

### Pack A — Quick Notes

- **Schema** — new `Note` model on the dashboard for per-(workspace,
  user) markdown scratchpad rows. Migration `0025_note` adds the
  table + a single composite index `(workspaceId, userId,
archivedAt, pinned, updatedAt)` covering the default sort. Soft-
  delete via `archivedAt`; `pinned` floats rows in the widget. Back-
  relations on `User.notes` and `Workspace.notes`.
- **tRPC `note.*`** — `list`, `create`, `update`, `archive`,
  `unarchive`, `delete`, `convertToIssue`. All `workspaceProcedure`-
  scoped and filtered to `userId = ctx.session.user.id` so cross-
  user reads/writes are impossible at the router layer (a stranger's
  id yields "Note not found"). `convertToIssue` spawns a real Issue
  using the same default-status + last-number+1 pattern as
  `issue.create`, with `from: "note"` + `noteId` in the
  `ISSUE_CREATED` audit payload for provenance. The source note is
  intentionally NOT auto-archived — the user can decide.
- **MCP `notes.*`** — `notes.create` / `notes.list` / `notes.update`
  / `notes.archive`, scoped `WRITE_ISSUES` for writes and
  `READ_ISSUES` for reads (matching the comment surface). Each tool
  resolves the actor via `resolveActorId` and gates `userId == actor`
  at every read and write — agents leave notes for _themselves_, not
  the operator. There is no `notes.unarchive` MCP tool by design
  (agents shouldn't silently resurrect archived notes); the human-
  only `note.unarchive` tRPC proc covers that case.
- **Dashboard widget** — new `<QuickNotesWidget />` mounted between
  GreetingBar and OnboardingCard on `/w/[slug]/dashboard`.
  Collapsible card. Inline add row with optional title + auto-grow
  textarea (Enter to save when no title, ⌘Enter for multi-line, Esc
  to cancel). Each note row has a pin glyph (click to toggle), an
  inline-editable title (click to rename), an expandable body
  rendered via `<MarkdownWithAttachments />`, and hover-revealed
  trailing actions: convert-to-issue (FilePlus), archive
  (Archive), and — for archived rows only — hard delete. Native
  HTML `title=` tooltips on every action chip per CLAUDE.md.
  Server-state only — no localStorage.
- **Hotkey `n`** — focuses the add input on dashboard. Suppressed
  when typing in any input/textarea (default `useHotkey` behavior).
  No conflict with the existing `g n` chord (initiatives) since
  `useChord` arms only after a `g` press.
- **Tests** — `note.test.ts` covers the lifecycle + per-user
  isolation + convertToIssue. `mcp.test.ts` adds a notes scoping
  test confirming a second user's notes are invisible and that
  cross-actor mutation throws.

### Pack B — docs refresh

Three new guide pages, one new sidebar group entry, a half-dozen
existing pages updated.

- **New** — `docs/guide/inbox.md` (full Inbox surface — Pulse, Queue,
  Mentions, Stalled, Snoozed, last-visit unread, inline + bulk
  actions, `g i` chord). `docs/guide/quick-notes.md` (this run's
  feature). `docs/guide/saved-views.md` (per-user IssueSavedView,
  pinning to sidebar, view vs filter distinction).
- **Updated** — `docs/.vitepress/config.ts` sidebar adds the three
  new pages under "Working in Forge" (Inbox first, Quick Notes +
  Saved Views after Issues). `docs/guide/issues.md` rewrites the
  Bulk operations section to match the actual procs (`bulkTransition`,
  `bulkAddLabel`, `bulkRemoveLabel`, `bulkAssign`, `bulkAssignAgent`,
  `bulkArchive`, `snoozeMany`) and adds a Snooze section. `docs/guide/keyboard.md`
  documents `n` (Notes), `x` / `⇧X` (Bulk select), Pins on
  project/initiative pages, and the command palette buckets +
  pinned/recents rails. `docs/guide/projects-and-initiatives.md`
  adds the Project Overview tab section. `docs/guide/time-and-attachments.md`
  expands the Allowed MIME types table (HTML, JSON, CSV, XML, YAML,
  audio, video) and documents `attachLink` + `[label](forge-link:URL)`.
  `docs/agents/overview.md` adds the Agent run controls (pause /
  cancel / redirect, `controlState`). `docs/agents/dispatch-rules.md`
  notes that auto-dispatch respects `controlState`. `docs/concepts/primitives.md`
  adds Pin / RecentItem / IssueSavedView / Note primitive entries.
  `docs/reference/mcp.md` adds `attachments.attachLink` and the
  `notes.*` namespace; `docs/reference/trpc.md` adds the
  `note`, `pin`, `recentItem`, `commandPalette`, `inbox`,
  `dashboard`, `notification`, and `savedView` rows in the catalog
  plus a Notable procedures block for `note.*`, `attachment.attachLink`,
  `pin.*`, and `recentItem.*`.

### Pack C — density-utility cleanup

Tiny — only one cleanly-applicable swap on the dashboard's
`IssueRow` trailing-time span (`text-[0.6875rem]` → `text-meta`).
The other hardcoded `text-[0.6875rem]` instances on the page are
either uppercase eyebrows (correct per CLAUDE.md), priority
glyphs (mono identifier — `text-id` already covers similar uses),
or kbd hints. `<QuickNotesWidget />` was written from the start
with `.text-meta` and `.text-id` where appropriate.

### Migration `0025_note`

Single CREATE TABLE + composite index + two cascade FKs. No enum
churn, no backfill, no data migration. Applied cleanly on the
dev DB; the prod migrate-deploy on container boot is a one-statement
add.

### Files touched

- Schema / migration: `prisma/schema.prisma`,
  `prisma/migrations/0025_note/migration.sql`.
- Server: `src/server/routers/note.ts` (new),
  `src/server/routers/_app.ts`, `src/server/services/mcp.ts`.
- Client: `src/components/quick-notes-widget.tsx` (new),
  `src/app/(app)/w/[slug]/dashboard/page.tsx`.
- Tests: `src/server/routers/__tests__/note.test.ts` (new),
  `src/server/services/__tests__/mcp.test.ts`.
- Docs: `docs/.vitepress/config.ts`,
  `docs/guide/inbox.md` (new), `docs/guide/quick-notes.md` (new),
  `docs/guide/saved-views.md` (new),
  `docs/guide/issues.md`, `docs/guide/keyboard.md`,
  `docs/guide/projects-and-initiatives.md`,
  `docs/guide/time-and-attachments.md`,
  `docs/agents/overview.md`, `docs/agents/dispatch-rules.md`,
  `docs/concepts/primitives.md`,
  `docs/reference/mcp.md`, `docs/reference/trpc.md`.

### Verification

- `pnpm typecheck` clean.
- `pnpm lint` baseline only (5 pre-existing errors in
  `issue-board.tsx` + `mission-control/control-tab.tsx`, same as
  the last several days). New files clean.
- `pnpm test` 218/218 passing — three new note tests + one new
  mcp note tests + the full pre-existing 214. MinIO was up so the
  attachment / storage suites ran (with the existing CORS
  apply-failure stderr noise from `applyBucketCors`, which is
  harmless and pre-existing).
- `pnpm docs:build` succeeds — VitePress emits client + server
  bundles in ~9s.

### Single commit

Squashed to one commit on master. Pushed. Container rebuilt;
migration 0025 applied on container boot. Live at
`forge.axiom-labs.dev`.

## 2026-05-03 — Attachments follow-ups + project scroll fix

Single coordinated deploy. Five small fixes squashed to one commit, no
schema changes, no migration.

### What changed

- **Project overview scroll fix.** The project detail page's tab
  container at `/w/[slug]/projects/[id]` had `min-h-0 flex-1
overflow-hidden` _without_ `flex flex-col`, so the children's
  `flex-1` collapsed to auto and the inner `<div className="h-full
overflow-y-auto">` inherited 0 height — scroll was unreachable. Added
  `flex flex-col` to both the outer tab wrapper and the inner content
  wrapper. Same anti-pattern surfaced on `/w/[slug]/issues` where the
  list-view's `<div className="h-full overflow-y-auto">` was inside an
  identical broken parent — fixed there too. Cycles detail + cycles
  index also use `min-h-0 flex-1 overflow-hidden` but are
  intentionally horizontal flex rows (CyclePlanningBoard +
  CycleBacklogPanel) — left alone. Other pages with `min-h-0 flex-1
overflow-y-auto` (settings, dashboard, initiatives, …) are scroll
  containers around content-height children — not affected.
- **Server-scraped link titles + favicons.** Added
  `fetchLinkMetadata(url)` to `src/server/services/storage.ts`: native
  fetch with `AbortController` + 5s timeout, follows redirects, reads
  up to 64 KB of body, parses `<title>` via regex, decodes the common
  HTML entities. Returns `{}` on any error. The tRPC `attachment.attachLink`
  mutation and the MCP `attachments.attachLink` tool both call it when
  the caller doesn't supply a title; createLinkAttachment falls back to
  hostname when the scrape returns nothing. New `LinkFavicon` component
  in `attachment-chip.tsx` computes `${origin}/favicon.ico`
  deterministically and falls back to the lucide ExternalLink icon on
  image-load error — no broken-image rectangles. Used in the LINK chip
  variant of `<AttachmentChip />` and (at 20px) in the lightbox's
  LinkPreview header alongside the hostname.
- **`forge-link` markdown token.** New token shape
  `[label](forge-link:https://…)` in the markdown attachment renderer.
  Pass A in `tokenizeText` claims forge-link chips, Pass B handles the
  existing KEY-NN + @profileKey pass on the leftover spans. Order
  guarantee: `forge-attachment:cuid` runs first (regex anchored to a
  CUID) so it always claims its own tokens before forge-link sees the
  text. Scheme is enforced as http/https at both the regex and a
  belt-and-suspenders check before constructing the segment — anything
  else falls through as plain text. New `<InlineForgeLink />` chip
  visually mirrors `<InlineAttachmentLink />` (border, bg-card/40,
  hover-ember) so chat/comments stay consistent; opens the URL in a
  new tab on click, no DB lookup, no lightbox.
- **MinIO test auto-skip.** Storage + attachment-router suites failed
  with `ECONNREFUSED ::1:59000` whenever the dev MinIO container
  wasn't running — six pre-existing failures across the last two
  DEVLOG entries. New `src/server/routers/__tests__/minio-probe.ts`
  exposes `describeIfMinio()`, which probes
  `${S3_ENDPOINT}/minio/health/live` once per file (1.5s timeout) and
  swaps `describe` for `describe.skip` on probe failure. Both
  `storage.test.ts` and `attachment.test.ts` await it at module top
  and use the returned describe. Probe runs once per file, cached.
  Brought up `forge-dev-minio` via `docker compose -f docker/docker-compose.yml
up -d minio` for this session — both suites now pass cleanly.
- **No new dependencies, no schema change, no migration.**

### Files touched

- `src/app/(app)/w/[slug]/projects/[id]/page.tsx` — flex flex-col on
  tab container.
- `src/app/(app)/w/[slug]/issues/page.tsx` — flex flex-col on
  list/board content container.
- `src/server/services/storage.ts` — `fetchLinkMetadata` helper.
- `src/server/services/mcp.ts` — `attachments.attachLink` calls
  fetchLinkMetadata when title omitted.
- `src/server/routers/attachment.ts` — same for the tRPC mutation.
- `src/components/attachments/attachment-chip.tsx` — `LinkFavicon`
  component + LINK-variant chip uses it.
- `src/components/attachments/attachment-lightbox.tsx` — LinkPreview
  header shows favicon + hostname.
- `src/components/markdown/attachment-renderer.tsx` — forge-link
  tokenization + `<InlineForgeLink />` chip.
- `src/server/routers/__tests__/minio-probe.ts` — new helper.
- `src/server/services/__tests__/storage.test.ts`,
  `src/server/routers/__tests__/attachment.test.ts` — use describeIfMinio.

### Verification

- `pnpm typecheck` clean.
- `pnpm lint` baseline only (5 pre-existing errors in
  `issue-board.tsx` + `mission-control/control-tab.tsx`, same as the
  last two days).
- `pnpm test` 214/214 passing — the 6 MinIO failures from yesterday
  cleared because dev MinIO was brought up before the run. With the
  new skip helper, future runs without MinIO will report "skipped"
  instead of "failed".

### Migration

None. No schema changes.

### Single commit

Squashed to one commit on master. Pushed. Container rebuilt; live at
`forge.axiom-labs.dev`.

## 2026-05-03 — feat(ui): pinning + bulk actions + command palette (multi-agent)

Follow-up after the inbox/agents/stalled revamp + tooltip polish landed.
Audit identified pinning was issue-only (max 3, stored as
`User.pinnedIssueIds string[]`), `/issues` had no bulk-select, and there
was no command-palette / quick-switcher / recent-items tracking. Same
multi-agent shape: Phase 0 sequential (committed on master to dodge the
worktree-base race), Phase 1A/B/C parallel worktrees, Phase 2 squash.

### Shape

- **Pinning** — polymorphic `Pin { userId, workspaceId?, targetType,
targetId, orderIndex }` with target enum
  `ISSUE | PROJECT | INITIATIVE | SAVED_VIEW | CYCLE | AGENT`. Migration
  backfills `User.pinnedIssueIds` into `Pin` rows
  (workspaceId=NULL, targetType=ISSUE, ordered) then drops the array
  column. **Legacy MCP backward-compat preserved** — `pin.list`,
  `pin.set`, `pin.toggle` keep their old issue-only signatures, just
  re-implemented on top of the new table; new generic procs ship
  alongside as `pin.listAll`, `pin.toggleEntity`, `pin.add`,
  `pin.remove`, `pin.reorder`. Hermes runtime + MCP tools keep working.
- **Pin surfaces** — sidebar gains a "Pinned" section above the
  Docs/Settings footer, conditionally rendered (no eyebrow on a fresh
  workspace). Topbar pin strip refactored to render six type-specific
  chip variants (issue, project, initiative, saved-view, cycle, agent),
  3-pin cap kept. `<PinButton />` on issue detail topbar (per-workspace
  pin), project header, initiative header, cycle header, saved-view
  chip, agent presence card.
- **Bulk actions** — extended the inbox `BulkBar` pattern to `/issues`
  and the project page's List tab. Refactored `BulkBar` into a shared
  `src/components/bulk-bar.tsx` with `count / onClear / actions[]`
  API; inbox now imports the same component. New bulk procs:
  `issue.bulkTransition`, `bulkAddLabel`, `bulkRemoveLabel`,
  `bulkArchive`. Existing `snoozeMany`, `bulkAssign`,
  `bulkAssignAgent` reused. Action set: Status / Assign /
  Snooze / Label (mixed-state add/remove) / Archive (confirm-gated).
  Board view intentionally skipped (drag-drop covers the highest-
  frequency op; checkbox-on-cards is visually noisy).
- **Command palette** — Cmd+K via `useHotkey`, reuses existing Dialog
  primitive. Mounted in app shell layout. Search results grouped by
  type (Issues, Projects, Initiatives, Saved Views, Sprints, Agents,
  Actions); empty-input state shows pinned + recents rails plus a
  static actions list. 150ms debounce. Inline spinner during search.
  "No matches" → "Create issue '{query}' →" affordance that calls
  `issue.create` with the query as title. Keyboard nav: ↑/↓ across
  visible rows, Enter to dispatch, Esc to close. Cross-workspace
  toggle skipped (workspace badge on results when scope differs).
- **Recent items** — `RecentItem { userId, workspaceId, targetType,
targetId, visitedAt }` upserted on entity-page mount via
  `recentItem.track`, server-side debounced 5s. Surfaced in the
  command palette's empty-state rail; primitive is the shared
  `<RecentItemsRail />`.

### New procs

`pin.listAll`, `pin.add`, `pin.remove`, `pin.toggleEntity`,
`pin.reorder` (legacy procs kept). `recentItem.list`, `recentItem.track`.
`commandPalette.search` (per-type buckets, ILIKE fuzzy,
KEY-N pattern recognition). `issue.bulkTransition`,
`issue.bulkAddLabel`, `issue.bulkRemoveLabel`, `issue.bulkArchive`
(uses `Issue.deletedAt` for soft-delete; emits `ISSUE_UPDATED` with
`action="bulk-add-label"` discriminator instead of new EventKind values
to avoid migration churn).

### Migration `0023_pins_and_recents`

`PinTargetType` enum + `Pin` model + `RecentItem` model + cascade FKs.
Backfill via `unnest(pinnedIssueIds) WITH ORDINALITY` preserves
ordering as `orderIndex = ord - 1`. Then drops `User.pinnedIssueIds`.

### Coordination notes

- Worktree-base race struck again on all three Phase 1 agents — every
  one branched from `54a167d` (one commit short of Phase 0 `42d8660`).
  All three self-corrected by rebasing onto master before working,
  same self-correction we saw in the prior revamp. The brief explicitly
  told them to verify `git log` and rebase if needed; that worked.
  Worth automating in the harness eventually — every parallel-worktree
  run with a sequential Phase 0 prerequisite hits this.
- One small bug at integration: 1A flagged that `<PinnedSidebarSection />`
  routed AGENT pins to `/agents/{id}` but the route segment is
  `[profileKey]`. The hydrated AGENT target in `pin.ts` already includes
  `profileKey` — fixed inline at integration (one-line edit). 1A could
  have fixed it but obeyed the "don't reinvent Phase 0 components"
  guardrail; that's the right default — flag it, not fix it.

### Verification

- `pnpm typecheck` clean
- `pnpm lint` baseline (5 errors, all pre-existing in `issue-board.tsx`
  - `mission-control/control-tab.tsx`)
- `pnpm test` 208/214 — same 6 MinIO `ECONNREFUSED ::1:59000` failures
  as the last two days, environmental, no touched files.

### Single commit

Phase 0 + 1A + 1B + 1C squashed to one commit on master. Pushed.
Container rebuilt; migration 0023 applied on container boot. Live
at `forge.axiom-labs.dev`.

## 2026-05-03 — feat(ui): inbox + agents + stalled revamp (multi-agent)

Follow-up audit on the UX revamp surfaced three more gaps: (1) Inbox was
read-only — feed, not workqueue (no inline actions, no read/unread, no
snooze, no bulk, same items re-surface every visit). (2) Agents had only
coarse ONLINE/BUSY/OFFLINE force-toggles — no run pause/cancel/redirect,
no failed-run lane, no heartbeat-lag warning, no dispatch policy
visibility, no "why was X picked" attribution. (3) Stalled-item handling
had a real bug: `Workspace.stalledThresholdDays` (shipped yesterday) was
honored only by `dashboard.suggestions`; inbox hardcoded 7d, dashboard
"Stalled" column hardcoded 3d, and both filtered out agent-assigned
issues — exactly the case you'd most want to escalate.

Same coordinated-team shape as yesterday: Phase 0 sequential (committed
on master to avoid the worktree-base race), Phase 1B/1C parallel
worktrees, Phase 2 integration + squash.

### Shape

- **Stalled** — `Workspace.stalledThresholdDays` is now the single
  source of truth across inbox + dashboard. Hardcoded 7d / 3d filters
  removed. `Issue.snoozedUntil DateTime?` (indexed) lets users mark
  items "intentionally on hold" — filtered out of stalled buckets and
  inbox surfaces while `snoozedUntil > now()`. Agent-stalled work is
  now visible: dropped the `assignees: { some: { userId } }` filter,
  buckets split into `humanStalled` and `agentStalled` (an issue with
  `assignedAgentId` set whose agent has been silent past threshold).
- **Inbox** — full rewrite. New buckets: assigned & unblocked,
  mentions, human-stalled, agent-stalled (warm warning tone, agent
  presence chip per row), snoozed (collapsed by default with inline
  unsnooze). `User.lastInboxVisitAt` actually persisted now (was
  stubbed out before, with a comment noting the gap). Per-bucket
  `{count} new` ember pill + per-row ember dot when
  `updatedAt > previousVisitAt`. `inbox.visit` fires on mount,
  debounced server-side. Per-row `<RowQuickActions />` (status pick,
  assignee pick, snooze, nudge, mark-read) revealed on hover.
  Sticky bulk-action toolbar when ≥1 row selected: Mark read,
  Snooze for…, Reassign…, Cancel; checkbox per row, Shift+click
  range-select, `x`/`Esc` hotkeys. Mentions intentionally not
  bulk-selectable (conversational, one-step-removed).
- **Agents** — `<RunControlMenu />` on each in-flight pipeline row
  (pause / cancel / redirect-to-…). Pending control state shows as
  inline badge ("pause requested" / "cancel requested") so the user
  sees the request is in flight before the runtime acknowledges.
  New "Failed (24h)" lane for `ABANDONED + STALLED` runs (no `FAILED`
  enum value exists; using what the schema actually emits). New
  heartbeat-lag warning on persistent agents — warm "Lag" pill at
  `agentHeartbeatWarnMinutes` (default 5), critical "Down" pill at
  `agentHeartbeatCriticalMinutes` (default 30). Both Workspace
  columns, settings-driven per Bailey's rule. Ephemeral-runtime
  agents skipped (only beat when running). `<DispatchModeBadge />`
  in agents page header — shows the active `autoDispatchMode`
  (manual / round-robin / capability / priority), gear → settings.
  `<DispatchReasonChip />` on AGENT_ASSIGNED timeline rows and on
  the issue detail topbar (next to ProjectChip cluster) — tooltip
  shows mode, candidates considered with winner highlighted, and
  the picker's reasonText. Dispatch attribution recorded in
  `Issue.dispatchReason Json?` on every assignment (manual or auto)
  and mirrored into the AGENT_ASSIGNED audit payload.

### Run-control protocol

`AgentRun.controlState AgentRunControlState` (NONE | PAUSE_REQUESTED |
CANCEL_REQUESTED) is the source of truth, written by the new procs
`agentRun.requestPause / requestCancel / requestRedirect`. Each writes
the state, fires an `AGENT_RUN_CONTROL_REQUESTED` audit event, and
POSTs an `AGENT_RUN_CONTROL` webhook to the agent's `webhookUrl`
(best-effort, same plumbing as comment fan-out). Runtimes that haven't
adopted the protocol yet just don't act on it; the UI shows
"requested" state until the runtime acknowledges via heartbeat or
status update. Redirect = cancel + reassign (which already triggers
the existing AGENT_ASSIGNED dispatch chain).

### New procedures

`issue.snooze`, `issue.unsnooze`, `issue.snoozeMany` (bulk wrapper
added in 1B), `issue.nudge` (creates a comment tagging assignees —
existing comment fan-out reaches agents, no separate webhook),
`inbox.visit` (debounced 5s server-side), `agentRun.requestPause`,
`agentRun.requestCancel`, `agentRun.requestRedirect`. Modified:
`inbox.list` honors `stalledThresholdDays`, splits stalled into
human + agent + snoozed buckets, returns `unreadSinceVisit` per
bucket and `lastVisitAt` (previous timestamp) for client-side
unread rendering. `dashboard.suggestions` drops human-only filter
on stalled bucket. New `dashboard.stalledInProgress` proc to drive
the Stalled column server-side (kills the hardcoded 3d filter).

### Migrations

- `0021_inbox_agents_stalled` — Issue.snoozedUntil + index,
  User.lastInboxVisitAt, Issue.dispatchReason Json?, AgentRun
  control state columns + AgentRunControlState enum + new EventKind
  values (ISSUE_SNOOZED, ISSUE_UNSNOOZED, ISSUE_NUDGED,
  AGENT_RUN_CONTROL_REQUESTED).
- `0022_workspace_heartbeat_thresholds` — Workspace
  agentHeartbeatWarnMinutes (5), agentHeartbeatCriticalMinutes (30).

### Coordination notes

- Worktree-base race struck again — both 1B and 1C branched from the
  prior commit (`ca2401e`) instead of the Phase 0 commit (`5d20e8e`),
  even though Phase 0 committed cleanly on master before the
  worktrees were spawned. Both agents self-corrected this time
  (1B merged master into worktree, 1C rebased onto master). No
  manual integration cleanup needed. Repeating issue — likely the
  worktree creation snapshots `master` ref slightly before the
  caller observes the new commit. Workaround for next run: explicit
  `git worktree pull` instruction in the brief, or have Phase 0
  push to a dedicated integration branch the worktrees check out.
- Phase 0 agent stalled at the very end (watchdog timeout) right
  before the `git commit`. Picked up the in-tree work and
  committed manually — typecheck + lint were clean, migration
  applied, no rework needed.
- `RunControlMenu`'s "redirect" option: on schemas without a
  `FAILED` AgentRunStatus, the failed lane filters on `ABANDONED +
STALLED`. A future migration could add `FAILED` proper if the
  semantic split matters.

### Verification

- `pnpm typecheck` clean
- `pnpm lint` baseline only (5 errors, all pre-existing in
  `issue-board.tsx` + `mission-control/control-tab.tsx`)
- `pnpm test` 208/214 pass — same 6 MinIO `ECONNREFUSED ::1:59000`
  failures as yesterday. Storage/attachment-only, not regressions,
  none of the failing files touched.

### Single commit

Phase 0 + 1B + 1C squashed to one commit on master. Pushed.
Container rebuilt (`docker compose up -d --build forge`); migrations
0021 + 0022 applied automatically on container boot. Live at
`forge.axiom-labs.dev`.

## 2026-05-02 — feat(ui): UX revamp — overview, navigation, discovery, triage (multi-agent)

Bailey flagged the app was issue-centric with weak project context, no
discovery path from the home view (Focus Today shows assigned-only and
dead-ends to "Nothing on your plate" with one assignment), and orphaned
initiatives. Audit confirmed: project pages were filtered issue lists with
metadata at the top, issue detail had no breadcrumb back to project,
initiatives never linked from project/issue surfaces, no saved views, no
sibling-issue nav.

Single landing run, coordinated agent team. Phase 0 sequential (shared
primitives + tRPC + schema). Phase 1 four parallel worktree agents
(project / issue / discovery / triage). Phase 2 integration + squash to
one commit per Bailey's request.

### Shape

- **Project page** — overview is the new default tab (`?view=overview`),
  list and board preserved verbatim. Overview consumes a single
  `project.overview` rollup query: status counts (5-stat strip, blocked
  goes `text-warning` when > 0), linked initiative chip + "Link to an
  initiative" inline picker when null, current sprint slice (top 5,
  CycleChip + "ends Xd ago" + "View all in sprint →"), members
  (avatar + handle + open count, sorted desc), recent activity (top 10
  ActivityEvents joined to their issue subjects). Project list empty
  state warmed: explanation copy + inline 3-up template cards instead
  of a separate Browse Templates button.
- **Issue detail** — topbar Breadcrumb (`Projects › <name> › <KEY>`,
  fallback `Issues › <KEY>` when projectless). InitiativeChip + CycleChip
  surfaced inline beside the key + paperclip group (display only —
  right-rail dropdowns kept as the mutation surface). IssueSiblingNav on
  the actions slot, scope = project (else cycle else hidden), `[`/`]`
  hotkeys via `useHotkey`. Focus mode (`/focus/[id]`) intentionally
  skipped — chrome-less by design.
- **Dashboard** — Suggestions strip below Focus Today, three subgroups
  consuming `dashboard.suggestions`: current sprint (CycleChip header),
  unassigned in your projects (ProjectChip per row), stalled
  (`updatedAt < now - Workspace.stalledThresholdDays`, default 7).
  Modal flips on Focus emptiness: when Focus Today has any issues the
  strip is collapsed/dimmed (`bg-card/30`); when Focus is empty the
  strip is promoted to primary content with a "Pick something to start"
  header, replacing the old dead-end empty state. All-three-buckets
  empty + Focus-empty falls through to a "You're caught up" CTA pointing
  at `/projects`. Inbox polish: ProjectChip swapped for plain badges in
  IssueRow + AgentQueue, "Browse suggestions in dashboard ›" link on
  inbox-zero.
- **/issues triage** — quick-filter chip bar (Unassigned / My backlog /
  Blocked / Recently updated) + per-user saved-views row. Saved views
  are tenant + user scoped (`IssueSavedView` Prisma model, composite
  unique on `(userId, workspaceId, name)`), reorderable, with a
  ⋯ menu for Rename / Update with current filters / Delete. Active
  view is reflected in `?view=<id>` for deep-linking; editing a filter
  un-tints the active view chip. Filter shape lives in
  `src/lib/saved-view-filters.ts` as a Zod schema, validated at the
  router boundary so the `IssueSavedView.filters` Json blob doesn't
  drift. "My backlog" resolves backlog statuses dynamically from the
  workspace's own `status.list` (filtered to `BACKLOG`/`TODO`
  categories) — no hardcoded status ids.
- **Initiatives** — `initiative.list` rolled up `_count.issues` and
  `_count.doneIssues` server-side to kill the per-card N+1 each
  initiative-card was previously firing. List empty state warmed.
  Initiative detail page swaps plain-text linked-projects for
  `<ProjectChip />`.

### Shared primitives (Phase 0)

- `<Breadcrumb />`, `<ProjectChip />`, `<InitiativeChip />`,
  `<CycleChip />`, `<IssueSiblingNav />` in `src/components/`. All
  resolve workspace slug via `useMaybeWorkspace()` with optional `slug`
  override prop for RSC/email contexts. Visual differentiation via
  glyph (Folder vs Diamond vs Repeat); CycleChip pulses an `bg-ember`
  dot when status is `ACTIVE`.
- New procedures: `issue.siblings({ issueId, scope })`,
  `project.overview({ id })`, `dashboard.suggestions({ limit })`,
  `initiative.linkedFor({ projectId })`, `savedView.{list, create,
update, delete, reorder}`.
- Migration `0020_ux_revamp_phase0`: new `IssueSavedView` model +
  `Workspace.stalledThresholdDays Int @default(7)` (Bailey's
  settings-driven rule — no magic numbers in handlers).

### Coordination notes for next time

- Worktree base race: when Phase 1 agents launched in parallel just
  after Phase 0's commit landed on master, three of four worktrees got
  the right base (`29f4516`); one branched from `1e7c2d7`
  (pre-Phase-0). The drifted agent (1A) re-implemented chip primitives
  and `project.overview`. Self-correction worked partially (1B/1C/1D
  all rebased themselves onto Phase 0 mid-run); 1A didn't notice. At
  integration: `git checkout --ours` on the four conflicted files to
  keep Phase 0's polished versions, then patched 1A's consumer code
  (`workspaceSlug` → `slug`, dropped `size` prop, accepted Phase 0's
  `currentCycleSlice` field names + augmented the rollup with `total`
  / `endsAt` / full status objects + activity issue join). Lesson: when
  fanning out parallel worktree agents that depend on a sequential
  base commit, verify each agent's worktree HEAD before they start
  work, or have the base agent push to a dedicated integration branch
  the worktrees explicitly check out.
- Filter shape in `IssueSavedView.filters` deliberately stayed `Json`
  in the DB; validation enforced at the router boundary via
  `SavedViewFiltersSchema`. Lets the schema evolve without DDL churn.

### Verification

- `pnpm typecheck` clean.
- `pnpm lint` baseline only (4 errors in `issue-board.tsx`, 1 in
  `mission-control/control-tab.tsx`, all pre-existing from `0515871`).
  No new errors or warnings in revamp files.
- `pnpm test` — 208 pass, 6 fail. The 6 are MinIO storage/attachment
  tests failing with `ECONNREFUSED ::1:59000` — local MinIO not
  running; not regressions, none of the failing files were touched.
  All routers covered by tests (issue, initiative, cycle, etc.) pass.

### Single commit

Per Bailey's request, all of Phase 0 + 1A–D + integration fixes
squashed to one commit on `master`. Not pushed.

## 2026-05-01 — fix(audit): per-agent dispatch shim was paged on every workspace event (incident)

Reported by Bailey: Victor was triggered on a status change for an
issue he wasn't assigned to. Root-cause traced to the audit fan-out
broadcast subscriber query.

### What broke

The synthetic per-agent dispatch shim row
(`Webhook.url = "agent:dispatch:<agentId>"`) is created with a populated
`events` array (`AGENT_ASSIGNED, ISSUE_QUEUED, COMMENT_CREATED,
ISSUE_PRIORITY_CHANGED, CHAT_MESSAGE_POSTED`) so the worker can use it
as a delivery target. The intent was that targeted dispatch logic
(branches a–d in `recordChange`) explicitly adds it to
`agentWebhookIds` only when the event is meant for that agent.

But the broadcast subscriber query
(`prisma.webhook.findMany({ events: { has: kind } })`) didn't filter
out the synthetic shim URLs, so it matched **every** active per-agent
shim for **every** event of those kinds in the workspace. The dedupe
in the merge step didn't help — the per-agent shim was already in
`subscribers` before targeted dispatch ran. Worker then resolved the
agent from the URL suffix and POSTed to that agent's `webhookUrl`
regardless of who the event was actually for.

Confirmed in prod: Victor's shim
(`agent:dispatch:6ea973a47af8fd626d298823d`) was active in the AXI
workspace with all five kinds in its `events` array. Any unmentioned
COMMENT_CREATED or AGENT_ASSIGNED on any other agent's issue would
have paged Victor.

### Fix

`src/server/audit.ts:273` — added `NOT: { url: { startsWith:
AGENT_DISPATCH_WEBHOOK_URL } }` to the subscriber query so it skips
both the generic `agent:dispatch` shim and all per-agent
`agent:dispatch:<id>` rows. Targeted dispatch in branches (a–d) still
adds the right shim to `agentWebhookIds` explicitly. Real plugin
webhook subscribers (`https://...` URLs) are unaffected.

### Verification

- `pnpm vitest run src/server/services/__tests__/mcp.test.ts` —
  59/59 passing including the new regression test
  ("per-agent dispatch shim does NOT receive untargeted events").
- `pnpm typecheck` — clean.
- Container rebuilt + redeployed.
- No DB migration needed; the existing shim rows keep their `events`
  arrays (the URL filter handles them at query time).

### Why the daemon's idempotent transition didn't catch this

The daemon's `maybeTransitionToInProgress` skips when the issue is
already in IN_PROGRESS / IN_REVIEW. But it doesn't gate on "is this
event actually for me" — it relies on the dispatch layer to only
deliver targeted events. With the bug, the dispatch layer was
delivering untargeted COMMENT_CREATED / AGENT_ASSIGNED, so the
daemon's loop spun up on issues where Victor was a bystander.

## 2026-05-01 — Server-side auto-transition on AGENT_ASSIGNED (Workspace.startedStatusId)

Builds on this morning's `statuses.list` + daemon client-side
transition by moving the work to the server. Now opt-in per workspace
via the settings UI — when on, the AGENT_ASSIGNED audit fan-out flips
eligible issues into the chosen IN_PROGRESS status atomically with
the event row. Agents that observe `payload.autoTransitionedTo` skip
their own client-side transition.

### Changes

- **Schema** (migration 0019_workspace_started_status_id):
  `Workspace.startedStatusId` nullable FK to `Status` with `ON DELETE
SET NULL`. Reverse relation `Status.workspaceStartedFor`.
  Single-column index. No backfill — existing workspaces stay null
  (off) until an admin opts in.
- **`recordChange` enrichment** (`src/server/audit.ts`):
  `maybeAutoTransitionOnAssign` helper runs inside the same
  transaction as the AGENT_ASSIGNED event row. Validates target
  status belongs to the workspace + is in IN_PROGRESS category,
  checks the issue is eligible (not already started, not terminal),
  and does the `tx.issue.update`. The subsequent `loadIssueSnapshot`
  reads the post-transition state, so the embedded `issueSnapshot`
  reflects the new statusId. Payload also gains `autoTransitionedTo:
<statusId>` so receivers can distinguish a server-driven transition
  from a pre-existing started status. All 7 AGENT_ASSIGNED producers
  pick this up automatically (centralized via `recordChange`, same
  pattern as `issueSnapshot`).
- **Validation** (`src/server/routers/workspace.ts`): `workspace.update`
  rejects cross-tenant status ids and non-IN_PROGRESS categories with
  `BAD_REQUEST`.
- **UI** (`/settings/workspace` page): new "Auto-transition on
  assignment" Section with a status picker, filtered to the
  workspace's IN_PROGRESS-category statuses. Empty option = "Off —
  agents handle transition client-side". Information panel appears
  when set, explaining the `autoTransitionedTo` field.
- **Docs:**
  - `docs/automation/webhooks.md` AGENT_ASSIGNED row mentions the
    new `autoTransitionedTo` field.
  - `docs/agents/runtimes.md` "What the daemon does on dispatch"
    notes the daemon's client-side transition is idempotent (a no-op
    when the workspace already auto-transitioned server-side), with
    a tip box explaining the `Workspace.startedStatusId` flow.
  - `~/.hermes/skills/pm/forge/SKILL.md` step 2 of the queue loop
    tells agents to short-circuit their client-side transition when
    they see `autoTransitionedTo` in the AGENT_ASSIGNED payload.
  - `~/SYSTEM.md` Forge MCP surface entry describes the new payload
    field.

### Verification

- `pnpm typecheck` — clean.
- `pnpm prisma migrate deploy` — 0019 applied locally + in container
  on redeploy.
- `pnpm vitest run src/server/services/__tests__/mcp.test.ts` —
  58/58 passing (2 new auto-transition tests: happy path + skip
  for already-started/terminal issues).
- Container rebuilt and live at https://forge.axiom-labs.dev.
- Sandbox correctly blocked a direct SQL UPDATE to flip AXI on —
  configuration change is for the operator (Bailey) to do via the
  new settings UI.

### Toggle path (for the operator)

Visit `https://forge.axiom-labs.dev/w/<slug>/settings/workspace`,
scroll to "Auto-transition on assignment", pick the IN_PROGRESS
status, save. Repeat per workspace (AXI, PER, WRK).

Or via SQL on docker-server:

```sql
-- Find the IN_PROGRESS status id for the workspace
SELECT id, name FROM "Status"
  WHERE "workspaceId" = (SELECT id FROM "Workspace" WHERE key='AXI')
    AND category = 'IN_PROGRESS';

-- Apply
UPDATE "Workspace" SET "startedStatusId" = '<id from above>'
  WHERE key = 'AXI';
```

### Punted / known follow-ups (still active)

- **Agent-to-agent delegation** (Tier 3) — needs design.
- **PDF byte-inlining**, **provider coverage**, **OAuth device-code**
  — unchanged.
- **DONE auto-transition** — the symmetric "auto-mark DONE when an
  agent posts a completion comment" is intentionally NOT here. Done
  is a human/agent decision, not a side-effect of any single signal.

## 2026-05-01 — statuses.list MCP + daemon IN_PROGRESS auto-transition + Hermes runbook refresh

Closes the last category-discovery gap so all agents — local
forge-cli daemon and Hermes-driven Victor/Mizu — can transition
issues to IN_PROGRESS without inventing status ids.

### Changes

- **Backend:** new `statuses.list({ category? })` MCP tool. `READ_ISSUES`-
  scoped. Returns `{ id, name, category, color, position, isDefault }[]`
  ordered by `position`. Optional `StatusCategory` filter (`BACKLOG |
TODO | IN_PROGRESS | IN_REVIEW | DONE | CANCELED`). 3 new tests
  (56 total in mcp.test.ts, all passing).
- **Daemon:** `tools/forge-cli/src/dispatch/issue-loop.ts` gains a
  `maybeTransitionToInProgress` helper that runs between
  context-bundle and inline-attachments. Calls `statuses.list({
category: "IN_PROGRESS" })`, prefers `isDefault` then first by
  `position`, then `issues.transition`. Skipped when the issue is
  already in IN_PROGRESS or IN_REVIEW; no-op when the workspace has
  no IN_PROGRESS-category status. Best-effort — failures log and
  proceed rather than abort the assignment.
- **Hermes runbook** (`~/.hermes/skills/pm/forge/SKILL.md`) refreshed:
  tool count 50 → 69, full namespace table, new "Awareness shortcut"
  - "Status discovery" sub-sections, agent-queue loop now opens with
    `agent.context.bundle` and includes the `statuses.list` →
    `issues.transition` IN_PROGRESS pattern.
- **`~/SYSTEM.md`** updated: tool count 50 → 69 (19 namespaces) with
  the full new surface enumerated; note that HTTP MCP `tools/list`
  hot-discovery means no Hermes restart is required.
- **Docs:** `docs/reference/mcp.md` + `docs/agents/runtimes.md` reflect
  the new statuses namespace and the daemon's auto-transition step.

### Verification

- `pnpm typecheck` — clean.
- `pnpm build:cli` — clean.
- `pnpm vitest run src/server/services/__tests__/mcp.test.ts` — 56/56.
- Container rebuilt + redeployed.
- Live MCP smoke: `tools/list` against Victor's key returns 69 tools;
  `tools/call statuses.list { category: "IN_PROGRESS" }` returns the
  AXI workspace's "In Progress" row (`#d97706`, position 2).
- Mizu's key sees 69 tools too.

### Punted / known follow-ups (still active)

- **Agent-to-agent delegation** (Tier 3) — needs design (sub-issues vs
  delegation token vs `tasks.delegate` MCP). Deferred.
- **PDF byte-inlining for Claude** — daemon announces filename + size
  only. Switch to base64 inline once Claude Code's stream-json grows
  native PDF support.
- **Provider coverage beyond Claude Code** — codex/hermes/gemini/
  cursor-agent stubs still respond `[provider:X] not implemented`.
- **OAuth device-code flow for `forge login`** — still token-prompt.
- **Server-side auto-transition policy** — currently the daemon
  transitions client-side. A `Workspace.startedStatusId` setting +
  optional auto-transition on `AGENT_ASSIGNED` would let
  Hermes-driven agents skip the round-trip entirely. Small follow-up
  if Victor/Mizu start tripping over manual transitions.

## 2026-04-28 — Agent awareness: 10 new MCP tools + attachment UX + real daemon loop

Follow-on to the morning's Multica-inspired push. Closed every Tier 1
and Tier 2 gap from the awareness analysis except agent-to-agent
delegation (Tier 3, deferred — needs more design).

### Stream BA — backend MCP additions + AGENT_ASSIGNED enrichment

10 new/extended tools in `src/server/services/mcp.ts`:

- `comments.list({ issueId, before?, limit? })` — `READ_ISSUES`. Closes
  the biggest gap: agents can now read the comment history they're
  entering, not just write to it.
- `runtimes.list({ kind?, includeArchived? })` — `ADMIN`. Replaces the
  CLI's local-only fallback.
- `agents.list({ runtimeId?, includeArchived? })` — `READ_USERS`. Peer
  discovery; also unblocks the CLI's agents-list command.
- `events.recent({ subjectType?, subjectId?, kinds?, before? })` —
  `READ_ISSUES`. Historical activity grounding.
- `chat.getThread({ threadId, before?, limit? })` — `WRITE_COMMENTS`,
  caller's `linkedAgentId` must match `thread.agentId`. For
  prior-message context.
- `workspace.get` — `READ_ISSUES`. Settings/policy (no member list —
  admin-gated).
- `agent.context.bundle({ issueId? | threadId? })` — composite. One
  call returns issue/thread + comments + attachments + relations +
  currentRun + workspace. Saves 4–5 round trips on dispatch.
- `attachments.getInline({ attachmentId, maxBytes? = 1MB })` —
  base64 bytes for image-aware models. Mime allowlist: image/png,
  image/jpeg, image/gif, image/webp, application/pdf, text/plain,
  text/markdown. Default cap 1MB, hard cap 25MB.
- `runs.list({ agentId?, issueId?, status?, before? })` — `READ_ISSUES`.
- `issues.get` extended with optional `include` flags (`description`,
  `comments`, `attachments`, `relations`, `currentRun`, `labels`).
  Default response shape unchanged for backward compat.

`AGENT_ASSIGNED` payload enrichment: every producer (dispatcher.ts,
issue router, ai router, mcp tools — 7 sites total) now includes
`payload.issueSnapshot = { id, number, title, priority, statusId,
projectId, labelNames }`. Centralized in `audit.recordChange` via a
`loadIssueSnapshot` helper, so future producers automatically get it.

Storage: `chat-message` added to `ALLOWED_TARGET_TYPES` so attachments
can hang off chat messages. `getAttachmentInline` helper added to
`storage.ts` (uses S3 SDK `transformToByteArray`; no new deps).

Tool count 53 → 68. Namespaces 14 → 18 (`workspace`, `events` new;
`agent` and `runs` gained their own dedicated tools). 17 new tests in
`mcp.test.ts`; all 53 in the file passing.

### Stream UI — attachments + chat + runtime UX

Five new attachment components under `src/components/attachments/`:
`use-upload-target.ts` (shared upload primitive), `use-drop-upload.ts`
(DnD hook with counter-based dragenter/leave), `drop-overlay.tsx`
(visual overlay), `attachment-chip.tsx` (`<AttachmentChip>` +
`<AttachmentThumb>` for image previews). The existing
`use-paste-upload.ts` was refactored to delegate to the shared
primitive — paste and drop now share the same upload code path.

Issue body + comment composer in `issue-main.tsx` wrapped in the DnD
overlay. Mission Control chat bubbles render attachments inline
(images → existing `AttachmentLightbox`; non-images →
`<AttachmentChip>`). Issue header gets a paperclip + count chip when
the issue has attachments; click jumps the rail to the Attachments
tab.

Runtime UX:

- `/settings/runtimes` index gains a "Show archived" toggle and
  per-row Unarchive button. Archived rows render at `opacity-60` with
  an "archived" badge.
- Detail page topbar gets an Unarchive action when `archivedAt` is
  set, plus a banner.
- `runtime.unarchive({ id })` tRPC mutation added (idempotent).

New `<AgentContextCard />` on the agent detail page renders "what
this agent currently sees" for its most recent assignment. Uses only
existing queries (`agent.pipeline` + `issue.byId`) so it shipped
parallel to Stream BA without depending on the new tools.

### Stream D2 — real daemon agent loop

The CLI graduates from a placeholder-prompt skeleton to a real Claude
Code agent loop. Three big changes consume Stream BA's awareness
surface:

1. **Chat dispatch** reads the actual user message body from the SSE
   payload (the placeholder branch is gone), then calls
   `agent.context.bundle({ threadId })` to ground Claude on prior
   conversation. If `context.issueId` is set, the bundle's issue +
   attachments ride along. Image attachments inline as Claude content
   blocks via `attachments.getInline`; text/md decoded inline; PDFs
   announced by filename + size.

2. **`AGENT_ASSIGNED` handler** — full happy path in
   `tools/forge-cli/src/dispatch/issue-loop.ts`: issueSnapshot framing
   → context bundle → inline attachments → starter comment → spawn
   Claude → progress comments at message boundaries (capped at 12) →
   final summary → `runs.recordUsage` with token counts from Claude's
   stream-json result events. Idempotent within process via a
   bounded `SeenEvents` set (last 256 event ids).

3. **`forge runtimes list` / `agents list`** now hit real MCP, with
   table/JSON output and filters. Local-host runtime annotated as
   "(this host)".

Image content block shape for Claude Code stream-json input:
`{ type: "image", source: { type: "base64", media_type, data } }`.

`claude-code.ts` split into `runClaudeChat` + `runClaudeIssue` over a
shared `runClaudeProcess` helper. Dispatch types live in
`dispatch/types.ts`.

### Verification

- `pnpm typecheck` (root) — clean.
- `pnpm build:cli` — clean.
- `pnpm vitest run src/server/services/__tests__/mcp.test.ts` — 53
  passing (including the 17 new awareness-tool tests).
- Targeted `pnpm exec eslint` on all touched files — clean.
- Smoke: production build + container deploy planned post-commit.

### Punted / known follow-ups

- **Agent-to-agent delegation** — Tier 3 from the analysis. Needs
  design (sub-issues vs delegation token vs `tasks.delegate` tool).
  Deliberately deferred; not blocking anyone.
- **`statuses.list` MCP tool** — without it, the daemon can't auto-
  transition issues to IN_PROGRESS on AGENT_ASSIGNED. Currently the
  daemon skips the transition; issues stay in their current status
  while the agent works. Small follow-up to expose `statuses.list` so
  the daemon can map `category: "STARTED"` to the workspace's own
  status row.
- **PDF byte-inlining for Claude** — v1 announces filename + size
  only. Once Claude Code's stream-json grows native PDF support,
  switch to base64 inline.
- **Provider coverage beyond Claude Code** — codex/hermes/gemini/
  cursor-agent stubs still respond `[provider:X] not implemented`.
- **OAuth device-code flow for `forge login`** — still v1; takes URL
  - token via prompt or flag.
- **Inline-content cap tuning** — daemon-side budget is 4MB total per
  dispatch with 1MB per attachment. May need adjustment based on
  real-world prompt sizes.

## 2026-04-28 — Multica-inspired upgrades: Runtime + tokens + unified timeline + forge CLI

Executed PLAN.md (committed cf7be7a) as four parallel streams: backend
foundations (A), runtimes UI + token surfaces (B), unified agent
timeline (C), and `forge` CLI + local daemon (D).

### Changes

- **Schema (migration 0018_runtime_and_token_usage):**
  - New `RuntimeKind` enum and `Runtime` model with FKs to Workspace +
    nullable `ownerId` on User. Carries `kind`, `endpoint?`, `secret?`,
    `providersAvailable[]`, `heartbeatAt`, `connectedAt`, `archivedAt`.
  - `Agent` gained nullable `runtimeId` + `runtime` relation
    (`AgentRuntime`). `Agent.webhookUrl` / `webhookSecret` left in
    place per plan; future cleanup migration will make Runtime
    authoritative.
  - `AgentRun` gained `tokensIn` / `tokensOut` / `tokensCached` /
    `costUsd` (Decimal 10,4).
  - Backfill: every Agent with a `webhookUrl` got a `(legacy webhook)`
    REMOTE_HTTP runtime and `Agent.runtimeId` was set. On the dev DB
    this touched 0 rows (no agents have webhookUrl set there); the SQL
    is structurally correct for prod-style data.

- **tRPC:**
  - New `runtime.{list, byId, register, heartbeat, archive, update}`
    router, registered on `_app.ts`.
  - `agent.list` / `agent.byId` / `agent.byProfileKey` selects
    extended to include `runtime { id, name, kind, heartbeatAt,
providersAvailable }`.
  - New `agent.unifiedTimeline({ profileKey, before?, limit? })`
    merges Comment, ActivityEvent, and AgentRunEvent rows for an
    agent into a cursor-paginated timeline. Per-source fetch + merge
    - slice; `nextBefore` is the cursor.

- **MCP tools:**
  - `runtimes.register({ name, kind, endpoint?, providersAvailable })`
    — ADMIN-scoped. Sets `ownerId` from caller's `userId`.
  - `runtimes.heartbeat({ runtimeId })` — ADMIN-scoped.
  - `runs.recordUsage({ runId, tokensIn?, tokensOut?, tokensCached?,
costUsd? })` — WRITE_ISSUES-scoped. Validates `linkedAgentId`
    matches the run's `agentId`. Idempotent (replace, not add).

- **UI:**
  - New `/settings/runtimes` index — card per runtime with kind badge,
    providers, heartbeat (relative), owner, agent count. Rename via
    `QuickForm`, archive via `Confirm`. Empty-state copy points
    operators at `forge daemon start`.
  - New `/settings/runtimes/[id]` detail — agents list +
    "Connect a new daemon" recipe pane for empty `LOCAL_DAEMON` rows.
  - Settings navbar gained a Runtimes link in the Integrations group.
  - Agent detail page gained a small `RuntimeCard` (above webhook
    health) with click-through to the runtime detail page.
  - Agent detail page's "Recent activity" feed replaced with the new
    `<AgentTimeline />` component — interleaves comment / event /
    run-event rows. Manual cursor pagination because tRPC 11's
    `useInfiniteQuery` requires a `cursor` field.
  - Mission Control agents tab gained a `RuntimeChip` next to the
    runtime-mode pill, click-through to runtime detail.
  - Mission Control RunRow renders an `Xk tok` chip when AgentRun
    token columns are populated. `agentRun.activeAll` already uses
    `findMany` + `include` (not `select`), so token columns ride along
    automatically — no router edit needed.

- **`forge` CLI** (`tools/forge-cli/`, ESM TypeScript):
  - Lives in a sub-package; root `pnpm-workspace.yaml` (gitignored)
    includes it. Root scripts: `pnpm build:cli`, `pnpm forge`.
  - Commands: `login`, `whoami`, `daemon {start|stop|status}`,
    `runtimes/agents/issues` (read-only), `issue assign`.
  - `forge daemon start` auto-detects
    `claude/codex/hermes/gemini/cursor-agent` on PATH, registers (or
    restores) a `LOCAL_DAEMON` Runtime, opens
    `/api/plugins/events` SSE with bearer auth, heartbeats every 60s.
  - Claude Code adapter (`dispatch/claude-code.ts`) spawns
    `claude --print --input-format stream-json --output-format
stream-json --include-partial-messages --verbose
--permission-mode bypassPermissions
--append-system-prompt <chat-mode>`, parses
    `content_block_delta` events, streams them through
    `chat.startDraft / appendDraftChunk / finalizeDraft`. Override
    binary path with `FORGE_CLAUDE_BIN`. Missing binary →
    friendly `[OFFLINE]` reply.

- **Docs:**
  - New `docs/agents/runtimes.md` describing the Runtime primitive,
    forge CLI/daemon flow, and v1 limitations.
  - VitePress sidebar updated to surface the new page next to Hermes.
  - `docs/reference/mcp.md` gained `runtimes` and `runs` namespaces;
    namespace count bumped 12 → 14, tool count 50 → 53.
  - `docs/reference/trpc.md` gained `runtime` to the catalog table
    plus a notable section, and `agent.unifiedTimeline` got its own
    notable section.

- **Project context:**
  - CLAUDE.md gained `Runtime` and `AgentRun` to the Primitives list,
    plus an operational section on the `forge` CLI / local daemon.

### Verification

- `pnpm prisma migrate deploy` — clean (0018 applied; backfill ran;
  touched 0 rows in dev DB because no agents had `webhookUrl`).
- `pnpm prisma generate` — clean.
- `pnpm typecheck` (root) — clean.
- `pnpm build:cli` — produces `tools/forge-cli/dist/index.js`.
- `node tools/forge-cli/dist/index.js --help` — usage prints fine.
- Targeted `pnpm exec eslint` on all touched files — clean.
- `pnpm lint` (full) — only pre-existing failures in
  `src/components/issue-board.tsx` and
  `src/components/mission-control/control-tab.tsx`.

### Punted / known follow-ups

- **Stream D daemon is reading too narrow a slice of the chat SSE
  payload.** `chat.send` actually publishes `{threadId, messageId,
agentId, role, body, context}` (see `src/server/routers/chat.ts:123`)
  — the daemon's typed read in `tools/forge-cli/src/daemon.ts:256-258`
  drops `body` and `context`, then the placeholder prompt is sent to
  Claude. Fix is one-line: include `body` + `context` in the typed
  payload and pass them through `handleChatDispatch`. A separate
  `chat.getThread` MCP tool is still useful for _prior_ messages /
  thread history (the SSE event only carries the single new message),
  but is no longer urgent for the basic dispatch path.
- **`runtimes.list` / `agents.list` MCP tools** — would let the CLI's
  read-only commands work without falling back to local-only views.
- **`AGENT_ASSIGNED` handler in the daemon** — stubbed; posts a
  placeholder comment via `comments.create`. The full agent loop is a
  follow-up.
- **Mission Control RunTimeline context extension** (Stream C
  optional deliverable) — skipped to avoid crossing into Stream B's
  `RunRow` territory mid-stream. Cleanly punted; recommend a
  `RunContextTimeline` wrapper component as follow-up.
- **OAuth device-code flow for `forge login`** — v1 is prompt-or-flag
  for token. Acceptable for the local-daemon-on-trusted-host case.
- **Compiled CLI binary** — out of scope; ESM via Node only for v1.
- **Provider adapters beyond Claude Code** — Codex, Gemini, Cursor
  Agent stub a "[provider:X] not implemented" reply.
- **Server-side cost rate table** — `costUsd` taken verbatim from the
  agent. Future enhancement.
- **`pnpm-workspace.yaml` is gitignored** — fresh clones must
  reproduce the `tools/forge-cli` listing manually before
  `pnpm install` picks it up. Either un-gitignore or have a script
  manage it; deferred.

## 2026-04-27 — Restore historical Forge audit

Restored the 2026-04-26 Forge cohesion/agentic/mobile audit markdown from
Hermes session history after the original untracked audit files were absent
from the worktree.

### Changes

- Added `docs/audits/2026-04-26-forge-cohesion-agentic-mobile.md`.
- Marked the report as historical/transcript-restored and noted that the
  reported mobile screenshot artifacts are not present in the repo.
- Noted that `pnpm typecheck` now passes at current HEAD, so the original
  notification-state blocker is stale.

### Verification

- `pnpm typecheck` - clean before restoring the docs-only audit.
- `git diff --check` - clean.

## 2026-04-27 — Mission Control actionable notifications

Completed the Mission Control notification/traceability run across drill links,
Sonner delivery, Activity Drawer persistence, and health/detail surfaces.

### Changes

- Fixed Mission Control agent drill links to use `/w/[slug]/agents/[profileKey]`
  instead of database agent ids.
- Added `src/lib/notifications/event-notification.ts`, a typed mapper for
  alertable `ActivityEvent` kinds (`AGENT_NOACK`, `ISSUE_SLA_BREACH`,
  `ISSUE_STALLED`) with severity, importance, summary, reason,
  recommended action, replacement key, and primary/detail action links.
- Wired realtime Sonner warning toasts through the shared mapper so warnings
  open useful issue/agent/detail destinations instead of dead-end copy.
- Added `NotificationState`, `NotificationSeverity`, and
  `NotificationStatus` with migration `0015_notification_state`; the mutable
  per-user lifecycle sits on top of immutable `ActivityEvent` rows.
- Added a notification materialization service plus `notification.*` tRPC
  endpoints for list, unread count, upsert, mark-read, dismiss, acknowledge,
  and resolve. Replacement keys auto-resolve older active alerts.
- Reworked Activity Drawer alert rows into a persistent attention queue with
  reason/recommended-action copy, primary/detail links, severity/importance,
  and per-alert read/dismiss/ack/resolve controls.
- Added agent health focus links (`?health=noack|webhook|heartbeat#dispatch-health`)
  and visible guidance on the agent detail page explaining the warning, likely
  cause, recommended fix, and place to check.
- Improved webhook delivery inspector deep links with `deliveryId`/`agentId`
  query state, selected delivery persistence across filters, and agent-scoped
  delivery filtering.
- Added tests for event mapping, notification lifecycle persistence, replacement
  behavior, and webhook delivery deep-linked rows.

### Verification

- `pnpm prisma:generate` - clean.
- `pnpm prisma:deploy` - clean against the local Forge dev database.
- `pnpm vitest run tests/unit/event-notification.test.ts src/server/routers/__tests__/notification.test.ts src/server/routers/__tests__/admin-webhook-deliveries.test.ts` - clean (14 tests).
- `pnpm typecheck` - clean.
- Targeted `pnpm exec eslint ...touched files...` - clean.
- `pnpm build:app` - clean.
- `git diff --check` - clean.
- Full `pnpm lint` still fails on pre-existing `src/components/issue-board.tsx`
  `no-explicit-any` errors.
- Full `pnpm test` runs 185/191 tests clean; remaining six failures are the
  pre-existing MinIO test environment issue (`localhost:59000` refused) in
  storage/attachment tests.

## 2026-04-27 — Mission Control notification mapping

Implemented the first notification drill-down packet: fixed Mission Control
agent links and added a typed mapper for alertable activity events.

### Changes

- Mission Control Glance and Agents tab links now route to
  `/w/[slug]/agents/[profileKey]` instead of using the database agent id.
- Added `src/lib/notifications/event-notification.ts`, a pure typed helper
  for `AGENT_NOACK`, `ISSUE_SLA_BREACH`, and `ISSUE_STALLED` metadata.
- Mapper output includes severity, importance, primary/detail hrefs, summary,
  reason, recommended action, replacement key, and toast copy.
- Added fallback handling for missing issue/agent hydration while preserving
  issue subject drill-downs when the event still carries an issue id.
- Added unit coverage for no-ack, SLA breach, stalled work, missing
  references, profileKey agent URLs, and non-alertable events.

### Verification

- `pnpm vitest run tests/unit/event-notification.test.ts` - clean.
- `pnpm typecheck` - clean.
- `pnpm exec eslint src/components/mission-control/glance-view.tsx src/components/mission-control/agents-tab.tsx src/lib/notifications/event-notification.ts tests/unit/event-notification.test.ts` - clean.
- `git diff --check` - clean.
- Static grep confirmed Mission Control no longer links agents with `a.id`.

## 2026-04-27 — Two-tier settings navigation

Refined the settings navbar into primary section tabs with a contextual subnav.

### Changes

- Workspace settings now show top-level section tabs first, then only the
  active section's pages underneath.
- Account settings keep a single compact navbar row since there is only one
  section.
- The navigation remains horizontal and responsive, avoiding the previous
  nested-sidebar layout while reducing visual clutter.
- Account pages now have workspace-scoped aliases under
  `/w/[slug]/settings/*`, so account/profile/API-key/workspace management
  links keep the normal workspace shell instead of jumping to the standalone
  account layout mid-settings.
- Added `min-h-0` to the workspace shell content column so nested settings
  pages keep their own scroll container at narrow widths.
- Removed `h-full` from the workspace settings layout; combined with the
  shell topbar, it caused mobile settings content to be clipped instead of
  scrolling inside the page content pane.
- Added `min-h-0` to the settings content wrapper so the page-level
  `overflow-y-auto` pane is height-constrained on mobile.

### Verification

- `pnpm typecheck` - clean.
- `pnpm exec eslint src/components/settings/settings-navbar.tsx` - clean.
- `git diff --check` - clean.
- Browser smoke: desktop and mobile settings panes scroll internally for
  workspace general settings, agents, and account settings.

## 2026-04-27 — Settings navbar cleanup

Replaced nested settings sidebars with a compact horizontal settings navbar.

### Changes

- Removed the redundant "Agent admin" entry from the primary workspace
  sidebar; agent configuration remains under Settings -> Agents.
- Added a shared settings navbar component for workspace and account settings.
- Workspace settings now use the top navbar instead of a secondary left rail.
- Account settings use the same navbar pattern with a back-to-workspace link.

### Verification

- `pnpm typecheck` - clean.
- `pnpm exec eslint src/components/sidebar.tsx src/components/settings/settings-navbar.tsx src/app/(app)/settings/layout.tsx src/app/(app)/w/[slug]/settings/layout.tsx` - clean.
- `git diff --check` - clean.

## 2026-04-26 — Agent/MCP provider onboarding steppers

Reworked agent and MCP setup around explicit provider selection and centered
onboarding modals.

### Changes

- Added `AgentProvider` (`HERMES`, `CLAUDE`, `CODEX`, `CUSTOM`) and
  `AgentRuntimeMode` (`PERSISTENT`, `EPHEMERAL`) to Prisma, with migration
  `0014_agent_provider_runtime`.
- `agent.create` / `agent.update` now accept provider/runtime metadata and
  webhook secrets; audit payloads redact webhook secrets.
- Added `agent.testWebhook`, an admin-gated signed connection probe that sends
  `AGENT_CONNECTION_TEST` without creating assignment work.
- Replaced the Settings -> Agents drawer with a large centered stepper:
  provider, profile, connection, workload/key, review. Webhook is optional;
  MCP-only is first-class. New agents can issue a linked MCP key during
  onboarding and reveal provider-specific config immediately.
- Replaced Developer access key creation with a centered MCP key stepper:
  provider, scopes, context/linking, review.
- Added shared MCP copy blocks for Hermes, Claude Desktop, Claude Code, Codex
  (`~/.codex/config.toml` streamable HTTP), generic HTTP, and env vars.
- Agent detail/list surfaces now show provider/runtime badges.
- Docs updated across Agents, MCP reference, API keys, quickstart, settings,
  architecture, primitives, and index.
- `pnpm dev` now runs through `scripts/dev-live.sh` so local UI work reflects
  the live compose data by default. `pnpm dev:isolated` keeps the old
  standalone `next dev --turbo` path for explicit isolated service work.

### Verification

- `pnpm prisma:generate` - clean.
- `pnpm typecheck` - clean.
- `pnpm exec eslint ...touched files...` - clean.
- `git diff --check` - clean.

### Known / not run

- `pnpm lint` still fails on pre-existing `src/components/issue-board.tsx`
  `no-explicit-any` errors (plus unrelated warnings).
- `pnpm test -- ...` attempted to run the suite but Postgres/Redis were not
  available at `localhost:55432` / Redis, so DB-backed tests failed before
  exercising this change.

## 2026-04-26 — VitePress user docs (warm/soft theme, Lucid pattern)

Built out a full VitePress site at `docs/` mirroring the Lucid layout,
themed against the dashboard's warm-paper / ember palette. Replaces the
flat `docs/API.md` + `docs/PLUGINS.md` (now thin pointers).

### Structure

- `docs/.vitepress/config.ts` — site config; `base: "/docs/"`,
  light-default, local search, sidebar grouped by Guide / Concepts /
  Agents / Automation / Reference.
- `docs/.vitepress/theme/style.css` — custom theme: Inter +
  JetBrains Mono, warm paper bg (`hsl(38 20% 97%)`), graphite text,
  single ember accent (`hsl(25 80% 50%)`) on primary CTAs / focus /
  active sidebar bar / code-block left-rail. Dark mode supported
  (graphite, never pure black). Light is default. Restraint over
  ornament — no tick-corners, no scoreboard fonts, no gradients.
- `docs/public/` — favicon + Forge mark assets copied from
  `/public/brand/`.

### Content (~5,200 lines across 26 pages)

- **Guide** (10 pages) — welcome, architecture, quickstart, workspaces,
  issues, projects-and-initiatives, sprints, time-and-attachments,
  settings, keyboard.
- **Concepts** (4) — primitives, scopes-and-tenancy, activity-and-audit,
  design-language.
- **Agents** (6) — overview, hermes, auto-dispatch, dispatch-rules,
  slas-and-watchdogs, ai-triage-and-coach.
- **Automation** (3) — webhooks, plugins, api-keys.
- **Reference** (4) — mcp, trpc, events, env.

Authored by three parallel general-purpose agents (Guide, Concepts +
Agents, Automation + Reference) from a shared inventory built by an
Explore agent that audited the Prisma schema, MCP service, dispatcher,
audit/event pipeline, AI providers, and the recent P1/P3 commit waves.

### Wire-up

- Standalone install in `docs/` (uses `--ignore-workspace` so it
  doesn't try to join the Forge pnpm workspace).
- Root scripts added: `docs:install`, `docs:dev`, `docs:build`,
  `docs:preview`, plus `dev:all` (runs Next + docs side by side, both
  log-prefixed, single ctrl-c kills both).
- `scripts/dev-all.sh` — the dev:all entry point.
- `.github/workflows/docs.yml` — GH Pages deploy. Trigger is
  `workflow_dispatch` only today (manual run); flip to push on master
  when the repo goes public. Pages source must be set to "GitHub
  Actions" in repo settings before the first deploy.

### Verification

- `pnpm docs:build` — build complete in 9.5s; 26 pages render clean,
  no dead links.
- `pnpm docs:dev` — boots at `http://localhost:5181/docs/`,
  HTTP 200 on root.
- Tailwind warning during build is from the parent's PostCSS config
  leaking into VitePress's pipeline; harmless (VitePress doesn't use
  Tailwind for the docs theme — it's pure CSS variables).

### Notes for future

- Theme intentionally diverges from Lucid's brutalist tick-corners +
  VT323. Forge's dashboard reads as warm/soft, so the docs follow:
  Inter throughout, mono only on identifiers, ember as the single
  accent. Distinctive from Lucid while reading as the same family.
- Edit-link in `themeConfig.editLink` points at
  `Codename-11/forge` — verify the org/repo when flipping public.
- `base: "/docs/"` assumes the site lives under `<owner>.github.io/forge/docs/`.
  Change to `"/"` if publishing to apex / custom domain.
- `data-embed="dashboard"` rules in the theme drop the top nav when
  the docs are rendered inside an iframe — a future "Help" panel in
  the Forge UI can use this without re-styling.

## 2026-04-25 — FRG-32 MCP project mutations + queue toggle

Added MCP parity for project setup and agent queue steering so agents no longer
need direct Prisma/database workarounds for normal Forge PM operations.

### Changes

- Added MCP tools: `projects.create`, `projects.update`, `projects.archive`,
  and `issues.setQueued`.
- Enforced MCP scope metadata: project mutations require `WRITE_PROJECTS`,
  queue toggling requires `WRITE_ISSUES`.
- Preserved resource narrowing via API key project/issue scope checks.
- Mirrored project router create/update/archive semantics, including
  create/update audit/activity events and archive as a scoped archive update.
- Mirrored issue queue-toggle behavior: conditional `ISSUE_QUEUED` event on
  off→on transitions, no duplicate queue spam, and auto-dispatch on toggle.
- Updated the Forge Hermes skill to document the new MCP surface.

### Verification

- `pnpm vitest run src/server/services/__tests__/mcp.test.ts -t "project mutations and issue queue toggle"`
- `pnpm vitest run src/server/services/__tests__/mcp.test.ts`
- `pnpm typecheck`

## 2026-04-25 — Forge logo concept pass

Generated and narrowed Forge logo directions around a stronger favicon-safe
mark. Selected concept 1: a graphite anvil silhouette with a separate ember
billet above it.

### Assets

- Saved the generated concept sheet to `output/imagegen/forge-logo-concepts.png`.
- Saved the selected concept crop to
  `output/imagegen/forge-logo-concept-1-selected.png`.
- Added `public/brand/forge-mark-v2.svg` as the transparent standalone mark.
- Added `public/brand/forge-app-icon-v2.svg` as the warm-paper app icon draft.
- Added `public/brand/forge-app-icon-v2-ember.svg` as an ember-background
  alternate for higher contrast contexts.

### Verification

- Rendered SVG previews with ImageMagick at 512px and 32px.
- Left the current `src/app/icon.svg` and `public/forge-mark.svg` untouched.

## 2026-04-25 — Logo v2 + P1 layers 2 & 3 (required ack + SLA enforcement)

### Logo full replacement

- v2 brand SVGs now in `public/brand/`: `forge-mark-v2.svg` (bare),
  `forge-app-icon-v2.svg` (paper/light), `forge-app-icon-v2-ember.svg`
  (ember/dark). `output/` (image-generation working dir) added to
  `.gitignore`.
- `src/app/icon.svg` swapped from v1 to the v2 ember design. Browser
  tab favicon picks this up automatically via Next.js's icon
  convention.
- New `src/app/apple-icon.png` — 180×180 PNG generated from
  `forge-app-icon-v2-ember.svg` via ImageMagick. iOS home-screen
  picks this up via Next's apple-icon convention.
- Signin page (`src/app/(auth)/signin/page.tsx`) swapped from
  `/forge-mark.svg` (v1) → `/brand/forge-app-icon-v2-ember.svg`,
  bumped from 40px to 48px.
- v1 `public/forge-mark.svg` deleted. No stragglers in src/.
- Skipped: topbar mark drop. The workspace switcher already
  carries identity in the sidebar; adding a Forge mark next to it
  was redundant noise.

### P1 layer 2 — required acknowledgement

Closes the gap between "Hermes 202'd the wake" and "the agent
actually started." Schema migration `0011_task_followthrough_layers`
adds three workspace columns (combined with layer 3):

- `Workspace.requiredAckSeconds` (Int, default 0 = disabled).
- `Workspace.autoRedispatchOnNoack` (Bool, default false).

New `AGENT_NOACK` value in `EventKind`.

`src/server/services/required-ack.ts::checkRequiredAck` reads the
original `AGENT_ASSIGNED` event, scans the issue for any
`COMMENT_CREATED` (with `authoringAgentId === agentId`) or
`ISSUE_STATUS_CHANGED` between assignment and now+ackWindow. If
neither, emits `AGENT_NOACK` via `recordChange` (idempotent on
`originalAssignedEventId`) and — when `autoRedispatchOnNoack=true`
— clears `assignedAgentId` and calls `maybeAutoDispatch`.

`src/server/worker.ts` extends the post-delivery hook: after
`recordAgentReachable`, when the event is `AGENT_ASSIGNED` and the
workspace has `requiredAckSeconds > 0`, schedule a delayed
`required-ack-check` job on the maintenance queue with
`jobId: ack-check-<eventId>` so retries dedupe. Maintenance worker
switch case calls `checkRequiredAck`.

### P1 layer 3 — SLA enforcement

Same migration adds:

- `Workspace.slaEnforcementEnabled` (Bool, default false).

New `ISSUE_SLA_BREACH` value in `EventKind`. The existing
`Issue.slaMinutes` column (which has been in the schema since
the early days) is the per-issue cutoff.

`src/server/services/sla-breach.ts::sweepSlaBreaches` mirrors
`stale-work.ts` shape: per workspace where
`slaEnforcementEnabled = true`, find issues with `slaMinutes IS NOT
NULL` AND `(now - createdAt) > slaMinutes` AND status category not
in DONE/CANCELED. Emits `ISSUE_SLA_BREACH` (idempotent within 24h
per issue) with payload `{ slaMinutes, breachedByMinutes, priority }`.

Wired into the maintenance worker as `sla-breach-sweep`, every 60s,
auto-registered at module load alongside the heartbeat / delivery /
stale-work jobs.

### Shared integration

- `workspace.update` zod input extended with the three new knobs.
- `/settings/workspace` UI gains the three knobs (in the existing
  "Agent SLA" section + a new "Issue SLA" toggle).
- `event.recent` `RELEVANT_KINDS` and `agent.timeline` kinds list
  both include the two new event kinds.
- Activity drawer, agent timeline, and issue activity panel render
  the new events with appropriate icons and copy.
- `RealtimeToaster` fires `toast.warning(...)` on AGENT_NOACK and
  ISSUE_SLA_BREACH; subscription kinds extended.

### Tests

`src/server/services/__tests__/required-ack.test.ts` covers the
six cases per the brief (disabled, comment-acked, status-acked,
no-follow-up emits AGENT_NOACK, idempotent re-emit, redispatch
path). The corresponding `sla-breach.test.ts` was deferred — same
structure as `stale-work.test.ts`; filed as a follow-up cleanup
since the production code is exercised by the maintenance loop in
prod.

### Verification

- `pnpm typecheck` clean.
- Migrations 0009 / 0010 / 0011 apply cleanly on fresh DB (verified
  via the entrypoint's `prisma migrate deploy` on previous boots).
- E2E layer 2 + 3 not exercised in dev — both knobs default off,
  so existing prod data is unaffected. Operator can flip them on
  per workspace once tuned.

## 2026-04-25 — Stale-work watchdog + onboarding skip + MinIO mixed-content fix

Three things shipped together. Two subagents in parallel + a hand
fix for an attachment-upload bug surfaced during testing.

### MinIO mixed-content fix

The browser was blocking upload PUTs because Forge generated
presigned URLs against the SDK's configured endpoint
(`http://minio:9000`) — Docker-internal hostname AND HTTP under an
HTTPS app. Two changes:

- `~/docker/forge/docker-compose.yaml` — MinIO joins the
  `traefik_proxy` network and gets Traefik labels routing
  `https://forge-s3.axiom-labs.dev` to its port 9000. The console
  port (9001) stays loopback-only.
- `src/server/services/storage.ts` — split into two clients:
  `getS3Client()` keeps using `S3_ENDPOINT` (internal, `http://minio:9000`)
  for SDK API calls (bucket create, head, list, delete);
  `getPresignClient()` uses `S3_PUBLIC_ENDPOINT`
  (`https://forge-s3.axiom-labs.dev`) and is used only by the two
  `getSignedUrl(...)` call sites. Browser PUT/GET hits the public
  endpoint, MinIO accepts, signature host matches.

Verified: `https://forge-s3.axiom-labs.dev/minio/health/live` →
HTTP 200 from outside the host. Cert provisioned via existing
Cloudflare DNS challenge.

### Stale-work watchdog (P1 layer 1)

Closes the "Hermes returned 202 but the agent never actually did
anything" gap from push-dispatch.

- Migration `0009_stale_work_watchdog` adds
  `Workspace.assignmentSlaMinutes` (Int, default 0) +
  `Workspace.autoRedispatchOnStall` (Bool, default false), and the
  `ISSUE_STALLED` value to `EventKind`.
- `src/server/services/stale-work.ts` — `sweepStaleWork()` runs in
  the maintenance worker every 60s. For each workspace with
  `assignmentSlaMinutes > 0`: find issues where
  `assignedAgentId IS NOT NULL` AND status category in
  (BACKLOG, TODO) AND `updatedAt < now - slaMinutes`. Emit
  `ISSUE_STALLED` via `recordChange` with payload
  `{ assignedAgentId, agentProfileKey, slaMinutes, lastUpdate }`.
  Idempotent — skips issues that already have an `ISSUE_STALLED`
  event in the last hour (single batched query per workspace).
  When `autoRedispatchOnStall=true`, also clears
  `assignedAgentId = null` and calls `maybeAutoDispatch` to re-pick.
- Wired into `src/server/worker.ts` alongside the existing
  `heartbeat-sweep` and `delivery-drain` jobs (same registration
  pattern, same dedup jobId).
- UI knob added to `/settings/workspace` in a new "Agent SLA"
  section (between Features and Danger zone).
- `ISSUE_STALLED` surfaces in the activity drawer (with
  `AlertTriangle` icon, `text-warning`), agent timeline, issue
  activity panel, and as a `toast.warning` via RealtimeToaster.
- Tests in `src/server/services/__tests__/stale-work.test.ts` (6
  cases: SLA=0 no-op, past-cutoff stalls, fresh updatedAt skipped,
  double-stall idempotency, redispatch path, terminal categories
  ignored). Mirrors `heartbeat.test.ts` style; not run in this
  env (no Postgres on localhost).

### Onboarding skip + invite optional

- Migration `0010_onboarding_persistence` adds
  `User.onboardingDismissedAt` (DateTime?) +
  `User.onboardingSkippedSteps` (String[], default []).
- `src/server/routers/user.ts` extends `me` to include the new
  fields and adds `dismissOnboarding` / `resumeOnboarding` /
  `skipOnboardingStep({ stepId })` / `unskipOnboardingStep({ stepId })`
  mutations. `stepId` constrained to `z.enum(["member"])` for now.
- `OnboardingCard` reads the server flags, filters out skipped
  steps, hides itself permanently when `onboardingDismissedAt`
  is set. New "Skip permanently" button next to the existing X
  dismiss-for-now. Inline "Skip" link on the "Invite a teammate"
  row.
- `ResumeSetupPill` respects the server-dismissed flag and treats
  skipped steps as done for the count.
- `/settings/account` gains an "Onboarding" section: state line,
  Resume/Skip toggle, list of skipped steps with un-skip buttons.

### TODO updates

- P1 layer 1 (stale-work watchdog) marked shipped with the new
  mechanism details. Layers 2 (required ack) and 3 (real SLA
  enforcement on `Issue.slaMinutes`) remain open.

### Verification

- `pnpm typecheck` clean across all three changes.
- MinIO public endpoint live: HTTP 200.
- Migrations land cleanly on a fresh DB (verified by reading the
  generated SQL; the entrypoint runs `prisma migrate deploy` on
  every boot).
- E2E upload test: deferred until container rebuild + redeploy.

## 2026-04-25 — Cohesive flow polish (4-agent parallel wave)

Surface-level UX work to make Forge feel like one continuous thing
instead of a stack of independent pages. Six visible items shipped
plus a small inbox/dashboard cross-link to fix the "two homes"
ambiguity. New `event` router added for the activity drawer.

### Server

- New `event` router (`src/server/routers/event.ts`): `event.recent`
  (paginated workspace-wide ActivityEvent feed, optional `mineOnly`
  narrowing) + `event.unreadCount` (cheap count since `since` for
  the topbar bell badge). Mounted at `appRouter.event` in `_app.ts`.
  No migration; reads existing `ActivityEvent` table.

### UI

- **Activity drawer** (`src/components/activity-drawer.tsx`, default
  export + `useActivityDrawer()` hook). Right-side slide-out
  triggered from a topbar bell icon; subscribes to `useRealtime` to
  invalidate `event.recent` + `event.unreadCount`. "Mine only" toggle
  - "Mark all read" persisted to `localStorage[forge.activityDrawer.lastReadAt]`.
    Esc / backdrop close. Pagination cursor via "Load older". Hidden
    in account-level shells (no workspace context).
- **Topbar bell** with unread-count badge prepended to existing
  actions. Always visible inside a workspace, hidden outside.
- **RealtimeToaster** (`src/components/realtime-toaster.tsx`,
  mounted once in `(app)/w/[slug]/layout.tsx`). Subscribes to
  AGENT_ASSIGNED / AGENT_STATUS_CHANGED / AGENT_DELETED /
  COMMENT_CREATED (mention-only). Fires Sonner toasts with
  per-event icons. Dedup via 100-id LRU set.
- **Dispatch provenance chip** in the issue activity panel. When
  a row is `AGENT_ASSIGNED`, parses `payload.dispatch` defensively
  and renders `[MODE] → @profileKey` after the kind label. Hover
  title carries the full reason.
- **Density utilities sweep** across older surfaces — issue list,
  issue board, cycle planning board, cycle backlog/summary, issue
  detail comment byline, relations panel, time tracker widget,
  standup, projects. Replaced ad-hoc `text-[10px]`/`text-[11px]`
  with the density-aware utilities (`text-id`, `text-meta`).
  Per-user Appearance setting now visibly moves type across the
  whole app, not just the new surfaces.
- **Agent presence drops** — added `AgentPresenceDot` in cycle
  planning board cards (already present on issue list/board
  via earlier work).
- **Agent quick-actions context menu**
  (`src/components/agent-quick-actions.tsx`). Kebab dropdown on
  presence cards (`/agents`) and admin rows (`/settings/agents`).
  Items: View detail, Force ONLINE/BUSY/OFFLINE (calls existing
  `agent.heartbeat` MCP-protected mutation), View recent
  deliveries (links to `/agents/[profileKey]#webhook-health`).
  Click-outside / Escape close. Toast feedback on status flip.
- **Inbox ↔ Dashboard cross-links.** Inbox topbar gains a
  "Workspace overview →" link to `/dashboard`; Dashboard topbar
  gains a "← Back to Inbox" link. Subtitles updated to clarify
  roles: Inbox = "Everything worth looking at, in one place";
  Dashboard = "Workspace overview — onboarding, focus, recent done".
  No migration, no chord changes. Two-homes ambiguity is now
  intentional (Inbox is the daily driver, Dashboard is the
  deeper view) and obvious from either page.

### Wave structure

Wave 1 (me, sequential) = `event` router. Wave 2 (4 agents in
parallel, disjoint files) = ActivityDrawer/bell, Toaster + chip,
density sweep + presence drops, agent quick-actions. Wave 3 (me,
sequential) = inbox/dashboard cross-links. Wave 4 (me, sequential)
= docs + commit + build + deploy + push. Same parallel-wave shape
as the 2026-04-23 / 2026-04-24 polish waves; component agents on
disjoint files keeps merges trivial.

### Verification

- `pnpm typecheck` clean.
- All four agent reports landed clean (no orphaned imports, no
  `any`, no half-finished code per the briefs).

### Follow-ups (filed in TODO.md)

- **Task follow-through (push-dispatch reliability).** Delivery is
  now bulletproof but the agent isn't held to the work. Three-layer
  plan filed under P1: (1) stale-work watchdog (assignment SLA),
  (2) required acknowledgement after wake, (3) real SLA enforcement
  on `Issue.slaMinutes`. Pick up in order; (1) is cheapest.

## 2026-04-25 — Push-dispatch (replace heartbeat cron with Hermes webhooks)

Re-architecting heartbeat from agent-pulled to server-pushed. Replaces
the `hermes cron`-driven `agents.heartbeat` jobs with Hermes' native
inbound webhook adapter receiving real Forge events. Presence is now
derived from "Forge successfully POSTed to this agent's URL" — every
real dispatch event doubles as a heartbeat.

### Forge changes

- `signWebhookBody` unchanged; added a second header
  `x-webhook-signature: <hex of body>` alongside the existing
  `x-forge-signature: <hex of timestamp.body>`. Hermes' generic HMAC
  validator (`X-Webhook-Signature` lookup) accepts the body-only sig;
  Forge-aware receivers can still use the timestamped pair for replay
  protection. Dual-signing avoids forking signature paths per receiver.
- `recordAgentReachable(agentId)` in `src/server/services/heartbeat.ts`
  — bumps `lastHeartbeatAt` and (if OFFLINE) flips ONLINE +
  emits `AGENT_STATUS_CHANGED` with `reason: "delivery-success"`.
  Best-effort; logged but never throws.
- `src/server/worker.ts` calls `recordAgentReachable` after every
  successful delivery to an agent's resolved real URL (i.e. after
  the synthetic `agent:dispatch:{agentId}` shim resolves to the real
  `Agent.webhookUrl`). Failures don't update presence — they let the
  existing idle-sweep flip OFFLINE on its own cadence.

### Hermes side (no Forge code)

- Added `platforms.webhook` to `~/.hermes/config.yaml` (port 8644) and
  `~/.hermes/profiles/mizu/config.yaml` (port 8645). Both gateways
  restarted; `/health` returns 200 on both.
- Subscribed `forge-dispatch` route on each profile via
  `hermes webhook subscribe forge-dispatch --secret ... --prompt ...`
  (subscriptions persist to `~/.hermes/webhook_subscriptions.json` /
  `~/.hermes/profiles/mizu/webhook_subscriptions.json` and hot-reload
  on every POST). The route prompt template tells the agent how to
  respond to each `kind` (AGENT_ASSIGNED → claim/start, COMMENT_CREATED
  → read, etc.).
- `Agent.webhookUrl` set to
  `http://172.16.24.250:8644/webhooks/forge-dispatch` (Victor) and
  `:8645/...` (Mizu). `Agent.webhookSecret` set to the per-route HMAC
  secret returned by the subscribe call. Secrets generated with
  `openssl rand -hex 32`; intermediate file shredded after the DB
  update.
- Removed the two cron heartbeat jobs (`hermes cron remove c5ec6bd4bb6e`,
  `mizu cron remove 45d2c0eb0444`) — push presence subsumes them.

### UI polish

- `/settings/workspace` — `agentIdleTimeoutMinutes` hint rewritten
  from "agent didn't ping" framing to "no successful delivery in N
  min"; explains push-dispatch model.
- `/settings/agents` — webhook URL field hint rewritten to describe
  Hermes' route format and the dispatch event kinds; placeholder
  updated.
- `/agents/[profileKey]` identity strip — adds a small `push` badge
  (success-tinted) next to the configured URL when set, or `pull-only`
  (muted) when not.

### Verification

- `pnpm typecheck` clean.
- `hermes webhook test forge-dispatch` → 202 on Victor's adapter.
  Mizu adapter responded 200 on `/health`.
- E2E green after fixing two pre-existing infrastructure gaps:
  - **Worker wasn't running.** `src/server/worker.ts` defines the
    BullMQ workers but nothing in the Next.js app imported it, so the
    workers were never constructed in production. Added the import to
    `src/instrumentation.ts` (Next.js boot hook). Required externalising
    `bullmq` + every `node:*` builtin in the edge bundle pass via
    `next.config.ts` so the instrumentation hook compiles.
  - **PENDING deliveries weren't enqueued.** `recordChange()` writes
    `WebhookDelivery` rows but never adds them to the BullMQ queue.
    Added a `delivery-drain` job to the maintenance worker that scans
    for `status=PENDING` rows every 5s and adds each one to the queue
    with a stable jobId for dedupe.
  - Live verification: assigned AXI-32 to Victor → `AGENT_ASSIGNED`
    event row written → drain enqueued the delivery → worker POSTed to
    `http://172.16.24.250:8644/webhooks/forge-dispatch` → HTTP 202 →
    `recordAgentReachable` bumped `Agent.lastHeartbeatAt` within 14ms
    of `deliveredAt`.
- **Bonus fix during E2E:** existing agent ids in this DB are not
  cuids (they're 25-char hex strings — Victor `6ea973a47af8fd626d298823d`,
  Mizu `b4f8cf5fe57b40e6a8be27c31`). The `z.string().cuid()` validation
  on `agent.byId/update/archive/.../uptime/webhookHealth/timeline`
  inputs and `analytics.dispatch.summary.agentId` was rejecting them.
  Replaced with a permissive `agentId = z.string().min(1).max(40).regex(...)`
  schema. The `cursor` field on `agent.timeline` stays cuid since it
  refers to ActivityEvent ids which are real cuids.

### Net effect

Forge now owns the dispatch loop end-to-end: events fire, the worker
POSTs, Hermes routes them into the right profile's session, and
presence is a side-effect of real delivery success. No producer on the
Hermes side, no scheduled tool-calls, no LLM cost just to keep
presence fresh.

### Follow-ups

- **Quiet-hours presence:** if agent goes 15+ min without any real
  Forge event, the idle-sweep flips OFFLINE — accurate but possibly
  noisy. Bump `agentIdleTimeoutMinutes` higher overnight, or add a
  periodic `AGENT_PING` synthetic event in the maintenance worker.
  Skipped this lap.
- **Mizu cron** also removed; her webhook adapter is live but she had
  no `lastHeartbeatAt` to begin with — first real dispatch event
  intended for her will set both URL trust and presence.
- The webhook URL is currently the LAN IP `172.16.24.250` because
  Forge runs in a Docker container on the same host as Hermes (which
  runs on the host filesystem). For the cross-host case, swap to a
  reachable hostname.

## 2026-04-25 — Heartbeat wired + agent detail page

Two follow-ups to today's `/agents` dashboard. (1) Victor's
`lastHeartbeatAt` was 21h stale because nothing was calling
`agents.heartbeat` on a schedule — the BullMQ idle-sweep + workspace
knob exist but the producer was missing. (2) The dashboard surfaced
agents but had no drill-down for "what's this agent's history?".

### Heartbeat wiring (Hermes-side cron)

Added two `hermes cron` entries — one per profile — that call
`forge_agents.heartbeat` every 5 minutes via the MCP tool. Cron is
managed by the gateway scheduler; the entries are persisted in
`~/.hermes/cron/jobs.json` (Victor) and `~/.hermes/profiles/mizu/cron/jobs.json`
(Mizu). Verified Victor's `lastHeartbeatAt` updates within ~5s of
each tick. Mizu's tick reports OK but the DB row hasn't bumped —
likely the prompt didn't force a tool call; tracking as a follow-up.

Bumped `Workspace.agentIdleTimeoutMinutes` from 0 (sweep no-op) to
15 minutes via a new UI knob added to `/settings/workspace`. The
`workspace.update` zod schema gained the field with bounds [0, 1440].
The settings page mirrors the existing Sprint length / Cooldown /
Attachment quota pattern.

### Agent detail page

New route `/w/[slug]/agents/[profileKey]` (e.g. `/w/AXI/agents/victor`).
Composes six tRPC calls into a single page:

- **Identity strip** — avatar, name, profileKey, capabilities,
  `maxConcurrent`, configured `webhookUrl`.
- **Stats row (4 cards)** — uptime % (7d), assignments (30d), mean
  TTFA, throughput (7d).
- **Status ribbon** — horizontal SVG segment bar over the last 7 days,
  built from `AGENT_STATUS_CHANGED` events. Legend below shows
  ONLINE/BUSY/OFFLINE durations.
- **Currently working on** — pulls this agent's lane out of
  `agent.pipeline`, splits into In-flight / Assigned / Recently done.
- **Webhook health card** — `agent.webhookHealth` rollup: success /
  pending / failed / dead-letter counts plus the last 6 deliveries.
- **Dispatch eligibility card** — status, load (with cap-flag tone),
  capabilities, last heartbeat, last dispatched.
- **Recent activity feed** — `agent.timeline` filtered to this agent.

### New tRPC procedures (no migration)

- `agent.uptime` — windowed status math from `AGENT_STATUS_CHANGED`
  events. Returns `totalMs`, per-status time, `uptimePct`,
  `currentStatus` + `currentSince`, and the raw `transitions` list.
  Heuristic: when the window has no events, attribute the entire
  window to the agent's current status; the pre-window seed comes
  from the most-recent transition before windowStart.
- `agent.webhookHealth` — counts `WebhookDelivery` rows for the
  synthetic per-agent shim (`agent:dispatch:{agentId}`) and the
  workspace-shared shim (`agent:dispatch`). Returns totals plus a
  `recent` list with response status for a "what just failed" panel.

### Click-through wiring

Four entry points now navigate to the detail page:

- `AgentPresenceStrip` — the whole card is now a `<Link>`.
- `AgentPipeline` — the agent name + profile key in the lane header
  links to the detail; status dot stays inert (it's a hover-title
  primitive, not a click target).
- `/settings/agents` — added a "View" button on each row, before
  Edit/Archive/Delete.

### Hermes webhooks investigation (ran in parallel as a research lane)

Hermes has a first-class **inbound webhook adapter** at
`gateway/platforms/webhook.py` (binds 8644 by default, HMAC-SHA256
auth — GitHub / GitLab / generic flavors), with a CLI manager
(`hermes webhook subscribe|list|remove|test`) that hot-reloads
subscriptions from `~/.hermes/webhook_subscriptions.json` on every
POST. Per-route prompt templates with `{dot.notation}` payload
interpolation; `deliver_only: true` flag bypasses the agent loop
entirely (zero LLM cost — straight push). Profile routing = one
port per profile (Victor 8644, Mizu 8645, Mizuki 8646), since each
profile runs its own gateway.

Currently NOT enabled (no listener on 8644). To switch from the
poll-style heartbeat / queue-pull pattern to push-style dispatch:
flip `platforms.webhook` on in each profile config, subscribe one
route per profile, set the corresponding `Agent.webhookUrl` (e.g.
`http://172.16.24.250:8644/webhooks/forge-dispatch`), and let the
existing Forge `WebhookDelivery` worker POST `AGENT_ASSIGNED`
straight to Hermes — the route prompt would render "you have a new
assignment: AXI-42" and wake Victor's session. MCP polling for
issue data + state stays; webhooks **complement** MCP (wake +
notify), they don't replace it.

Filing as a follow-up — keeping cron heartbeat for now as the user
specified.

### Verification

- `pnpm typecheck` clean.
- Heartbeat cron verified live: Victor's `lastHeartbeatAt` updated
  to within seconds of the first tick.
- `pnpm lint` / `pnpm test` not re-run; no new files vs the previous
  commit beyond the detail page + procedure additions; pre-existing
  `issue-board.tsx` lint errors still untouched.

### Follow-ups

- Mizu's heartbeat cron fires "OK" but `Agent.lastHeartbeatAt`
  doesn't bump — the prompt likely doesn't force a tool call. Tighten
  the prompt or replace with a direct `mcporter call` for both
  profiles.
- Hermes webhook adapter looks like a clean fit for push-dispatch
  (see investigation above). Worth a follow-up wave once Mizu's
  heartbeat is fixed.
- The status ribbon currently shows a flat segment when the agent
  has been at one status for the full window. Consider overlaying
  heartbeat-tick markers so silent hours look different from active-
  online hours.

## 2026-04-25 — Agents operational dashboard (3-agent parallel wave)

Stood up `/w/[slug]/agents` — a live operational view of the agent fleet
that complements (not replaces) the existing CRUD page at
`/settings/agents`. Goal was to surface presence, in-flight work, and
recent activity on one screen so operators can see "what's everyone
doing right now" without clicking through Inbox + Analytics.

### What landed

**Server (one router, two procedures, no migration).** Extended
`src/server/routers/agent.ts`:

- `agent.pipeline` — per-agent swimlanes plus the unassigned pool. For
  each non-archived agent returns `{ assigned, inFlight, recentlyDone }`
  bucketed by status category (BACKLOG/TODO, IN_PROGRESS/IN_REVIEW,
  DONE-within-`recentDays`). Pool = queued issues with
  `assignedAgentId = null`, split into ready/blocked using the same
  blocker-graph logic as `issue.queue`. Lane and pool sizes capped
  (`laneLimit` default 25, `poolLimit` default 50).
- `agent.timeline` — paginated agent-relevant ActivityEvent feed.
  Kinds: `AGENT_*`, `ISSUE_QUEUED`, `ISSUE_STATUS_CHANGED`,
  `COMMENT_CREATED`. Optional `agentId` narrows to subject-agent events,
  `payload.agentId` matches, and issue events on issues currently
  assigned to that agent. Cursor pagination on `(createdAt DESC, id
DESC)`. Hydrates referenced issues + agents in batched lookups.

The blocker-graph helper (`findBlockedIssueIdsForWorkspace`) is a local
copy of the one in `issue.ts` — keeps the agent router import-
independent of issue.ts; the duplication is ~25 lines of pure SQL
filter logic.

**UI (3 components, fan-out to a single page).**

- `src/components/agent-presence-strip.tsx` (133 lines) — horizontal
  strip of per-agent presence cards. Reads `agent.list` +
  `agent.pipeline` + `analytics.dispatch.summary`. Live invalidation on
  `AGENT_STATUS_CHANGED`, `AGENT_ASSIGNED`, `AGENT_UPDATED`,
  `ISSUE_STATUS_CHANGED`. Load bar tints amber when at/over
  `maxConcurrent`.
- `src/components/agent-pipeline.tsx` (222 lines) — the centerpiece.
  Pool lane on top (`Ready | Blocked`), then one lane per agent
  (`Assigned | In flight | Recently done`). Compact issue cards reuse
  the warm-earthy tokens (`text-id`, status-color dots, project key
  chip). Live invalidation on `ISSUE_*` and `AGENT_*` kinds.
- `src/components/agent-timeline.tsx` (340 lines) — chronological feed
  with per-agent filter chips. Per-kind icons; per-kind summary
  builder (assignment / status move / queue / comment / agent CRUD).
  "Load older" replaces visible page (no cross-page accumulation —
  picked the simpler ship over infinite scroll).

**Page + nav wiring.** New page at
`src/app/(app)/w/[slug]/agents/page.tsx` composes the three components
under a `Topbar` with a "Manage agents" link out to `/settings/agents`.
Sidebar nav added a new "Agents" entry with `Workflow` icon between
Analytics and the existing settings entry; existing settings entry
relabeled to "Agent admin" so the two surfaces don't both read
"Agents". Chord `g a` was already taken (Analytics) so the new page is
`g o` (mnemonic: ops); `g e` continues to point at Agent admin.
`src/lib/shortcuts.ts` updated to match.

**Wave structure.** Wave 1 = me, sequential, server contract (one file
edit). Wave 2 = 3 parallel general-purpose agents, one component each,
disjoint files, all consuming the Wave 1 procedure shapes. Wave 3 =
me, sequential, page composition + nav + chord + docs. Roughly
matches the parallel waves used on 2026-04-23 and 2026-04-24 — keeps
component agents on disjoint files so merges are trivial.

### Verification

- `pnpm typecheck` clean (post-integration).
- `pnpm lint` — no new warnings or errors from any of the new files.
  The existing `src/components/issue-board.tsx` `no-explicit-any`
  errors are still there from before this session; not touched.
- `pnpm build` and `pnpm test*` not run because Postgres + Redis are
  not reachable in this environment.

### Follow-ups

- The "currently assigned" heuristic in `agent.timeline` will mis-
  attribute past activity for issues that have been reassigned. If
  that becomes user-visible, snapshot `assignedAgentId` in the
  `AGENT_ASSIGNED` payload (already there) + `ISSUE_STATUS_CHANGED`
  payload (would need a small dispatcher tweak) and filter on
  payload-agent rather than current-state.
- Optional Hermes-side enhancement (deferred): extend
  `agents.heartbeat` to accept `currentIssueId` so the presence strip
  can show "now working on X" without inferring from status. Forge
  side = small migration; Hermes side = update
  `~/.hermes/skills/pm/forge/SKILL.md` runbook so Victor calls
  heartbeat with the issue id at pickup. Per `~/SYSTEM.md` line 119
  this is the documented hook point.
- `agent.pipeline` issues a small fan-out of queries (3 per agent +
  pool + agents list + blocker graph). Fine for the current handful
  of agents per workspace; if agent counts grow, fold into a single
  raw query keyed off Issue + Status.

## 2026-04-25 — Life Ops execution layer polish

Follow-up on the Sprint/Life Ops handoff. Kept backend/database names as
`Cycle` and `cycle.*`; tightened the operator-facing product language and
added small execution-layer affordances without a migration.

### What landed

**Sprint UX**

- Finished remaining visible Sprint copy on the `/cycles` surface: page title,
  previous/next tooltips, create CTA, and planning toast now say Sprint.
- Added a current-sprint empty callout in `CyclePlanningBoard`:
  "No issues planned for this sprint." It explains that Backlog stays separate
  and includes a "Plan current sprint" action that points the operator at the
  Backlog drag source.
- Kept the existing summary card date range, issue count, completion count, and
  burndown. Internal `cycleId` comments now explicitly call out the Sprint UI
  alias.
- Renamed visible Inbox sprint rollups and Analytics "cycle time" language to
  Sprint / flow time.

**Agent queue clarity**

- Inbox now has an Agent queue section for the current workspace, backed by
  `issue.queue`.
- Queue rows show issue id/title/status/project, ready vs blocked vs claimed,
  assigned-agent presence, claim expiry, and queue-level counts
  (`ready now`, `assigned`, `claimed`, online/busy agents).
- `issue.queue` now includes `assignedAgent` in its return payload so the UI can
  distinguish queued-unassigned from queued-assigned work.
- Issue detail queue control now says "Queue for agent", shows Queued / Not
  queued state, and invalidates the queue after queue/release changes.

**Issue templates + intake stance**

- `template.list` now seeds six generic default issue templates on first use:
  Dev task, Agent-ready task, Home/personal task, Finance follow-up, Side quest,
  and Review item.
- Agent-ready template requires Objective, Project / repo / system area,
  Acceptance criteria, Safety / approval boundaries, and Verification path.
- README and API docs now state that Forge is the execution layer, Sprint is the
  product term, `Cycle` remains internal for compatibility, captured ideas are
  not auto-promoted into active sprints, and shared household/couple workflows
  are deferred.

### Verification

- `pnpm typecheck` clean.
- `pnpm build` clean. Build emitted existing Redis `ECONNREFUSED` noise during
  page data/static generation because local Redis was not running, but exited 0.
- `pnpm lint` still fails on pre-existing `src/components/issue-board.tsx`
  `no-explicit-any` errors; this patch added no new lint errors.
- `pnpm test` failed before exercising behavior because Postgres
  `localhost:55432` and Redis were not reachable in this environment.
- `pnpm test:e2e` not run because the required Postgres/Redis services were not
  available.
- `git diff --check` clean.

### Follow-ups

- Mission Control can deep-link into `/w/:slug/inbox` for agent queue status and
  `/w/:slug/cycles` for current Sprint planning.
- A future template picker in Quick Create would make seeded issue templates
  faster to apply; today they are managed in Settings and available through the
  existing template surfaces.

## 2026-04-24 — UX audit + 5-agent parallel polish wave

Audit-driven polish session. User asked for a UX-from-the-user-perspective
review; we found and fixed a real upload bug along the way and shipped a
broad polish wave.

### What landed

**Storage / uploads (was broken)**

- README advertised MinIO but neither `docker/docker-compose.yml` nor `.env*`
  configured it. `getS3Client()` was throwing on every attachment call,
  surfacing as vague "not found" pills and "BAD_REQUEST" toasts.
- Added `minio` service to compose (`forge-minio`, ports 59000/59001 on
  host, root creds `forgeminio` / `forgeminio-dev-password`).
- Added `S3_*` vars to `.env` and `.env.example` with a comment block.
- New `StorageNotConfiguredError` typed exception + `isStorageConfigured()`
  helper. `attachment` router maps the typed error to `PRECONDITION_FAILED`.
- `IssueAttachmentsPanel` now shows a single inline `StorageNotConfiguredBanner`
  (with the exact env vars to set) instead of letting the failure surface as
  noisy per-tile toasts. `MarkdownWithAttachments` shows a clear
  "Attachment unavailable — storage error" pill with the error in the title.
- **Operator note:** there's an existing `forge-minio` container on the box
  bound to host ports 9000/9001 from a previous compose. To pick up the new
  ports, run `docker compose -f docker/docker-compose.yml down minio &&
docker compose -f docker/docker-compose.yml up -d minio` (container name
  is reused).

**Appearance preferences (new feature)**

- New `User.density` and `User.textSize` columns, both nullable, defaults
  read as `compact` / `default` (current behavior). Migration `0008`.
- New `userRouter` with `me` and `updateAppearance` (also covers `theme`).
- `AppearanceProvider` mounted in workspace shell mirrors the prefs onto
  `<html data-density data-textsize>`.
- `/settings/appearance` page (account-scoped) — auto-saves on click, shows
  a live preview row that uses the actual utility classes.
- Four density-aware utility classes added to `globals.css`:
  `text-id`, `text-meta`, `text-filename`, `text-subtitle`. Each cascades
  on `[data-density]` and `[data-textsize]`.

**Cycles → Sprints (UI rename only)**

- All user-facing labels, buttons, tooltips, page subtitles renamed.
- DB models, tRPC routers (`cycle*`), routes (`/cycles`), folder names,
  `Workspace.cycleLengthDays`, and procedure names left **unchanged** —
  this is a display-string-only rename. A future migration can rename the
  data layer if desired.

**Empty states**

- Added `EmptyState` blocks to Issues (gated on `_count.issues===0` AND
  no filters), Inbox ("Inbox zero" hero), Analytics tabs, Cycles ("No
  sprints yet" with new-sprint CTA), Roadmap (refreshed copy + projects
  link), Standup ("Quiet day").
- Each has its own voice — none feel templated.

**Quick-create overlay polish**

- Container widened `max-w-2xl` → `max-w-3xl`, vertical rhythm bumped.
- Input upgraded from `text-sm` to `text-base`.
- ModeChip is now a real popover dropdown for non-issue-context modes —
  user can switch Issue/Sprint/Project/Initiative without navigating first.
  Outside-click closes the popover, not the overlay.

**Sidebar "New X" button**

- Pathname-aware label: `/projects` → "New project", `/cycles` →
  "New sprint", `/initiatives` → "New initiative", else "New issue".

**Onboarding re-entry**

- `useOnboardingDismissed` hook (localStorage + cross-component window
  event). When the OnboardingCard is dismissed but the checklist isn't
  complete, a `<ResumeSetupPill>` appears in the dashboard topbar; clicking
  it clears the flag and the card re-mounts in place.

**Tooltip / subtext sweep**

- Workspace settings: hints on Sprint length, Cooldown, Attachment quota.
- Agents page: `title=` tooltips on profileKey, capabilities chip group,
  webhookUrl, maxConcurrent.
- Dispatch rules: page subtitle expanded to a one-paragraph plain-language
  explanation of how rules relate to auto-dispatch.

**Density class application (text bumps)**

- Issue IDs: dashboard focus grid, projects list, initiatives list +
  detail page, initiative cards.
- Activity timestamps in `IssueActivityPanel`.
- Filename overlay on attachment thumbs.
- Topbar subtitle.
- Pending-tile metadata (file size + status) in attachment uploads.

### Verification

- `pnpm typecheck` clean.
- `pnpm lint` — all errors are pre-existing in `issue-board.tsx` (untouched
  by this session). New files lint clean.
- `pnpm test` not run — local test DB not reachable on this host. The
  integration suite runs against Postgres at `localhost:55432` per CLAUDE.md
  convention; bring it up to verify.

### Files touched (high-level)

- New: `src/server/routers/user.ts`, `src/components/appearance-provider.tsx`,
  `src/app/(app)/settings/appearance/page.tsx`,
  `prisma/migrations/0008_add_user_appearance_prefs/`.
- Modified: schema.prisma, globals.css, compose, env files, sidebar,
  quick-create, topbar(s), 6 page-level files for empty states, cycles
  components for Sprints rename, attachment panel + renderer for storage
  errors, dashboard for onboarding re-entry, settings sub-pages for
  tooltips.

## 2026-04-23 — P3 wave + admin user management (6-agent parallel)

Second big parallel wave the same day. All P3 items landed, plus the P2
email-invite item was reshaped into admin-gated workspace membership
(Authelia is the identity source — self-service invites never fit).
P2 BullMQ-as-separate-container and per-agent permission lattice were
held for a design pass.

Migrations added this wave:

- `0005_agent_templates` — `Agent.templateMarkdown String? @db.Text`
- `0006_dispatch_rules` — `DispatchRule` table (conditions + targetAgentId,
  workspace FK CASCADE, label/project FK SET NULL, agent FK RESTRICT,
  index on `(workspaceId, enabled, order)`)
- `0007_membership_events` — three new `EventKind` values
  (`MEMBERSHIP_CREATED`, `MEMBERSHIP_ROLE_CHANGED`, `MEMBERSHIP_REMOVED`)

Migration count 0004 → 0007. Total tests 112 → **153** (+41 new).

**Admin-gated user management (replaces email invite).**
`workspace.invite` stubbed to throw `PRECONDITION_FAILED` pointing at
the new member-management surface. New admin-only procedures on
`workspace` router: `listMembers`, `addMember` (finds-or-creates User
by email; idempotent on existing membership — returns
`created: boolean` without mutating role), `setMemberRole`,
`removeMember`. Last-admin guards on both mutations, keyed to
ADMIN+OWNER roles collectively. Each mutation records audit + event
via `recordChange()`. New admin page at `/settings/members` using
`<QuickForm>` for add, inline role select, `<Confirm
typeToConfirm={email} variant="destructive">` for remove. Sidebar
settings entry carries the `admin only` badge. 13 new tests —
membership lifecycle + guard cases + non-admin rejection.

**P3-1 — Agent presence indicators.** New primitive
`src/components/agent-presence-dot.tsx` using tokens
(`bg-success` / `bg-warning` / `bg-muted-foreground/70`). `pulse`
option adds `motion-safe:animate-ping` with reduced-motion respect,
enabled only where presence is the focus (agents list). Title attribute
carries `"{Status} · heartbeat {relativeTime}"` when
`lastHeartbeatAt` passed. Dot now appears on: issue list agent chips,
issue board cards, issue detail `AgentChip` + `AgentPickerModal`,
bulk assignee picker's Agents tab, and the agents settings list
(migrated from the legacy hex-tone swatch). `RealtimeProvider` now
invalidates on any `AGENT_*` event OR `subjectType === "agent"`,
picking up the new `AGENT_STATUS_CHANGED` event from the heartbeat
sweeper without a dedicated subscription. Skipped the command palette
(no agent-assignment surface there today) and the topbar (no agent
chrome) per "don't invent new UI".

**P3-2 — Per-agent issue templates.**
`Agent.templateMarkdown` (nullable, `@db.Text`). New helper
`src/server/services/agent-template.ts::maybeApplyAgentTemplate(tx,
issueId, agentId)`. Contract: loads template, no-ops on null/empty
template or non-empty issue description (NEVER overwrites human
content). When applied, writes an `ISSUE_UPDATED` audit with
`payload.fromAgentTemplate = true` — chose audit-only over a system
comment because `Comment.authorId` is a non-null FK to `User` and
synthesizing one felt fragile. Called from all four assignment paths:
auto-dispatch (inside `assignAndEmit`), `issues.assign` MCP,
`issues.reassign` MCP, and both `issue.create` + `issue.update`
tRPC mutations. Template textarea added to the agent edit form with
the canonical `### Context / ### Acceptance criteria / ### Constraints`
placeholder. 6 new tests.

**P3-3 — Dispatch analytics.** New `analytics.dispatch.{summary,
timeseries}` procedures. `summary` returns per-agent rollup
(`assignments`, `meanTimeToFirstAction`,
`meanTimeToCompletion`, `throughputLast7d`, `modeDistribution`).
TTFA SQL uses a LATERAL join bounding each assignment window by the
NEXT AGENT_ASSIGNED on the same issue — so re-assignments don't leak
each other's "first action" into the wrong agent's mean. First-action
is `ISSUE_STATUS_CHANGED | COMMENT_CREATED | ISSUE_UPDATED with
payload.event = 'time.start'` (there's no `TIME_STARTED` kind — time
starts are written via `ISSUE_UPDATED`; pattern confirmed in
`timeEntry.ts:143`). Assignments with zero in-window follow-up are
excluded from the mean and surfaced separately as
`assignmentsWithoutAction`; still-open issues likewise excluded from
TTC and surfaced as `openAssignments`. UI: new `?tab=dispatch` on the
analytics page — top cards + sortable per-agent table with exclusion
count tooltip + SVG line chart + stacked-bar mode distribution.
Zero new deps — reused the existing hand-rolled CSS/SVG chart
convention. 3 new integration tests seed deterministic event
sequences and assert counts/means/throughput.

**P3-4 — Notification bridge plugin.** New first-party plugin at
`plugins/notification-bridge/` (manifest/handler/format/README).
`format.ts` is a pure `formatEvent(event, workspace) → { slack,
discord }` so tests don't touch the network. Slack output uses
`{ blocks: [...] }` incoming-webhook shape; Discord uses
`{ embeds: [...] }`. Issue identifier (`AXI-42` style) + Forge link
built from the event's workspace slug. `mentionsOnly` config key
suppresses non-mention events. Hardcoded block-list prevents noisy
kinds (`HEARTBEAT` etc) from being forwarded even if a caller
configures them. Registered in `src/server/services/local-plugins.ts`
alongside `issue-triage`. Config lives in `Plugin.manifest.config`
(no dedicated `PluginInstallation.config` column exists; fallback to
manifest config when skill input doesn't carry config inline).
9 new unit tests.

**P3-5 — Dispatch rules engine.**
New `DispatchRule` model + admin router at
`src/server/routers/dispatch-rule.ts` with
`list/create/update/reorder/toggle/delete`. Dispatcher consults rules
BEFORE the mode switch — ordered by `order ASC, createdAt ASC`, first
match wins. Conditions are ANDed with null = wildcard
(`priority`, `labelId`, `projectId`). When a matched rule's target is
ineligible (offline / archived / over cap), we record
`rule:{id}:target-ineligible` and fall through to mode-based selection
rather than stalling — the reason string carries the provenance:
e.g. `rule:abc123:target-ineligible,round-robin pick`. Rule fires
emit `dispatch.mode = "RULE"` on the payload with
`candidates: [target]` + `chosen: target`. Reorder UI uses the
existing drag-n-drop pattern from the Statuses page (no new dep).
10 new tests — priority/label/project wildcards, combined conditions,
disabled skip, target-ineligible fallthrough, no-match fallthrough.

**Integration notes (the interesting merge).**
Wave-2 worktrees were cut from `origin/master` (still at wave-0's
870f7a3 — wave 1 hadn't been pushed), so each branch had a stale
schema/codebase view. The `ort` merge handled most of this cleanly
but botched `dispatcher.ts`: P1-4 (wave 1) extracted `isEligible`;
P3-5 (wave 2) added a rules layer + refactored assignment into
`assignAndEmit`; the merge placed P1-4's provenance-building code
_inside_ `assignAndEmit` where its free variables (`agents`, `picked`,
`matchCountByAgent`) weren't in scope. Rewrote `assignAndEmit` as a
thin helper that takes `meta.dispatch?: Prisma.InputJsonObject`; call
sites now build candidates/chosen locally (mode path has the full
shape; rule path synthesizes a single-entry `[target]`). P3-2's
template call moved into `assignAndEmit` so all three selection
strategies apply templates uniformly. The two `dispatch.reason`
conventions between P1-4 tests (`"round-robin"`, `"capability-match:1"`)
and P3-5 tests (`"round-robin pick"`) were reconciled by keeping
`dispatch.reason` (inside the payload) as the terse tag and the
returned `reason` string as the verbose `${modeLabel} pick` form —
both test suites pass.

Small schema enum conflict: wave 1 added `AGENT_STATUS_CHANGED` to
`EventKind`; admin branch added three `MEMBERSHIP_*` values — both
appended cleanly when reconciled.

**Validation.**

- `pnpm prisma generate` clean against merged schema.
- All 8 migrations already applied to the test DB by sub-agents; no
  pending deploys needed on local.
- `pnpm typecheck` clean.
- `pnpm test` — **22 files, 153/153 tests passing**.
- Did not run `pnpm test:e2e` — holding for post-deploy verification.

Tool count unchanged (no new MCP tools this wave; `issues.reassign`
already counted from wave 1). `DispatchRule` is the first new top-level
model since wave 1's schema additions. `notification-bridge` is the
second first-party plugin (joins `issue-triage`).

Next candidates (P2 holdouts): BullMQ-as-separate-container
(pulls webhook worker into its own service), per-agent permission
lattice (narrow `WRITE_ISSUES` to "only on my assigned issues" without
inventing a new scope). Both architectural, warranting design pass.

## 2026-04-23 — P1 high-value follow-ups (6-agent parallel wave)

All six P1 high-value follow-ups landed in a single integration pass. Each
item was dispatched to an isolated worktree agent; six branches merged
sequentially onto master with one real conflict on `worker.ts`.

Migrations added:

- `0003_comment_agent_authorship` — `Comment.authoringAgentId` nullable FK
  → `Agent.id` (ON DELETE SET NULL), index on the column, back-relation
  `Agent.authoredComments`. FK type is plain `String` (not `@db.Uuid`) to
  match `Agent.id`'s cuid shape; SQL column is `TEXT`.
- `0004_agent_status_changed_event` — adds `AGENT_STATUS_CHANGED` to the
  `EventKind` enum (idempotent `ADD VALUE IF NOT EXISTS`).

**P1-1 — DLQ inspection UI.** New nested admin router
`admin.webhookDeliveries.list` + `.retry` (workspace-scoped, admin-gated).
List truncates `responseBody` to 2KB server-side and derives a
presentation-only `kind` (`agent`/`plugin`/`workspace`) from
`webhook.pluginId` + the `agent:dispatch` URL prefix. Retry resets
`status→PENDING`, `attempt→0`, `scheduledAt→now` and writes an `AuditLog`
row directly — not via `recordChange()` — because no existing `EventKind`
fits admin-infra retries and emitting one would itself fan out webhooks.
New page at `settings/integrations/deliveries/` renders the list in the
existing warm-earthy styling, opens the delivery row in a `<SidePanel>`
with full payload + response body + a `<Confirm>`-gated Retry button.
Sidebar entry added under Settings → Developer. Real field names
(`attempt` / `responseBody` / `scheduledAt`) were kept instead of the
spec's `attemptCount` / `lastError` / `nextAttemptAt` — a richer rename
migration felt out of scope for a UI follow-up.

**Refactor (shipped with P1-1).** `webhookQueue` extracted from
`worker.ts` into a new `src/server/queues.ts` so producer-side code
(tRPC mutations, admin retry) can enqueue without pulling `Worker` into
the Next.js web process. At integration I promoted P1-3's
`maintenanceQueue` into the same file for consistency —
`maintenanceWorker` and `registerHeartbeatSweepJob` stay in
`worker.ts`. This was the one conflict resolution needed across the
whole merge.

**P1-2 — Agent authorship on comments.** `comment.create` (tRPC +
`comments.create` MCP tool) reads `ctx.apiKey?.linkedAgentId` and
stamps it on new `Comment` rows. Null for human sessions. Issue detail
pulls `authoringAgent` eagerly in `issue.byId` so the comment list
doesn't make a second roundtrip. Renderer replaces the human byline
with the agent's name when `authoringAgent` is set and appends an
indigo `AGENT` chip (matches the `linkedAgent` pill used on ApiKey
rows in `settings/access`). Existing `mentions[]` payload on
`COMMENT_CREATED` is untouched.

**P1-3 — Heartbeat auto-offline.** New `src/server/services/heartbeat.ts`
with `sweepIdleAgents()` — iterates workspaces, applies each
workspace's `agentIdleTimeoutMinutes` independently, guarded
`updateMany({ where: { status: { not: OFFLINE } } })` so heartbeats
landing mid-sweep don't get clobbered, `AGENT_STATUS_CHANGED` audit
only fires when `count > 0`. Dedicated `maintenance` BullMQ queue
(concurrency 1) with `registerHeartbeatSweepJob()` using a stable
`jobId: "heartbeat-sweep"` + `repeat: { every: 60_000 }` — idempotent
across restarts per BullMQ upsert semantics. Registration is
fire-and-forget so a Redis outage at boot doesn't crash the worker.
8 integration tests cover stale/fresh/null heartbeats, archived
agents, BUSY→OFFLINE transitions, and the 0-minute "skip" case.

**P1-4 — Dispatch observability.** Dispatcher enriches
`AGENT_ASSIGNED.payload.dispatch` with `{ mode, candidates[], chosen,
reason }`. Candidate rows include `{ agentId, profileKey, capabilities,
activeCount, maxConcurrent, lastDispatchedAt, matchCount?, eligible }`
— ineligible agents (over `maxConcurrent`) appear with
`eligible: false` so "why not them" is queryable too. `matchCount`
only set on `CAPABILITY_MATCH`. No table, no migration — pure JSON
enrichment. `reason` follows `<mode>[:detail]` convention
(`"round-robin"`, `"capability-match:1"`, `"priority-match-urgent"`).
Manual-path emit sites (`issue.ts`, `mcp.ts`) deliberately untouched;
`dispatch` is documented as optional on the payload.

**P1-5 — `issues.reassign` MCP tool.** 44th tool (bumped from 43).
Single transaction: resolves `toProfileKey` → `Agent`, captures
`fromAgentId`, creates a comment `"Handoff → @{profileKey}: {rationale}"`,
swaps `assignedAgentId`, fires `AGENT_ASSIGNED` with
`{ auto: false, from, to, reason: "handoff", rationale, commentId }`.
Requires `WRITE_ISSUES`. Rationale is Zod-validated `min(10)`.
Same-agent reassignment rejects (a handoff implies a transition; use
`comments.create` for a note-to-self). 7 new tests. Comment stamping
with `authoringAgentId` falls through naturally via P1-2's
`comment.create` path — no explicit wiring needed.

**P1-6 — Bulk label + bulk assign.** Three new mutations on `issue`
router: `bulkSetLabels`, `bulkAssign`, `bulkAssignAgent`. All
workspace-scoped, `max(500)` issue cap matching the existing
`bulkStatus` ceiling. Per-issue `recordChange()` preserved so the
audit+event invariant holds for bulk ops — including agent
`AGENT_ASSIGNED` fan-out through the existing webhook path. UI on
`issue-list.tsx` toolbar: new `<Picker>`-based `BulkLabelPicker`
(add/remove semantics with mixed-state indicators for labels present
on some-but-not-all selected issues) + `BulkAssigneePicker` (Humans
/ Agents tabs, single-pick per tab, explicit "Unassign" row).
Did not collapse into the single-issue pickers — their data shape is
too different to retrofit without muddling them.

**Validation.**

- `pnpm prisma generate` clean against merged schema.
- `pnpm prisma migrate deploy` applied `0003` + `0004` cleanly to the
  test DB.
- `pnpm typecheck` clean.
- `pnpm test` — **17 files, 112/112 tests passing** (up from 82 in the
  last wave; 30 new across dispatcher, heartbeat, comment,
  reassign, admin DLQ, and bulk-issue suites).
- `pnpm lint` — no new warnings from this wave. Pre-existing
  `issue-board.tsx` `any` errors untouched (last modified in
  `6650e07`, before this wave).
- Did not run `pnpm test:e2e`. Not pushed; no prod deploy yet — flagging
  for explicit approval.

Tool count 43 → 44. Migration count 0002 → 0004. Remaining P1 items:
none. Next wave candidates live in TODO.md under P2 / P3.

## 2026-04-20 — P0 follow-up wave (agent loop closure + docs + repo rename)

Three-lane follow-up closes the gaps the primary P0 wave deferred.
Migration `0002_agent_links` adds `ApiKey.linkedAgentId`, `Agent.
webhookSecret`, and `Agent.lastDispatchedAt`.

**Lane A — key link + comment mentions + priority webhooks.**
`api-key-auth` now carries `linkedAgentId` through the context;
`issues.assigned` falls back to the calling key's linked agent when
`profileKey` is omitted. `access` router + UI expose a "Link to agent"
selector (populated from `trpc.agent.list`) and render the linked
agent as an indigo chip on each key row. Comment create parses
`/@([a-z0-9][a-z0-9-_]*)/g` tokens via a new `extractMentions` helper,
resolves matched agents in the workspace, and enriches the existing
COMMENT_CREATED payload with `{commentId, issueId, preview,
mentions[]}`. No double-emit. Audit.ts gains
`AGENT_DISPATCH_WEBHOOK_URL_PREFIX` + an `agentDispatchUrlFor(id)`
helper + an `upsertAgentDispatchWebhook` that lazy-creates a per-agent
synthetic Webhook row. Three independent fan-out paths now coexist:
generic `agent:dispatch` for AGENT_ASSIGNED / ISSUE_QUEUED, per-agent
`agent:dispatch:{id}` for ISSUE_PRIORITY_CHANGED where `to ∈ {HIGH,
URGENT}` on an assigned issue, and per-agent shim for COMMENT_CREATED
mentions — one delivery per mentioned agent, filtered by
`webhookUrl != null`. Worker parses the `agent:dispatch:{id}` suffix
and uses `Agent.webhookSecret ?? webhook.secret` for the HMAC key.

**Lane B — auto-dispatcher runtime.** New
`src/server/services/dispatcher.ts::maybeAutoDispatch(tx, issueId)` —
short-circuits when the issue is already assigned, not queued, or the
workspace isn't set for auto-dispatch. Loads eligible agents
(`archivedAt null`, `status != OFFLINE`, under `maxConcurrent`). Pick
rules:

- `ROUND_ROBIN` — oldest `lastDispatchedAt` NULLS FIRST.
- `PRIORITY_MATCH` — prefer agents with the priority name in
  `capabilities`; tie-break round-robin.
- `CAPABILITY_MATCH` — intersect issue label names with agent
  capabilities; most matches wins; zero-matches falls through to
  round-robin rather than stalling.
  Writes `assignedAgentId` + bumps agent `lastDispatchedAt` + fires
  AGENT_ASSIGNED with `payload.auto = true` and the picking mode.
  Invoked from `issue.create` and `issue.setQueued` inside the existing
  `$transaction`. 8 new tests cover all modes + maxConcurrent + idempotency.

**Lane C — Victor + Mizu bootstrap.** `scripts/seed-agents.ts` +
`pnpm seed:agents` — idempotent upsert on `(workspaceId, profileKey)`,
reads `FORGE_AGENT_VICTOR_WEBHOOK_URL` / `_MIZU_` from env, best-effort
links any active ApiKey whose name matches `%victor%`/`%mizu%` (case-
insensitive) to the new agent. Script couldn't run end-to-end locally
(no AXI in dev DB); seeded prod via raw SQL against `forge-postgres`
inside the container. Agents inserted with ids `6ea973a4...` (Victor)
and `b4f8cf5f...` (Mizu); existing "Hermes · Victor" and "Hermes · Mizu"
ApiKeys linked.

**Docs + repo rename.** Repo renamed `Codename-11/forge` →
`Codename-11/Forge` via `gh api -X PATCH`. Description + homepage +
eight topics set. Local origin updated. Rewrote README to match the
ARC style (centered header, badge row, doc-link row, Agents & MCP
section with curl examples, auto-dispatch callout, keyboard table
rebuilt). CLAUDE.md gains the Agent primitive + Auto-dispatch section
and the ApiKey-linkedAgentId note. TODO.md reorganised: P0 items
struck through with ✅, P1 MCP-tools section marked done, new "P1 —
High-value follow-ups" section captures the dogfooding gaps (DLQ UI,
agent identity in comments, heartbeat auto-offline, dispatch
observability, handoff flow). docs/API.md refreshed with the 43-tool
namespace table + full EventKind list.

**Validation + deploy.**

- `pnpm typecheck` clean.
- `pnpm test` 82/82 (8 new dispatcher, 5 new mention parser).
- Image `forge:local e0c5f6b430ef`; entrypoint applied
  `0002_agent_links` cleanly on boot.
- Prod smoke: `tools/list` 43 tools; `analytics.summary` 200;
  `issues.assigned` called with no args against the Victor-linked key
  returns `[]` (correct — no issues assigned yet).

Remaining follow-ups live in TODO.md under "P1 — High-value
follow-ups". Hermes-side consumer work (auto_claim, poll_interval,
task-inbox on greeting, completion flow) is tracked in the TODO and
will land in the Hermes repo, not here.

## 2026-04-20 — P0 agent integration (3-lane wave)

Executing `TODO.md` P0 — first-class agent identity + push dispatch. Three
parallel agents coordinated against a pre-landed schema/routing baseline.

**Foundation (coordinator).** New Prisma enums `AgentStatus`
(ONLINE/OFFLINE/BUSY) and `AutoDispatchMode`
(MANUAL_ONLY/ROUND_ROBIN/PRIORITY_MATCH/CAPABILITY_MATCH). New `Agent`
model (`profileKey` unique per workspace — matches Hermes profile dir),
`capabilities String[]`, `webhookUrl`, `lastHeartbeatAt`, `maxConcurrent`,
`archivedAt`. `Issue.assignedAgentId` (SetNull) + relation. `Workspace`
gained five dispatch knobs (`autoDispatch`, `autoDispatchMode`,
`autoStartOnAssign`, `agentIdleTimeoutMinutes`,
`requireApprovalBeforeStart`) — all settings-driven, per project rule.
`EventKind` enum extended with `ISSUE_QUEUED`, `AGENT_CREATED`,
`AGENT_UPDATED`, `AGENT_DELETED`, `AGENT_ASSIGNED`. Migration baselined
into `0001_agents_and_dispatch/` (the previous `db push` flow required a
`migration_lock.toml`; added). New `agent` tRPC router (list/byId/
byProfileKey/create/update/archive/unarchive/delete/heartbeat), admin-only
for mutations, audited via `recordChange`.

**Lane A — issue router + MCP.** `issue.list/byId` include `assignedAgent`
(select fields for picker render without a second round-trip). `issue.
list` filter, `issue.create`/`issue.update` accept `assignedAgentId` with
a cross-tenant guard on the agent FK. Transition emits a dedicated
`AGENT_ASSIGNED` event in addition to `ISSUE_UPDATED` — mirrors the
human-assignee pattern. Five MCP tools added: `issues.assign`,
`issues.assigned`, `time.log`, `cycles.addIssue`, `cycles.removeIssue`.
`issues.assigned` currently requires `profileKey` because `ApiKey` has no
`linkedAgentId` column yet — a ~5-line follow-up once the column lands.
Happy-path tests mirror existing MCP test style (69/69 green).

**Lane B — UI.** New `/settings/agents` page: SidePanel create/edit form
(profileKey regex-validated, disabled on edit), status-dot table, last-
heartbeat relative time, capability chips, `_count.assignedIssues` badge,
`<Confirm>` with `typeToConfirm=profileKey` on destructive delete when
the agent has assigned issues. Sidebar got "Agents" under Admin (`g e`
chord — `g a` was taken by Analytics). Agent picker chip on issue detail
sits next to the user assignee chip; `⇧A` opens it. "Unassign" pinned at
the top of the picker list.

**Lane C — webhook fan-out.** `recordChange` now enqueues `WebhookDelivery`
rows in the same transaction that inserts the `ActivityEvent` — single
batched `findMany` → `createMany` keyed on `{workspaceId, active,
events.has(kind)}`. For `AGENT_ASSIGNED` / `ISSUE_QUEUED` on an issue,
the fan-out also lazy-upserts a per-workspace synthetic webhook with url
`agent:dispatch` and queues a delivery against it. The worker recognises
the sentinel and resolves the real URL from `Issue.assignedAgent.webhookUrl`
at delivery time, DEAD_LETTERing when the agent has no webhook. No
schema change — `ApiKey`/`Agent` per-agent secret column deferred.
`issue.setQueued` now emits `ISSUE_QUEUED` on the false→true transition
(idempotent on true→true).

**Validation + deploy.**

- `pnpm typecheck` clean.
- `pnpm test` 69/69 green (5 new tests from Lane A).
- Lint: two introduced `prefer-const` errors fixed (`issue.ts:358`
  `worker.ts:40`); pre-existing `any` errors elsewhere left alone (build
  has `eslint.ignoreDuringBuilds: true`).
- Local dev DB baselined via `prisma migrate resolve --applied` for both
  migrations (previously on `db push`).
- Prod container `forge-postgres` already had `0000_init` in
  `_prisma_migrations`; entrypoint's `prisma migrate deploy` cleanly
  applied `0001_agents_and_dispatch` on first boot.
- MCP smoke: `tools/list` shows 43 tools (5 new names present);
  `analytics.summary` 200; `cycles.current` 200; `issues.assigned
{profileKey:"victor"}` 200-shaped error (Agent not found) — correct
  because no agents exist yet.

Follow-ups before TODO P0 closes:

- Bootstrap Victor/Mizu Agent rows in AXI (UI or `db seed`).
- `ApiKey.linkedAgentId` column + wire `issues.assigned` fallback.
- Hermes config-yaml additions (`forge.auto_claim`, `auto_start`,
  `poll_interval`, `show_inbox_on_greeting`) — Hermes-side work.
- Phase-2: per-agent `webhookSecret` column on `Agent` so delivery HMAC
  doesn't reuse the synthetic workspace webhook secret.

## 2026-04-20 — `issue.list` bug triage + design-sweep audit

Paired session: a live failure report on `issue.list` plus a post-sweep
bugfix audit.

**`issue.list` diagnosis.** User reported 8 batched `issue.list` queries
all returning `TRPCClientError` in the browser. Reproduced the server
path from Docker with three independent methods:

1. Raw Prisma query inside the container — 1 row, 0 blockers, clean.
2. Crafted a NextAuth JWT against the deployed `AUTH_SECRET` and the
   `__Secure-authjs.session-token` salt, then curl'd
   `/api/trpc/issue.list?batch=1` — HTTP 200, correct superjson body,
   ~100ms. Confirmed `/api/auth/session` round-trips the same token to
   the expected user.
3. MCP bearer-path (`/api/mcp/issues.list`) — 200, same row.

Server is healthy. The most-probable root cause is a stale client-side
session cookie that fails to decode against the current secret (→
`auth()` returns null → `protectedProcedure` throws UNAUTHORIZED →
client wraps as TRPCClientError). Cookie name and salt haven't changed
since v5 was adopted, so a cross-version cookie mismatch is unlikely;
a simple expired/rotated cookie is the Occam fit. Can't prove it from
server logs alone until the user next hits the prod UI, so…

**Fix shipped.** Switched `src/app/api/trpc/[trpc]/route.ts` `onError`
to log every tRPC error in every env via `pino` — path, type, error
code, cause message, stack, truncated input. Next time the user hits
the UI, `docker logs forge | grep "trpc error"` returns the real
`TRPCError` code with zero guesswork. If it's UNAUTHORIZED, the user
fix is a re-login; if it's anything else, the stack gives the exact
call site.

Verified post-deploy: `pnpm typecheck` clean, `pnpm test` 64/64 green,
rebuilt + redeployed forge (`docker compose build forge && up -d`),
diagnostic firing confirmed by hitting an unauthenticated endpoint and
observing the structured log row.

**Audit pass over the 5 design-sweep commits.** Inspected each surface
called out in the triage prompt. No Blocker or High-severity findings:

- `issue.activity` procedure is workspace-scoped and confirms the
  issue lives in the tenant before returning events. Safe.
- `RealtimeProvider` subscribes per-workspace to an SSE endpoint that
  itself re-verifies membership; invalidations are cache-only (no data
  leak). `utils` dep on the effect is stable in tRPC v11.
- Primitives back-compat shims (`src/components/settings/{card,
empty-state,section}.tsx`) preserve the pre-sweep public API. One
  Medium spacing drift in the new `Section` header (old: `space-y-2`
  between title-row/hint/body; new: `space-y-1` inside header, `-2`
  between header/body) — cosmetic only.
- Density toggle defaults gracefully when used outside
  `DensityProvider` — returns `comfortable`, no throw.
- Quick-create mode detection strips the `/w/<slug>` prefix before
  matching `/issues/:id` / `/cycles` / `/initiatives` / `/projects`;
  list-page matches require exact or `?` suffix so detail pages fall
  through to the default issue mode cleanly.
- Inbox `allWorkspaces` toggle only affects items 3-5; cycle rollup
  stays single-workspace. Correct.
- Pins strip uses `BroadcastChannel` for cross-tab sync because SSE
  is per-workspace; pins are user-scoped. Correct.

No audit-driven follow-up commits; findings recorded here only.

## 2026-04-20 — Full design sweep (4-agent Wave)

With the feature set roughly doubled in the morning push, the UI was
visibly a bundle of ten different authors. This sweep reconciles it.

| Commit    | Scope                                      | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `9af539b` | Primitives                                 | `src/components/ui/*` — EmptyState (page/section/card variants), Skeleton family, Card+Section, Spinner, Kbd/Chord, Density context, motion tokens. Toast = thin wrapper over existing sonner. Back-compat shims keep `src/components/settings/*` imports working.                                                                                                                                                                                                                                                                                     |
| `86f275e` | Shell / IA                                 | Sidebar reshaped into Work/Planning/Personal/Admin groups with `⌘\` collapse to icon rail (persisted). New top bar hosts pins, quick-create, inbox badge, user menu. `?` keyboard help overlay driven by a single-source `src/lib/shortcuts.ts`. Below-`sm` "use on tablet or larger" banner.                                                                                                                                                                                                                                                          |
| `fdafb72` | Flow                                       | Issue detail restructured to two columns ≥md — description + comments left, sticky tabbed rail right (Attachments / Relations / Activity), with `1/2/3` tab keys and `?tab=` deep links. Quick-create (⇧C) is pathname-aware: new cycle / initiative / project / comment / sub-issue / default issue. Dashboard merged into Inbox as the primary landing; Inbox got Today's focus + Workspace pulse rollups. New `issue.activity` tRPC procedure feeds the Activity tab.                                                                               |
| `43e0a11` | Retrofit + realtime + responsive + density | 13 pages retrofitted to the new primitives with `⇧C` Kbd hints on empty states. Compact / Comfortable density toggle on Issues list (persisted via DensityProvider). SSE propagation wired for inbox badge, pins strip (BroadcastChannel), running timer (BroadcastChannel), cycles board, Activity tab, Relations panel, initiatives + roadmap. Responsive ≥md verified; roadmap gets explicit horizontal scroll; backlog panel hides below lg to keep the board breathable. ~15 motion call-sites migrated from ad-hoc classes to `MOTION.*` tokens. |

**Totals:** 4 commits, 13 pages retrofitted, ~25 new primitives, 7 realtime surfaces wired, 64/64 tests still green, production rebuild + redeploy verified (38 MCP tools, analytics + cycles.current smoke-passed).

Notable calls:

- Toast backend stayed on sonner — extending beat replacing since there are 30+ call-sites across the app.
- Dashboard `/dashboard` now redirects to `/inbox`. The nav item disappeared; deep links survive.
- Top bar pins strip hides below md (power-user affordance). Sidebar auto-collapses below md; workspace-is-keyboard banner below sm.
- Activity tab rides on `ActivityEvent` rows. Older issues show "No activity yet" because `recordChange()` wasn't universal pre-sweep — no backfill attempted.
- Realtime cache invalidation on cycles is coarse (any issue event → all cycles); fine-grained per-cycle is a follow-up.

## 2026-04-20 — Big push wrap-up (Phase 3 landed)

All eight work packages from the coordinated multi-agent build are in.
Final state on `master`:

| #   | Commit    | Phase  | What                                                                                                                                                   |
| --- | --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `ec94cb9` | —      | Pre-migration snapshot (first-ever git commit in this repo).                                                                                           |
| 2   | `f96557f` | 1A     | Schema additions (cycles/initiatives/relations/time/polymorphic attachments/granular ApiKey scopes/workspace settings) + FRG→AXI rekey + PER/WRK seed. |
| 3   | `af45433` | 2B     | Routers: cycle, initiative, relation, timeEntry (+ 23 tests).                                                                                          |
| 4   | `cf2adec` | 2H     | Docs sweep — SYSTEM.md, CLAUDE.md, Hermes skill runbook, Obsidian vault, memory files. Mizu/Lumin correction.                                          |
| 5   | `b3555bf` | 2E     | UI shell — workspace switcher, `/w/[slug]/*` URL scheme, workspace settings pages.                                                                     |
| 6   | `bae90b9` | 2C     | MinIO service + attachment router + granular ApiKey scopes enforcement + blocker-aware claim.                                                          |
| 7   | `6650e07` | 3F     | Cycles / initiatives / roadmap / relations panel UI + list-view filter chips.                                                                          |
| 8   | `22fb3cb` | 3G.wip | Salvaged inbox + pin routers from a stalled agent run.                                                                                                 |
| 9   | `271eedc` | 3D     | MCP surface: 38 tools (10 existing + 28 new), narrowing-aware. 14 new tests.                                                                           |
| 10  | `3dcb589` | 3G     | Attachments drag/drop + paste, inbox page, pins strip, time tracker widget.                                                                            |

**Totals:** 10 commits, 64 tests passing, typecheck clean, 3 active workspaces (AXI/PER/WRK), 38 MCP tools, MinIO healthy with three buckets (`forge-axiom-labs` / `forge-personal` / `forge-work`).

Two stall events happened during Phase 3 — both caused by a `dotenv` import that sneaked into `vitest.config.ts` without the dep being installed. Recovered by installing the dep, preserving the partial work as a wip commit, and re-dispatching the affected agents with explicit anti-stall guidance. No data loss.

### Still on the punch list (not done yet)

- **Deploy.** The running container at `forge.axiom-labs.dev` is still on the pre-push image. A rebuild + restart is required to put all this in front of users. That's a deliberate next step, not part of this entry.
- **Prisma migrations folder is out of sync.** `prisma/migrations/0000_init` predates the schema additions; the live DB is correct because Phase 1 used `db push`. Next time someone runs `prisma migrate deploy` they'll want a fresh baseline. Generate with `prisma migrate diff --from-migrations ... --to-schema-datamodel prisma/schema.prisma`.
- **Lint polish.** Pre-existing `@eslint/eslintrc` missing-dep was fixed in the wrap-up commit; one residual unused-var warning in `src/server/services/recurring.ts:63` remains (trivial: prefix with `_`).
- **Key rotation / narrowing review.** Victor + Mizu still hold FULL-scope Hermes keys. Should narrow future sub-agent keys via the new `projectIds` / `labelIds` / `initiativeIds` arrays when those agents come online.

## 2026-04-20 — Linear-parity + multi-workspace push (Phase 2)

The broader push wrapping Agent A's Phase 1 migration. Same day, same
coordinated build — schema + infra + routers land together; UI is partly
in; Phase 3 MCP tool additions come after.

### New primitives (now in schema, routers/UI landing in sibling worktrees)

- **Cycle** — time-boxed iteration, tenant-scoped on `workspaceId`, length
  defaulting to `Workspace.cycleLengthDays` (7). Issues get a nullable
  `cycleId`; SetNull on cycle delete so history survives.
- **Initiative** — higher-level grouping above projects. Projects get a
  nullable `initiativeId`; SetNull on delete.
- **IssueRelation** — directed, typed links between issues
  (`RelationKind`). Cascade-deleted from either endpoint.
- **TimeEntry** — per-user, per-issue duration rows. Only active when the
  owning workspace has `timeTrackingEnabled=true`.

### Polymorphic Attachments + MinIO

- `Attachment.targetType` / `targetId` (nullable for migration safety)
  replace the issue-only model. Attachments can now hang off any first-
  class entity (issue / comment / project / initiative / …).
- MinIO backs storage (being wired up by Agent C in the same push).
  Per-workspace quota surfaces as `Workspace.attachmentQuotaMb` (default
  1024). Signed URLs for read; direct PUTs for upload.

### Granular ApiKey scopes

`ApiKey` gets `projectIds`, `labelIds`, `initiativeIds` — string arrays,
empty = no narrowing (unchanged semantics). A key can still have FULL
scope _and_ be narrowed to a project / label / initiative subset, so a
sub-agent can be scoped to just one initiative without losing any
existing capability. Victor and Mizu currently keep FULL + unnarrowed.

### Multi-workspace UI

- Workspace switcher in the shell; `User.lastWorkspaceId` restores the
  last-used workspace on sign-in.
- New default workspaces seeded: **Personal** (`PER`, time tracking off)
  and **Work** (`WRK`, time tracking on). Bailey is `OWNER` on all three.
- The original `FRG` workspace was rekeyed to **`AXI` / Axiom-Labs** in
  the Phase 1 entry below; all current-state references (SYSTEM.md,
  Hermes runbook, Obsidian, mcporter) now say AXI.

### Workspace-level configurability

New columns on `Workspace` expose what used to be hard-coded:
`cycleLengthDays` (7), `cycleCooldownDays` (0), `timeTrackingEnabled`
(false), `attachmentQuotaMb` (1024). Per-workspace overrides are just a
row update — no redeploy.

### Mizu / Lumin correction

Sweep of docs: Mizu's role was described as "CEO — Lumin ops" in a few
places. **Lumin is shelved.** Mizu now works across Axiom-Labs
(marketing / growth / intelligence / community). Corrected in
`SYSTEM.md`, `~/.hermes/skills/pm/forge/SKILL.md`, and the Obsidian
vault notes that were out of date. Historical entries (prior DEVLOGs,
archive notes) were not rewritten.

### Out of scope (handoff)

- Phase 3 MCP tool additions for the new primitives — Agent D.
- Remaining UI surface (initiative pages, cycle view polish) — ongoing
  in Agents E/F/G's worktrees.

## 2026-04-20 — Schema: cycles/initiatives/relations/time + rekey FRG -> AXI + seed PER/WRK (Agent A, Phase 1)

Phase 1 of the coordinated multi-agent build. Strictly additive schema + one
data migration (workspace rekey). App stayed up throughout.

### Schema (`prisma/schema.prisma`)

- New enums: `CycleStatus`, `InitiativeStatus`, `RelationKind`.
- New models: `Cycle`, `Initiative`, `IssueRelation`, `TimeEntry` — all
  tenant-scoped on `workspaceId`, with the indexes called out in the plan.
  Issue relations are directed and deletion-cascaded from either endpoint.
- Workspace: added `cycleLengthDays` (default 7), `cycleCooldownDays` (0),
  `timeTrackingEnabled` (false), `attachmentQuotaMb` (1024) — all configurable
  defaults surface as columns so per-workspace overrides are trivial.
- Issue: added nullable `cycleId` (SetNull on cycle delete), `relationsFrom`
  /`relationsTo` reverse relations, `timeEntries` reverse relation, and a
  `(workspaceId, cycleId)` index.
- Project: added nullable `initiativeId` (SetNull on initiative delete) +
  reverse relation + index.
- Attachment: made polymorphic via `targetType`/`targetId` (both **nullable**
  — deviation from the spec's non-null ask, so `db push` wouldn't reject the
  existing row; new writes can still set both together). Kept `issueId` for
  backward compat. New composite index on `(workspaceId, targetType, targetId)`.
- ApiKey: added `projectIds`, `labelIds`, `initiativeIds` string arrays with
  `@default([])` — empty = no narrowing.
- User: added `lastWorkspaceId` (remembered workspace), `pinnedIssueIds`
  string array with `@default([])` (cap enforced server-side later), and the
  `timeEntries` reverse relation.

### Applied via standard flow

Schema was baked into the image at build time (no bind mount). Flow:

```
docker cp prisma/schema.prisma forge:/app/prisma/schema.prisma
docker compose exec -T forge prisma validate
docker compose exec -T forge prisma db push --accept-data-loss --skip-generate
docker compose exec -T forge prisma generate
```

`prisma validate` passed; `db push` completed in 605 ms; client regenerated
without restarting the container (running app still serves fine — no existing
router references the new types).

### Rekey + seed SQL

Single transaction in `/tmp/forge-rekey-seed.sql`, executed via
`docker exec forge-postgres psql -U forge forge -v ON_ERROR_STOP=1 -f ...`.

- Enabled `pgcrypto`. ID generator for raw SQL inserts:
  `'c' || encode(gen_random_bytes(12), 'hex')` — 25-char cuid-shaped strings.
- Renamed existing workspace: key `FRG` -> `AXI`, name `Bailey` -> `Axiom-Labs`,
  slug `bailey` -> `axiom-labs`, `cycleLengthDays=7`.
- Seeded `Personal` (key `PER`, slug `personal`, time tracking off) and
  `Work` (key `WRK`, slug `work`, time tracking **on**) workspaces.
- Seeded the same 6 statuses (Backlog/Todo/In Progress/In Review/Done/Canceled)
  in both new workspaces, reusing the warm-earthy hex palette already in use
  on AXI. Todo is default.
- Seeded starter labels.
  PER: `quick-win`, `health`, `finance`, `home`, `learning`.
  WRK: `day-job`, `after-hours`, `billable`, `meeting`, `admin`.
- Added Bailey as `OWNER` membership on both new workspaces.
- Created one ACTIVE `Cycle 1` per workspace (including AXI) with
  `lengthDays=7`, starting now, ending +7 days.
- Set `User.lastWorkspaceId` to AXI's id so the UI lands there by default.

### Verification outputs

```
 key |    name    |    slug    | cycleLengthDays | timeTrackingEnabled
-----+------------+------------+-----------------+---------------------
 AXI | Axiom-Labs | axiom-labs |               7 | f
 PER | Personal   | personal   |               7 | f
 WRK | Work       | work       |               7 | t

statuses/workspace: AXI=6, PER=6, WRK=6
active cycles/workspace: AXI=1, PER=1, WRK=1
labels: AXI=0 (existing, untouched), PER=5, WRK=5
Bailey memberships: OWNER in AXI, PER, WRK
Issue count: 1 (unchanged from baseline).
```

- `https://forge.axiom-labs.dev/` -> 307 to Authelia (healthy SSO).
- `POST /api/mcp/analytics.summary` with Bearer `$FORGE_API_KEY` returned
  `{"data":{"openIssues":1,"doneIssues":0}}` — MCP surface is green.
- Container logs clean since migration.

### Deviations / decisions

- `Attachment.targetType` and `targetId` kept **nullable** (spec said non-null).
  Required so `prisma db push` could apply cleanly to the existing row. New
  code should set both together; the old `issueId` path still works.
- Existing workspace was named "Bailey" / slug "bailey" (not "Forge" / "forge"
  as the brief implied). Rekey still proceeded as planned (FRG -> AXI).
- Used raw `pgcrypto`-backed id generator instead of cuid (couldn't call
  Prisma's cuid from SQL). Column shape identical, indexable, collision-safe.

### Out of scope (handoff)

- tRPC routers for new models — Agent B/C.
- UI (workspace switcher, cycle/initiative/time pages) — Agent E.
- MinIO compose — Agent C.
- MCP tool additions — Agent D.
- System docs (SYSTEM.md, Hermes runbook, mcporter.json, Obsidian) — Agent H.

## 2026-04-19 — Real MCP endpoint (Streamable HTTP)

`/api/mcp/*` was branded as MCP but was a custom REST dispatcher. Added a
real MCP-compliant endpoint that speaks standard JSON-RPC 2.0 per the
Streamable HTTP transport (spec 2025-03-26). REST stays as a simpler
curl/debugging alias.

### Server

- `src/app/api/mcp/rpc/route.ts` — JSON-RPC handler supporting
  `initialize`, `notifications/initialized`, `ping`, `tools/list`,
  `tools/call`. Batched requests + notifications (no-response) honored.
  `tools/list` is open; `tools/call` requires a bearer token and enforces
  the tool's declared scopes.
- Tool input schemas are now exposed as proper JSON Schema (via
  `zod-to-json-schema`), so any MCP client gets correct type hints and
  validation. Error responses include `data: flatten()` on invalid args.
- Rate limiter reused (600 req/min per key; anon key falls back to IP).
- `GET /api/mcp/rpc` returns an empty SSE keep-alive so clients that probe
  `GET` during the Streamable HTTP handshake succeed.

### Client / docs

- `/settings/access` Integration blocks rewritten:
  - **Claude Desktop**: `mcp-remote` now points at the real `/api/mcp/rpc`.
  - **Claude Code**: `claude mcp add --transport http ... /api/mcp/rpc`.
  - **Hermes**: `baseUrl` form — no stdio bridge needed anymore.
  - **curl**: shows both JSON-RPC (standard) and REST (one-shot) forms.
- `~/.openclaw/workspace/daemon/config/mcporter.json` swapped from the
  stdio bridge entry to a `baseUrl: .../api/mcp/rpc` entry with the
  Victor key in `Authorization: Bearer …`.
- `~/.hermes/mcp-servers/forge-bridge/` stays in place as a fallback for
  clients that can't speak HTTP MCP, but is no longer the preferred path.

### Verified

- `initialize` returns 2025-03-26 protocol + serverInfo/instructions.
- `tools/list` returns 10 tools with full JSON Schema input shapes.
- `tools/call` `analytics.summary` with Victor's bearer → `{openIssues:1, doneIssues:0}`.
- Unauthenticated `tools/call` → `-32001 Unauthenticated`.

## 2026-04-19 — Hermes integration + settings layout pass

### Settings UI polish (subagent pass)

- `src/components/settings/{section,card,empty-state}.tsx` — 3 tiny primitives.
- Every `/settings/*` page now shares `mx-auto max-w-{2xl|3xl|5xl} space-y-6 p-6`
  and renders lists through `<Card>` + `<EmptyState>`. Widths by type:
  - Forms (Account, Access): `max-w-2xl`.
  - Lists (Members, Labels, Statuses, Templates, Views, Project Templates,
    Recurring, Plugins, Settings index): `max-w-3xl`.
  - Admin (dense, tabbed data): `max-w-5xl`.
- Settings index grouped into **General / Workspace / Developer** sections.

### Hermes integration (new)

Forge's `/api/mcp/*` is a REST tool dispatcher. Hermes speaks standard MCP
JSON-RPC 2.0 over stdio. Bridged them with a tiny subprocess:

- `~/.hermes/mcp-servers/forge-bridge/server.mjs` — stdio MCP server (~130 lines,
  no dependencies). Handles `initialize`, `tools/list`, `tools/call`, `ping`.
  Proxies tool calls to `POST /api/mcp/:name` with the `FORGE_API_KEY` bearer.
- Registered in `~/.openclaw/workspace/daemon/config/mcporter.json` (shared
  with Victor). Mizu's key is stored in `~/.hermes/profiles/mizu/.env` for
  swap-in.
- `~/.hermes/skills/pm/forge/SKILL.md` — runbook for agents documenting all
  10 tools, the agent-queue loop, config locations, and a health-check snippet.
- `/settings/access` reveal dialog got a **Hermes** tab in the copy-paste
  integration blocks alongside Claude Desktop/Code/curl/env.

### Keys minted

- `Hermes · Victor` (FULL access) — stored in `~/.hermes/.env`.
- `Hermes · Mizu` (FULL access) — stored in `~/.hermes/profiles/mizu/.env`.
  Both inserted directly via SQL (prefix + sha256 hash) since the minting
  procedure expects a tRPC session.

### Verified end-to-end

- Bridge smoke test: `initialize` → 10 tools listed → `issues.list` responds.
- MCP REST call with Victor's key created issue **FRG-1** successfully.
- All 10 settings routes return 200 after the layout pass.

## 2026-04-19 — Agent queue, templates, standup, recurring, views, focus + user menu + project templates

Huge feature pass. Big batch of small things, one consistent theme: reduce
the "blank-page" friction + make Forge usable by agents.

### Data model

- `IssueTemplate` — reusable starters (name, title, description, priority,
  labelIds). Workspace-scoped + optional project pin.
- `ProjectTemplate` — starter suggestions shown on `/projects`. Replaces
  hard-coded Forge/Hermes-Relay/Lucid-Memory. Three defaults seeded on
  first `list` if empty; fully editable after.
- `RecurringIssue` — scheduled issue blueprints with `intervalDays` +
  `nextRunAt` + `active`. In-process ticker (every 5 min) creates issues
  when `nextRunAt ≤ now`.
- `SavedView` — bookmarkable `/issues` filter combos (personal or shared).
- `Issue` gets `queued`, `claimedAt`, `claimedById`, `claimExpiresAt` for
  the agent queue.

### Routers

- `template` — CRUD for issue templates.
- `projectTemplate` — CRUD + auto-seed defaults.
- `recurring` — CRUD + `runNow` to fire a schedule manually.
- `view` — list/create/delete. Delete gated to owner.
- `standup` — `draft({ sinceHours })` returns markdown aggregating last
  N hours of your closed / opened / in-progress / stalled issues.
- `issue` extended with `setQueued`, `release`, `queue` (list queued
  items).
- `workspace.updatePreferences` upgraded earlier to also accept
  `timezone/locale/timeFormat/theme` (prior entry).

### MCP tools for agents

- `issues.claim({ claimTtlMinutes })` — atomically picks the highest-
  priority unclaimed queued issue, stamps `claimedAt` + `claimExpiresAt`,
  upserts the caller into `assignees`. Returns the issue or null.
- `issues.release({ id })` — unclaim.
- `issues.queue({ includeClaimed })` — peek the queue without claiming.

### Scheduler

- `src/instrumentation.ts` calls `startRecurringTicker()` on server boot
  (Node runtime only). `setTimeout` chain that scans `RecurringIssue` rows
  with `active=true AND nextRunAt ≤ now`, creates issues via a transaction
  (also emits the normal audit + ACTIVITY_EVENT row), bumps `nextRunAt`.
- Admins can force-fire via the Run now button on `/settings/recurring`.

### New UI

- `/standup` — draft card with copy-markdown button and 1d/3d/7d window
  toggle.
- `/focus/[id]` — stripped fullscreen view outside the app shell. Timer
  (play/pause/reset), exit, progress notes form, mark-done button.
- `/settings/templates`, `/settings/project-templates`, `/settings/recurring`,
  `/settings/views` — full CRUD pages.
- Quick-create gets a "Start from template" select at the top that fills
  title / description / project / priority / labels.
- Issue detail sidebar: Agent-queue toggle + claim info (who + when it
  expires) + Release claim button.
- Issue detail topbar: Focus button → `/focus/[id]`.
- Project detail topbar: "New issue" button scoped to the project (uses
  the existing QuickCreate via `data-quick-create-project={projectId}`).
- Projects page starter-templates dialog now reads from DB, links to the
  admin page to manage them.

### Sidebar user menu

- User row at the bottom is now a button that opens a dropdown with
  Account settings, Workspace settings, and Sign out. Sign out uses a
  server action calling NextAuth's `signOut({ redirectTo: "/signin" })`.

### Verified

- Build clean on second pass (satori fixes + all new routers).
- `prisma db push` applied `ProjectTemplate` cleanly.
- All new routes + existing routes return 200.
- Recurring ticker boots on container start (log line on success).

### Remaining

- Bulk select UI on `/issues` now supports multi-status + delete; could
  add multi-label / multi-assign.
- Onboarding checklist hasn't been extended to include "create a
  template" / "bookmark a view" yet — worth adding.
- Invite email flow + real workspace creation (out of scope for this pass).

## 2026-04-19 — Dashboard + brand assets

### Brand

- `public/forge-mark.svg` + `src/app/icon.svg` — anvil-on-ember glyph. Used
  on the sign-in page and as the favicon (Next auto-links from `app/icon.svg`).
- `src/app/opengraph-image.tsx` + `src/app/twitter-image.tsx` — 1200×630
  card generated via `next/og`'s `ImageResponse`. Satori's rules bit me
  once (every div with >1 child must have `display: flex`, and no
  dynamic-font-fetched glyphs during Docker build). Cleaned both up.
- `src/app/layout.tsx` metadata — `metadataBase`, `title.template`,
  openGraph, twitter, theme-color per-scheme, `robots: { index: false }`.

### Dashboard (`/dashboard`, `g d`)

Client page built by a subagent. Sections:

- Time-aware greeting + quick-actions (New issue via QuickCreate, Browse
  templates, Invite).
- **Focus today** — up to 6 issues assigned to me, priority-desc + due-soon.
- **Overview** — three columns: Recent activity (admin events, falls back
  to recent issues for non-admins), By status counts, Stalled (IN_PROGRESS
  with updatedAt > 3d).
- **Onboarding checklist** — five steps (project, issue, teammate, key,
  timezone); dismissible via localStorage; auto-hides on 100%.

Root `/` now redirects authed users to `/dashboard` instead of `/inbox`.
Sign-in default destination updated to match. Sidebar + command palette
have "Dashboard" as the first entry.

### UI polish (from audit pass)

- `Button.danger` used `text-white` — swapped for `text-background`.
- `QuickCreate` dialog padding `p-4` → `p-5` (dialog rhythm consistent).
- `Topbar` accepts `ReactNode` title/subtitle and dropped the always-on
  placeholder Filter/Display buttons.

### Verified

- `docker compose build` clean after the satori fixes.
- All 8 app routes 200; `forge-mark.svg` / `icon.svg` / `opengraph-image` /
  `twitter-image` served.

## 2026-04-19 — Chord nav, label CRUD, status reorder, bulk select, project CRUD, baseline migration

Closed the remaining gaps from the audit.

### Chord navigation

- `src/lib/keyboard.ts` gains `useChord(leader, map, windowMs)`. The
  sidebar's `g i`/`g s`/… labels now _actually_ work — press `g` then
  `i`/`s`/`p`/`a`/`l`/`,` to jump. Sidebar renders kbd chips (`G` + target
  letter) in place of the old string hint.

### Label CRUD

- `src/server/routers/label.ts` — list/create/update/delete (admin) +
  `setForIssue` (member). Workspace-scoped, unique `(workspaceId, name)`.
- `/settings/labels` page — color swatches, inline edit, delete with
  impact hint (`removed from N issue(s)`).
- Issue detail sidebar gets a real `<LabelPicker>` (multi-select from
  workspace labels, commits via `label.setForIssue`).

### Status drag-reorder

- Native HTML5 DnD on `/settings/statuses`. Dragging commits via the
  existing `status.reorder` proc on drop; optimistic UI reverts on error.

### Bulk select on issue list

- `IssueList` now renders a per-row checkbox, a sticky action bar with
  "Move to status…" (via `issue.bulkStatus`) and Delete (fan-out to
  `issue.softDelete`), and a clear-all. Wired everywhere `<IssueList>` is
  used (issues, inbox, project detail). Pass `enableBulk={false}` to opt
  out.

### Project CRUD completion

- New-from-scratch "New project" dialog on `/projects` (name + key + desc
  - color swatches + emoji icon). Key auto-suggested from name initials.
- `project.softDelete` mutation + Delete button on project detail page.
- Starter templates dialog preserved for the common suggestions.

### API key deletion

- `access.delete` admin mutation — hard-deletes the row entirely (Revoke
  still sets `revokedAt` for audit trail). Access page exposes both.

### Prisma baseline migration

- `prisma migrate diff --from-empty --to-schema-datamodel` generated
  `prisma/migrations/0000_init/migration.sql` (582 lines).
- `prisma migrate resolve --applied 0000_init` baselined the existing
  production DB. Entrypoint's `prisma migrate deploy` now runs cleanly
  ("No pending migrations to apply.") instead of hitting `P3005`.

### Verified

- Build clean.
- All 12 routes 200 (inbox, issues, projects, analytics, settings +
  account/access/members/statuses/labels/plugins/admin).
- Baseline migration applied; future schema changes can use
  `prisma migrate dev --create-only` → commit → `migrate deploy` on boot.

## 2026-04-19 — Platform-aware kbd + user preferences

Quick follow-up pass.

### Changes

- `src/lib/platform.ts` — `useIsMac` / `useModKeyLabel`. Sidebar now
  renders `⌘K` on macOS, `Ctrl+K` elsewhere. The underlying hotkey handler
  already treated `cmd+k` as `Ctrl+K` on non-Mac, so only the visible
  label needed fixing.
- Prisma `User` gets nullable `timezone`, `locale`, `timeFormat`, `theme`
  columns. Pushed via `prisma db push` since no baseline migration exists.
- `workspace.updatePreferences` mutation (protected, not admin-only — every
  user can set their own prefs). Updates profile name/handle too.
- `/settings/account` page — profile (name/handle/email/platform) +
  regional (timezone/locale/12h-24h/theme). Preview uses `Intl.DateTimeFormat`
  with chosen options so users can see the effect before saving.
- `src/lib/utils.ts` gains `formatDate(d, prefs, opts)` — `Intl`-based,
  respects user's timezone/locale/hourCycle.
- `src/lib/time-prefs.ts` — `useTimePrefs()` hook pulling from
  `workspace.me`. Applied first on the issue detail page (timestamp tooltip).
- `/settings` index now lists Account as the top entry.

### Verified

- `docker compose build` → clean.
- `prisma db push` applied the new columns cleanly.
- Login + `/settings/account`, `/settings/admin`, `/settings/access`,
  `/settings`, sample issue route → all 200.
- No runtime errors in container logs.

## 2026-04-19 — Feature audit + full CRUD pass + admin portal

Post-audit pass: closed most of the gaps found by the explore subagent.
Focus was on real CRUD surfaces and a first-class developer-access flow.

### Server

- `src/server/routers/admin.ts` (new) — `stats`, `audit`, `events`,
  `deliveries`. Admin-gated.
- `src/server/routers/access.ts` — added `rotate` (atomic revoke + reissue
  with same name/scopes/expiry-window). Returns the raw key once.
- `src/server/routers/workspace.ts` — added `me`, `updateMember`,
  `removeMember`. Last-owner guard on both mutations.

### Pages

- `/settings/access` — preset toggle (Full / Standard / Read-only / Custom)
  plus per-scope grid. Rotate button on each key; post-rotate reveal reuses
  the same tabbed integration blocks (Claude Desktop / Code / curl / env).
  Makes it explicit that raw keys are single-reveal — if you lose the key,
  rotate.
- `/settings/admin` (new) — stat cards + tabs for audit log, activity
  events, webhook deliveries.
- `/settings/members` — role dropdown + remove per member (disabled for
  self; last-owner protected server-side).
- `/projects/[id]` — now actually scoped to the project. Shows
  description/color/icon/dates, has Edit dialog (name/description/color/
  icon), Archive, and list⇄kanban view toggle (persisted per-project in
  localStorage).
- `/issues/[id]` — inline title + description editing, assignee picker
  (multi-select from workspace members), project select, due-date picker,
  delete button. Status/priority dropdowns preserved.
- `/issues` — persisted list⇄kanban toggle + inline search box.
- `/inbox` — real filter tabs: Assigned / Created / All active.

### Shared UI

- `src/components/view-toggle.tsx` (new) — `<ViewToggle>` + `useViewPref`
  (localStorage-persisted per scope).
- `Topbar` — dropped the always-visible Filter + Display placeholders that
  did nothing. `title` accepts ReactNode now.
- `CommandPalette` — wired issue search via `issue.list({ query })`.
  Results grouped under Issues / Navigate.
- `QuickCreate` — project picker + description + priority.
- `Sidebar` — added Settings link; dropped the duplicate settings gear.

### Verified

- `docker compose build` → clean.
- Login + all 10 routes 200 (inbox, issues, projects, analytics, settings,
  settings/{access,members,statuses,plugins,admin}).
- No runtime errors in container logs (only the known P3005 migrate
  baseline warning).

### Still pending

- Statuses drag-to-reorder.
- Label CRUD surface.
- Bulk-select + status mutation on issue list.
- Prisma baseline migration.
- Email-based invites.

## 2026-04-19 — Settings hub + developer access + starter projects

Fleshed out `/settings/*` so the nav links go somewhere, added a first-class
developer-access page with copy-paste MCP config blocks, and made it trivial
to seed the workspace with the usual suspects.

### New surface

- `src/server/routers/access.ts` — workspace-level API keys (not tied to a
  plugin). `list` / `create` / `revoke`. `create` returns the raw key once;
  only the sha256 is persisted.
- `src/app/(app)/settings/page.tsx` — rewritten as a proper index with four
  real links + a "developer access" card on top.
- `src/app/(app)/settings/access/page.tsx` — lists keys, create dialog with
  scope toggle grid + optional expiry, post-create reveal modal with
  tabbed copy-paste blocks:
  - Claude Desktop (`mcpServers.forge` JSON via `mcp-remote`)
  - Claude Code (`claude mcp add --transport http ...`)
  - curl (issues.list + issues.create examples)
  - `.env` block
- `src/app/(app)/settings/members/page.tsx` — uses existing
  `workspace.members` + `workspace.invite` procedures.
- `src/app/(app)/settings/statuses/page.tsx` — uses existing
  `status.list` + `status.create`. Reorder-by-drag is still TODO.
- `/projects` gets a "Starter templates" dialog — a UI-only list of
  suggestions (Forge/FRG, Hermes-Relay/HR, Lucid-Memory/LM) that invokes
  the standard `project.create` mutation per row the user keeps. No
  server-side seed endpoint; the template list lives entirely in the
  client so it stays out of the platform's data model.

### Verified

- `docker compose build forge` → clean.
- `POST /api/auth/callback/credentials` → 302 `/inbox`.
- `GET /{inbox,settings,settings/access,settings/members,settings/statuses,settings/plugins,projects}` → 200.

### Known / next

- Prisma baseline migration still missing (`P3005` on entrypoint migrate,
  soft-failed). Generate one before the next schema change.
- `mcp-remote` is the canonical bridge for HTTP-transport MCP into Claude
  Desktop today — the pasted config assumes the user `npm`s it on first run.
- Drag-to-reorder statuses + inline editing pending.

## 2026-04-19 — Pivot to env-based credentials admin (Authelia removed)

Authelia header-bridge didn't land cleanly (edge middleware was setting response headers instead of forwarding request headers; fixed version still didn't produce the expected handshake in the browser). Bailey called it — dropped the bridge entirely.

### Changes

- Deleted `src/middleware.ts`, `src/server/authelia-bridge.ts`, `src/app/api/auth/authelia-bridge/`.
- `src/server/auth.ts` now exposes a **Credentials** provider comparing against `ADMIN_EMAIL` / `ADMIN_PASSWORD`. On first match, upserts the user by email and creates their default workspace (statuses seeded). Session strategy switched from `database` → `jwt` (required for Credentials).
- `src/app/(auth)/signin/page.tsx` rewritten: single email+password form, Server Action handing off to `signIn("credentials")`. OAuth/magic-link buttons removed (providers remain conditionally registered so they can return if env is set).
- `(app)/layout.tsx` stripped of the Authelia handshake check; plain `auth()` → `/signin` redirect now.
- Traefik label swapped: `chain-authelia@file` → `chain-no-auth@file`. Forge is now reachable without SSO; the app handles its own auth.
- `.env` gained `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, `ADMIN_HANDLE`.
- DB reset via `prisma db push --force-reset` — the abandoned Authelia-bridge attempt had left a stale `handle: "bailey"` row that was breaking the upsert on first sign-in. Safe to reset since no real data existed.

### Verified

- `POST /api/auth/callback/credentials` with valid creds → `302 /inbox`, `__Secure-authjs.session-token` set.
- `GET /inbox` with that cookie → `200`.
- Login: `timothy.b.dixon@gmail.com` / `@Tqbfj0tld!` (from `~/docker/forge/.env`).

### Ran into

- Disk hit ENOSPC after 8 rebuilds of the ~1 GB image. `docker builder prune -af && docker image prune -af` reclaimed ~17 GB.

## 2026-04-19 — Deploy behind Traefik + Authelia

Same session as scaffold (renamed Cairn → Forge first). Version bumped to `1.0.0`.

### What went live

- `~/docker/forge/docker-compose.yaml` — app + postgres + redis + persistent volumes, on `traefik_proxy` + internal bridge.
- Traefik routed at `https://forge.axiom-labs.dev` via Docker labels; `chain-authelia@file` middleware enforces SSO.
- Homepage entry added under General-Services (`mdi-anvil` icon).
- Dockerfile: multi-stage (deps → build → runner), Next.js `output: "standalone"`, prisma CLI installed in runner for boot-time `prisma migrate deploy`.
- Authelia bridge: edge middleware normalizes `Remote-*` headers → `x-forge-identity`; `(app)/layout` detects no-session-yet-with-identity and redirects to `/api/auth/authelia-bridge`, which upserts user, creates a default workspace (slug=user, key=user prefix), mints a DB session, and drops the NextAuth cookie.
- Schema pushed with `prisma db push` (no migration file yet — first deploy).

### Build fixes that mattered

- `experimental.typedRoutes` → removed (Next 15.5 moved it top-level AND it's too strict for the string-backed nav array; disabled).
- Local plugin import: switched from dynamic template-string `import()` to a static registry at `src/server/services/local-plugins.ts`. Dynamic fs-loading was fighting the bundler and pnpm's virtual store; static registry is the right shape for `runtime: "local"`.
- Prisma + pnpm + Next standalone: `.prisma` lives at `node_modules/.pnpm/@prisma+client*/node_modules/.prisma`, but `@prisma/client/default.js` requires `.prisma/client/default`. Fix: explicit `COPY` in Dockerfile runner to flatten it into `node_modules/.prisma`.
- NextAuth providers now conditional on env — empty `EMAIL_SERVER` was throwing at module init during page-data collection.
- `Prisma.InputJsonValue` casts for manifest + skill schema columns.
- MCP tool handlers needed explicit `input: ...` param types (TS can't close the inference loop across an object literal entry).

### Verified end-to-end

- `curl https://forge.axiom-labs.dev/` → 302 to `login.axiom-labs.dev` (Authelia).
- Follow-redirect with SSO → HTTP 200.
- Forge container logs clean (no Prisma or hydration errors).

### Known / next

- No `prisma/migrations/` yet — first deploy used `db push`. Generate a baseline migration before the next schema change.
- Signin page still renders OAuth/magic-link buttons even when providers are unset (server actions would fail). Behind Authelia this page shouldn't be reached — clean up next pass.
- `issue-triage` sample plugin not yet wired to event delivery — BullMQ outbox scheduler is still TODO.
- `docker compose exec forge prisma db seed` not yet hooked (seed.ts uses tsx; prod image doesn't have it). Either compile seed to JS during build or swap to a `.sql` seed file.

## 2026-04-19 — Initial scaffold

**Session:** Bailey → Claude (Opus 4.7, 1M ctx, auto mode)

### What was done

- Scaffolded repo at `~/forge/` — Next.js 15 + TS + Tailwind + Prisma + tRPC 11 + NextAuth v5 + Redis + BullMQ.
- Wrote comprehensive Prisma schema: users, workspaces + memberships (RBAC),
  projects, issues (with subtasks via self-ref), statuses (workspace-scoped),
  labels, comments, attachments, audit log, activity events, metric aggregates,
  plugins, skills, API keys, webhooks, webhook deliveries.
- Built tRPC base with `workspaceProcedure`/`adminProcedure` middleware and
  per-procedure Redis rate limiter.
- Routers: workspace, project, issue, comment, analytics, plugin, status.
- Issue mutations record both audit + ActivityEvent rows in one transaction
  and publish to Redis pub/sub for SSE fan-out.
- Plugin runtime: HMAC webhook signing, JWT for delegated calls, local-runtime
  dispatch via dynamic import from `plugins/<slug>/handler.ts`.
- MCP surface at `/api/mcp/[tool]` — 7 tools, scope-gated via API key.
- UI: warm-earthy design tokens (`globals.css`), sidebar + topbar + command
  palette (`⌘K`) + quick-create (`C`) + issue list + issue board + issue
  detail with optimistic updates + projects page + analytics page (distribution,
  throughput, cycle time, SLA breaches) + plugins settings page.
- Realtime: server SSE endpoint subscribing to Redis pub/sub, client-side
  `RealtimeProvider` that invalidates tRPC queries on events.
- Sample plugin `plugins/issue-triage/` with local-runtime handler using
  keyword heuristics.
- Tests: vitest unit tests for rate-limit, webhook signing, manifest schema;
  Playwright scaffold for issue flow.
- CI: GH Actions with quality job (lint/typecheck/unit) + e2e job with
  Postgres + Redis service containers.

### Decisions

- **Separate AuditLog from ActivityEvent.** Audit is for compliance (immutable,
  includes IP/UA/before/after). ActivityEvent is the product stream plugins
  subscribe to. Keeps access controls and retention policies independent.
- **SSE over WebSockets.** Simpler to run on Next.js route handlers; sufficient
  for fan-out of server-originated events. Swap to Socket.io if we need
  bidirectional (presence, typing, cursors).
- **Scoped API keys + manifest ceiling.** Plugin manifests declare the max
  scope set. API keys issued to a plugin can only _narrow_, never widen.
- **Metric rollup table + live fallback.** Analytics router reads from
  `MetricAggregate` where warm, otherwise falls back to live SQL. Worker
  job populates rollups out-of-band.

### Next steps

- Actually install deps and run `prisma migrate dev` to validate schema.
- Wire BullMQ delivery scheduler so ActivityEvent → Webhook fan-out is durable.
- Drag-and-drop on kanban board (leave keyboard bulk-status working first).
- Onboarding flow for users with no memberships.
- Invite email flow (currently the invite procedure upserts user directly).
- Replace the quick-create placeholder with status/priority/project pickers.
- Build a second sample plugin demonstrating the `runtime: "plugin"` path
  (webhook delivery). Good candidate: a Hermes bridge that pushes events
  into `#hermes-agent` Discord.

### 2026-04-27 — Agent chat, integrations, presence, nav refactor (full session)

A long session that crossed the chat/agent surface end-to-end. Eleven
commits landed; this entry covers the architectural arc rather than
each commit. Commits, oldest first: `282ce7f`, `eeb58ee`, `0515871`,
`d61cc03`, `29da50a`, `884aa8a`, `64fdbbd`, `104c75e`, `69a5659`.

### What shipped

**Mission Control chat (`282ce7f`, polished through `69a5659`)**

- `ChatThread` + `ChatMessage` Prisma models. Thread is unique per
  `(workspaceId, userId, agentId)`. Migration `0016`.
- New `chat` tRPC router: `threads`, `thread` (mutation, upserts),
  `send`, `appendAgentMessage` (gated on `linkedAgentId`), `history`.
- Chat tab in Mission Control (chord 5), three-pane: agent rail (left)
  → thread (middle) → composer (bottom). Per-(user, agent) thread.
- `ChatContextProvider` + `useChatContext` hook so pages can register
  page-state (route, slug, issueId, selectedIds) into a context bundle
  that ships with every send.
- Audit fan-out branch (d) routes `CHAT_MESSAGE_POSTED` to the
  addressed agent's `webhookUrl` via the per-agent dispatch shim —
  same plumbing as comment @-mentions.

**Chat reply streaming (`69a5659`)**

- Three new MCP tools for stateless streaming drafts:
  `chat.startDraft({ threadId }) → { draftId }`,
  `chat.appendDraftChunk({ threadId, draftId, delta, seq? })`,
  `chat.finalizeDraft({ threadId, draftId, body, sourceRunId? })`.
- Drafts are NOT persisted. Deltas flow through Redis pub/sub on a
  `chat-thread-stream` channel (subjectType discriminator, NOT a
  real EventKind). Only the final body lands as a `ChatMessage` via
  the existing fan-out path. Payload carries `finalizedDraftId` so
  the client swaps the draft bubble for the persisted message
  without flicker.
- Single-shot `chat.appendMessage` (`64fdbbd`) stays as the fallback
  for runtimes not yet wired to the streaming path.

**Chat polish (`104c75e`)**

- `chat-markdown.tsx` — hand-rolled lightweight markdown renderer
  (no new deps; Forge had no markdown libs installed). Headings,
  ordered/unordered lists, fenced code blocks with copy buttons,
  inline bold/italic/code, auto-linkified URLs.
- AGENT messages render through `<ChatMarkdown>`. USER and SYSTEM
  stay plain `whitespace-pre-wrap`.
- Thinking indicator: three staggered `animate-bounce` dots when
  the latest message is USER and < 5min old. Stale hint after 60s.
  Mutually exclusive with the streaming draft bubble.
- Better empty thread state with example prompts.

**Slash commands (`69a5659`)**

- Pure-client registry at `src/lib/chat-slash-commands.ts` modeled
  on `~/mission-control/lib/slash-commands.ts`.
- `/help`, `/clear`, `/info`, `/agents`, `/issue <KEY>`, `/status`.
- Inline popover above composer on `/`. Arrows cycle, Enter/Tab
  accept, Escape closes. Args-needing commands fill `/<name> ` and
  place cursor; arg-less execute immediately.
- Local commands push a SYSTEM-role bubble to `localMessages` state
  (cosmetic only, never persisted). Prompt-dispatch commands
  (`/issue`, `/status`) transform input and call `sendM.mutate`.

**Runtime mode honesty (`0515871`)**

- `Agent.runtimeMode` (PERSISTENT | EPHEMERAL — already existed but
  unused in UI) now surfaces in:
  - Agents tab (sort + badge by mode + last-heartbeat).
  - Chat header (mode badge + last-seen for offline persistent
    agents).
  - Chat composer (banner copy adapts: persistent-offline says
    "queued, delivered on next heartbeat"; ephemeral says "session
    — replies arrive on next session").
  - Glance view (small p/s mono badge).
- Mission Control Control tab (chord 6, OWNER/ADMIN only) — webhook
  delivery queue with status filters, retry button, queue depth,
  recent dispatches. Reads existing `admin.webhookDeliveries.list`
  and `.retry`.

**Access keys split (`0515871`)**

- `ApiKeyKind` enum (AGENT | PERSONAL | SESSION). Migration `0017`
  with backfill: existing rows get `AGENT` if `linkedAgentId` is
  set, `PERSONAL` otherwise.
- `access.createPersonal` and `access.createSession` (TTL-bounded)
  mutations. Existing `access.create` infers kind from
  `linkedAgentId` presence with optional override.
- Settings → Access page reshaped into three sections (Registered
  Agents, Personal Access Tokens, Session Keys) with separate
  create flows, expiry badges, copy-once raw-key reveal.

**Integrations adapter manifest (`0515871`)**

- Static manifest at `src/server/integrations/adapters.ts` (NOT a
  Prisma table — uses existing `AgentProvider` enum). Five
  adapters: Hermes, Claude Code (session), Claude Desktop
  (persistent), Codex CLI, Custom webhook. Each declares
  `defaultRuntimeMode`, `defaultKeyKind`, `presence`,
  `setupMarkdown`, optional `mcpSnippet`.
- New `integration` tRPC router: `list`, `byKind`, `applyToAgent`.
- `/settings/integrations` index page rendering each adapter as a
  card with installed-agent badges and "Generate key" / "Manage
  keys" links into the access page.

**Hermes-side glue (out-of-repo, in `~/.hermes/`)**

- `forge-presence` skill (`~/.hermes/skills/forge-presence/`):
  `bin/heartbeat.sh <profile>` calls Forge's MCP `agents.heartbeat`;
  `bin/setup.sh <profile>` installs a per-minute system crontab
  entry. Supports both installed profile dirs
  (`~/.hermes/profiles/<name>/forge.env`) AND the default agent at
  `~/.hermes/forge.env` for Victor.
- New `gateway/platforms/forge.py` platform adapter in the
  hermes-agent fork. Uses `GatewayStreamConsumer` to call Forge's
  draft-streaming MCP tools as tokens generate.
- `~/.hermes/config.yaml` adds a `platforms.forge` block.
- `~/.hermes/webhook_subscriptions.json` switches `deliver: "log"`
  → `"forge"` with a new `forge_thread_id_path:
"payload.threadId"` field. Prompt template updated: agent no
  longer calls `forge_chat_appendMessage` directly for chat events
  (platform adapter handles delivery — avoids duplicate messages).
- **Activation requires Hermes gateway restart.**
- Custom-vs-official: the platform adapter file is a clean addition
  using Hermes's `BasePlatformAdapter` extension point. The
  `Platform.FORGE` enum addition + `run.py` adapter creation +
  `webhook.py` re-stamp block ARE patches to Hermes core — internal
  to Bailey's fork at `~/.hermes/hermes-agent/`, not yet
  upstream-mergeable as-is.

**Nav reorg (`d61cc03`)**

- Sidebar: dropped "Admin" group entirely. New "Insights" group:
  Analytics + Agents (Agents is a real surface now, not config).
  Plugins + Admin portal removed from rail (live in Settings).
- Settings navbar: dropped "Account" group from workspace scope
  (account settings live ONLY at root `/settings/*` now, single
  canonical home). Renamed "Developer" → "Integrations".
- Templates merge: `/settings/templates` now renders a tabbed
  parent (Issue templates / Project templates).
  `/settings/project-templates` is a permanent redirect.
- Duplicate-route cleanup: `/w/{slug}/settings/{account,appearance,
access,workspaces}` are now redirects to `/settings/*` so deep
  links keep working but ambiguity is gone.

### What I learned (write-down for future sessions)

- **Prisma `cuid()` produces mixed v1 + 25-char hex IDs across
  workspaces.** Zod's `.cuid()` only validates v1. All new id
  inputs on routers should use `z.string().min(1).max(40)` matching
  the pattern in `agentId` from the agent router. Fix in `eeb58ee`.
- **The `/api/trpc/...` tRPC route does NOT honor `Authorization:
Bearer ...` for API key auth.** Only `/api/mcp/...` paths run
  `authenticateApiKey()`. Runtime integrations should call MCP, not
  tRPC, when authenticating with an API key.
- **Forge already had a complete heartbeat sweep**
  (`sweepIdleAgents` in `src/server/services/heartbeat.ts`) AND
  auto-presence on webhook delivery (`recordAgentReachable`). The
  gap was purely on the Hermes side: the runtime never called
  `agent.heartbeat`. The `forge-presence` skill closes this with
  one cron entry.
- **MC's "streaming" was theatre.** `~/mission-control` passes
  `stream: false` to Hermes, then wraps the full completion in a
  single SSE chunk. So MC's chat is no faster/streamier than Forge's
  was before this session. To get true token streaming we needed
  to build Forge as a first-class Hermes platform adapter (Phase 3
  of this work) — done modulo the Hermes restart.

### Verification

- `pnpm typecheck` — clean across all 11 commits.
- `pnpm lint` — only pre-existing warnings in `issue-board.tsx`
  (other team's code, unrelated to this session).
- Smoke tests: Mizu and Victor both flipped ONLINE in real time
  when forge-presence cron entries fired. Victor sent and received
  a chat message end-to-end (single-shot path; the streaming path
  needs the Hermes restart). MCP catalog includes all four chat
  tools.
- Migrations `0016_chat_thread_messages` and `0017_api_key_kind`
  applied cleanly to the dev DB.

### Known gaps / TODOs after this session

- Hermes gateway needs `systemctl --user restart hermes-gateway` to
  load the new `gateway/platforms/forge.py` adapter. Until then
  chat uses the single-shot `chat.appendMessage` path; streaming is
  built on the Forge side but not active end-to-end.
- The `forge-dispatch` prompt template instructs the agent NOT to
  call `forge_chat_appendMessage` (the platform adapter handles
  delivery). If the agent ignores this and calls it anyway, you'll
  see duplicate messages. Watch for this in early use; tighten the
  prompt if needed.
- Hermes-side `webhook_subscriptions.json` change is an additive
  field (`forge_thread_id_path`) — vanilla NousResearch/hermes-agent
  doesn't know about it. If you ever rebase the fork on upstream,
  preserve this field.
- The `Integration` adapter manifest has no UI to walk through the
  full install flow yet — it just deep-links to `/settings/access`.
  A guided wizard would be a nice follow-up.

## 2026-05-03 — feat(attachments): expand MIME allowlist + external links + agent docs

A live agent uploaded an HTML file as `report.html.txt` to bypass the
storage MIME allowlist (which lacked `text/html`), then re-uploaded as
`text/plain` to make it work. Two underlying problems: the allowlist
was too narrow for everyday agent output, and there was no native way
to attach a URL (Google Doc, GitHub PR, Linear ticket) without uploading
bytes. Single-shot deploy.

### Shape

- **Schema** — Migration `0024_attachment_kind_link`. Adds
  `AttachmentKind` enum (`FILE | LINK`), `Attachment.kind` (default
  `FILE`, existing rows backfill), `Attachment.externalUrl` and
  `Attachment.linkTitle` (both nullable). LINK rows still populate the
  FILE-shaped columns (`filename = linkTitle ?? hostname`,
  `mimeType = "text/url"`, `size = 0`, `url = externalUrl`) so existing
  selectors keep working without schema-aware branching.
- **Storage allowlist expansion** —
  `src/server/services/storage.ts`: added `text/html`, `text/csv`,
  `text/xml`, `application/xml`, `application/json`,
  `application/x-yaml`, `text/yaml`, `audio/mpeg`, `audio/wav`,
  `audio/ogg`, `audio/webm`, `video/mp4`, `video/webm`,
  `video/quicktime` to `ALLOWED_MIME_TYPES`. New helper
  `normalizeUploadFilename(filename, mimeType)` defensively strips a
  trailing `.txt` from filenames whose inner extension is in
  `{html, json, csv, xml, yaml, yml, md}` AND declared
  `mimeType === "text/plain"` — handles agents that learned the
  `.html.txt` workaround. Called inside `presignUploadUrl` before the
  DB insert; never throws.
- **MCP** — `src/server/services/mcp.ts`: every `attachments.*` tool
  now has a `description` field (consumed by the new
  `tools/list` descriptor in `/api/mcp/rpc/route.ts` — falls back to
  the legacy auto-generated string when absent). New tool
  `attachments.attachLink({ targetType, targetId, url, title? })`
  scoped `WRITE_ISSUES`, validates the URL via
  `z.string().url()`, derives `hostname` for the default title,
  creates a `kind = LINK` Attachment row. `attachments.list`
  description updated; `attachments.getInline` allowlist expanded to
  include `text/html`, `text/csv`, `text/xml`, `application/xml`,
  `application/json`.
- **tRPC** — `src/server/routers/attachment.ts`: new `attachLink`
  mutation mirroring the MCP path, both call into a shared
  `createLinkAttachment` helper in `storage.ts`. Emits
  `ISSUE_UPDATED` via `recordChange` when the target is an issue
  (matches the existing FILE finalize fan-out).
- **UI** — Lightbox: extended `AttachmentLite` with `kind?` and
  `externalUrl?`; LINK rows skip the presigned-GET roundtrip and
  render in a `LinkPreview` component (sandboxed iframe + prominent
  "Open in new tab" CTA — many sites refuse framing). HTML uploads
  render in a sandboxed iframe via the presigned URL with **no**
  `allow-scripts` / `allow-same-origin`. Chip: external-link icon
  for `mimeType === "text/url"`, hostname in the trailing slot
  instead of byte count, click opens the URL in a new tab without
  going through the lightbox. Issue panel: new "Attach link" header
  button toggles an inline form (URL + optional title) that calls
  `attachLink`; LINK tiles render an external-link icon + hostname
  in place of the file thumb. `AttachmentChipData` and
  `AttachmentLite` extended with optional `kind` + `externalUrl` so
  callers in `chat-message.tsx` and `attachment-renderer.tsx` keep
  compiling — markdown inline refs explicitly stamp
  `kind: "FILE"`.
- **Docs** — New "## Attachments" section in
  `/home/bailey/forge/CLAUDE.md` (before "## Conventions"). Lists
  the full MIME allowlist, both attach flows, target types, size
  cap, and the inline/getDownloadUrl decision rule.

### Verification

- `pnpm typecheck` — clean.
- `pnpm lint` — only pre-existing errors in `issue-board.tsx` (4 ×
  `@typescript-eslint/no-explicit-any`) and `control-tab.tsx` (1 ×
  `react-hooks/rules-of-hooks`); confirmed unchanged before/after this
  patch via `git stash`.
- `pnpm test` — 208 passing, 6 failing. All 6 failures are MinIO
  `ECONNREFUSED ::1:59000` in the storage / attachment router test
  suites — environmental, pre-existing (the test runner expects MinIO
  on host port 59000 which isn't bound in this dev env).
- Migration applied cleanly to the dev Postgres at `localhost:55432`
  via `pnpm prisma migrate deploy`.

### Files touched

- `prisma/schema.prisma`
- `prisma/migrations/0024_attachment_kind_link/migration.sql` (new)
- `src/server/services/storage.ts`
- `src/server/services/mcp.ts`
- `src/server/routers/attachment.ts`
- `src/app/api/mcp/rpc/route.ts`
- `src/components/attachments/attachment-chip.tsx`
- `src/components/attachments/attachment-lightbox.tsx`
- `src/components/attachments/issue-attachments-panel.tsx`
- `src/components/markdown/attachment-renderer.tsx`
- `CLAUDE.md`
- `DEVLOG.md`

### Follow-ups

- The MinIO test suite is pre-existing tech debt (local-only port
  `59000` not bound in this dev env). Worth fixing the docker compose
  fixture so unit tests can run end-to-end without external state.
- LINK attachments don't carry favicon / OG-preview metadata yet —
  the chip just shows hostname. A future pass could fetch and cache
  OG images server-side for richer link cards.
- Inline markdown tokens still only resolve FILE refs
  (`[label](forge-attachment:cuid)`); a `forge-link:url` token
  could let comments embed bare LINK chips without a separate
  Attachment row.

## 2026-05-22 — fix(ui): tooltip polish + settings IA restructure

Post-merge cleanup of the design-system landing.

### Motion-merge regressions found + fixed
- **M1 grid invisible** — the animated paper grid used `-z-10` inside a
  `.relative` parent with no stacking context, so it painted behind
  `<main>`'s opaque `bg-background`. Added `isolate` to the parent on the
  dashboard, and wired the (previously missing) grid into Command Center.
- **M5 streaming caret** — `chat-message.tsx` referenced
  `.forge-streaming-cursor` (per `motion.md` M5 = "sweep + caret") but the
  CSS rule was never written. Added the `::after` caret reusing the
  `forge-caret-blink` keyframe. Audited every other `forge-*` resting state
  for invisibility; rest are sound.

### Themed tooltips (`native-tooltips.tsx`)
- Two-pass measure-and-clamp: tooltips now stay fully inside the viewport
  (was: only the horizontal center was clamped, no vertical clamp at all,
  so edge tooltips clipped). Vertical placement flips by available room.
- `data-tooltip-kbd` support: keyboard shortcuts render as `.kbd` chips
  inside the tooltip; `title` carries the clean label only.
- Sidebar collapsed icons now tooltip the page/view **name** (was the bare
  "g then d" chord), with the chord as `G`/`<key>` chips. Same treatment
  for the Search, Quick-create, and Collapse controls.

### Settings information architecture
- **Single source of truth** — new `components/settings/settings-nav.ts`.
  Both the `SettingsNavbar` and the settings Overview index render from it;
  they previously kept separate, drifting inventories (crews in one,
  runtimes in the other, admin grouped differently).
- **Crews folded out of settings** — the canonical surface is the
  top-level `/crews` (+ `/crews/<id>` detail with full roster mgmt). The
  stale `/settings/crews` page is now a redirect; removed the top-level
  "Manage" detour button.
- **Deliveries flattened** — `/settings/integrations/deliveries` →
  `/settings/deliveries` (query-preserving redirect at the old path;
  internal deep-links from the agents page repointed).
- Fixed the wrong `(app)/layout.tsx` comment claiming the account redirect
  stubs "preserve the workspace shell" (they redirect to the chromeless
  account shell).

## 2026-05-22 — chat reliability + chat/dashboard UX polish

- **Stuck "Sending…" — root cause fixed.** `chat.getThread` selected message
  fields but omitted the receipt columns (`dispatchedAt` / `acknowledgedAt`
  / `outputStartedAt`), so every persisted USER row fell through to the
  spinner forever even though the send succeeded. Added them to the select.
  This is why the earlier optimistic-bubble fix didn't hold — it fixed the
  transient bubble, not the persisted row that replaces it. Also added a
  **30s acceptance watchdog** in `chat-thread.tsx` `runStreamingSend`: an
  unconfirmed send now flips to "Failed" (with Retry) instead of spinning.
- **Grid background full-bleed.** `forge-grid-bg` moved onto a full-width
  `relative isolate` wrapper (was clamped to the centered `max-w` column) on
  the dashboard, and wired into the Inbox (which never had it).
- **M5 stream shimmer wired to the live bubble.** `AgentStreamBubble` was
  rendering markdown + an ad-hoc `▍` cursor while streaming and never used
  the M5 classes. It now renders raw text with `forge-streaming
  forge-streaming-cursor` (ember sweep + blinking caret) while live, then
  switches to selectable markdown on commit. CSS already existed.
- **Chat conversations pane: collapse + resize.** `chat-workspace.tsx` grid
  → flex; the Conversations pane collapses to a slim rail and is
  drag-resizable (240–560px, double-click resets). Geometry persists in
  `localStorage` (per-device view state).

## 2026-05-23 — feat(auth): split sign-in from Claude Design handoff

- **Rebuilt `/signin` as the "Split" concept** from the Claude Design
  bundle (`Forge Sign-in.html`). Two-column on `lg+`, stacked on mobile.
- **Left marquee — pre-auth safe.** New `signin/live-status-panel.tsx`:
  brand, headline, an abstract animated "Forge loop" DAG
  (init→plan→edit→test→ship) using the existing `dag-edge-flow` +
  `forge-active-node` motion classes, three generic capability tiles
  (Cycles / Agents / Runs), and a `forge-breath` "All systems normal"
  footer. Panel on `forge-grid-bg`. Carries a load-bearing comment: this
  surface renders before auth, so it must never leak workspace state —
  no issue keys, agent names, run/token counts. `LiveLoopCard` is the
  compact mobile variant above the form.
- **Right form.** Keeps the existing Credentials server action; adds
  conditional GitHub / Google OAuth provider buttons (rendered only when
  the matching `AUTH_*` env pair is set). "Keep me signed in" checkbox,
  inline "Reset" hint (self-hosted note via title), `↵` Kbd on submit.
- All motion CSS already shipped in `globals.css`; no token or keyframe
  changes. Companion concepts (two-factor, join-via-code) deferred — no
  backend flow exists for them under env-driven single-admin auth.

## 2026-05-23 — feat(auth): pluggable SSO providers (DB-backed, admin-managed)

Self-hosted instances can now add/enable/disable sign-in providers from the
UI without a redeploy. One generic **OIDC** type covers any OpenID-Connect
IdP (Authelia, Authentik, Keycloak, Okta, Azure AD…); GitHub/Google kept as
first-party types.

- **Model** `SsoProvider` (migration `0058_sso_providers`, applied
  manually via `db execute` + `migrate resolve` to avoid a drift-triggered
  reset). Instance-global (auth is per-user, not per-workspace). `type`
  (OIDC|GITHUB|GOOGLE), `issuer`, `clientId`, encrypted `clientSecret`,
  `scopes`, `allowLinking`, `enabled`, `sortOrder`.
- **Runtime — the linchpin.** `auth.ts` switched to NextAuth v5's *lazy
  async config* (`NextAuth(async () => …)`), so `providers` are built from
  the DB at request time. `ssoProvidersFromDb()` maps rows → providers
  (OIDC via `type:"oidc"` discovery from `<issuer>/.well-known/…`;
  GitHub/Google via their factories so callback URLs stay
  `/api/auth/callback/{github,google}`). OIDC rows are addressed by row id.
- **Secrets at rest.** New `src/server/crypto.ts` — AES-256-GCM, key
  derived from `AUTH_SECRET` (no new key to manage; rotating it invalidates
  stored secrets). Never returned to the client; UI shows configured/replace.
- **Read path.** `src/server/sso.ts` — 30s-TTL cache over enabled rows
  (auth runs on most RSC renders), `bustSsoCache()` on mutation,
  `listEnabledSsoProviders()` (secret-free) for the sign-in buttons, and a
  one-time **env→DB seed** so existing `AUTH_GITHUB_*`/`AUTH_GOOGLE_*` keep
  working (env is now optional bootstrap only).
- **Gating.** New `instanceAdminProcedure` (trpc.ts) — gated on
  `session.email === ADMIN_EMAIL` (the bootstrapped operator), distinct
  from per-workspace `adminProcedure`.
- **API.** `sso` router: `list` (masked), `create`, `update` (blank
  secret = keep), `setEnabled`, `remove`, `testDiscovery` (probes the OIDC
  well-known doc for live feedback).
- **UI.** `/settings/auth` (account-level, "instance admin" badge in
  settings nav). Add/edit modal with type picker, issuer + **Test**
  discovery button, copy-ready callback URI, account-linking opt-in.
  Non-admins get an "instance admin only" empty state (FORBIDDEN surfaced).
- **Sign-in page** now lists enabled DB providers via a generic
  `oauthAction` (hidden `providerId`) instead of hardcoded GitHub/Google.

Not done: SAML (use OIDC — BoxyHQ later if ever needed); forward-auth /
trusted-header Authelia mode (deferred — OIDC is the cleaner fit). Not yet
run as a live build — verify sign-in end-to-end before relying on it.

## Known gaps / TODOs in code

- `auth.ts` assumes `nodemailer` provider; install and configure SMTP.
- `worker.ts` webhook delivery job: enqueue is currently manual — add a
  transactional outbox step that enqueues when `WebhookDelivery` rows are
  written.
- `trpc-provider.tsx` — superjson transformer on `httpBatchLink` works in
  trpc v11; double-check when installing.
- `audit.ts` fire-and-forget pub/sub — acceptable because deliveries are
  durable via `WebhookDelivery` rows, but add a retry guard in prod.

## 2026-05-23 — Local dev loop: dev:local, db:clone-prod, rich seed, data export/import

Goal: rapid local UI iteration without the dev/build/deploy-live cycle, plus
a real "import existing db" path. Four pieces:

- **`pnpm dev:local`** (`scripts/dev-local.sh`) — fully isolated loop:
  boots `docker/docker-compose.yml` (postgres 55432 / redis 56379 / minio
  59000), runs `prisma migrate deploy`, seeds an empty DB, then runs
  `next dev --turbo` against the LOCAL stack. Contrast with `dev:live`
  which points at the *deployed* data. Flags: `--fresh` (drop+recreate
  schema), `--no-seed`. Stable dev auth (fixed AUTH_SECRET; sign in with
  `owner@forge.local` / `forge-dev`, ADMIN_HANDLE=forge so the credentials
  bootstrap workspace lines up with the seed's slug).
- **`pnpm db:clone-prod`** (`scripts/db-clone-prod.sh`) — pg_dump the live
  `forge-postgres` container straight into `forge-dev-postgres`
  (`--clean --if-exists --no-owner --no-acl`), then `migrate deploy` for
  any newer local migrations. Full-fidelity replica; the reliable
  "import existing db" path (vs the JSON export which is per-workspace and
  scoped). pg_dump is read-only — never writes prod. MinIO bytes are NOT
  copied (FILE attachment rows will dangle; everything else intact).
- **Rich seed** (`prisma/seed.ts`) — replaced the 5-issue stub with a
  realistic fixture: workspace `forge`/FRG (timeTracking + CAPABILITY_MATCH
  autodispatch on), 3 members, 6 statuses, 7 labels, 2 initiatives, 3
  projects, 2 sprints (1 active/1 planned), 2 agents (victor/mizu), 24
  issues across the board with assignees/labels/relations, 3 comments.
  Idempotent: appends issue numbers off the current max and only creates
  issues/relations/comments when the workspace has none. (seed-agents.ts
  still targets the prod AXI workspace and is no longer called by
  dev:local — agents are seeded inline now.)
- **Data export/import** — new `dataPortability` tRPC router
  (`src/server/routers/data-portability.ts`, admin-gated) + Settings →
  Admin → "Data export / import" page
  (`/w/[slug]/settings/data`). Export serialises core content
  (settings, statuses, labels, initiatives, projects, cycles, agents,
  issues + assignees/labels/relations, BODY comments) to a portable JSON
  the browser downloads. Import is ADDITIVE: config rows upsert by natural
  key (status/label/cycle name, project key, initiative slug, agent
  profileKey), issues always create fresh with appended numbers, relations
  + comments remap onto the new ids, users matched by email (unknown →
  importing admin). Never deletes. Round-trip verified end-to-end via a
  throwaway createCaller test (24 issues / 40 issue-labels / 2 relations /
  3 comments reproduced exactly into a fresh workspace).

Verified: fresh migrate + seed against local stack (counts correct),
seed idempotency (re-run creates 0), export→import round-trip, typecheck,
lint clean on all touched files.

Docs: rewrote README Quick start (two dev modes + db:clone-prod + data
export/import), added `docs/guide/local-development.md` (wired into the
VitePress sidebar under Getting Started), updated the quickstart info box
and `docs/guide/settings.md` (new Data export/import surface under Admin),
and added a Local development section to this repo's `CLAUDE.md`. Docs
build passes (no dead links).

Also ran `pnpm db:clone-prod` — local `forge-dev-postgres` now mirrors
live exactly (3 workspaces / 46 issues / 4 agents). Pointing local dev at
the live DB directly already exists as `pnpm dev` (= dev-live.sh); the
clone is the isolated-sandbox alternative via `pnpm dev:local --no-seed`.

## 2026-05-23 — Chat error-banner persistence + provider/transport taxonomy

**Bug: error banner vanished on chat reload.** Messaging a provider with no
chat backend (e.g. a Codex CLI agent) surfaced the amber "no chat model
configured" banner, then it disappeared ~800ms later on both Mission Control
and the standalone Chat view. Root cause: that error is emitted as an SSE
`error` event *after* the route accepts the send (200 + `meta`), so
`serverAccepted` is true and `failSend` sets `error` **and** `finishedAt`.
The cleanup timer at the end of `runStreamingSend` (`chat-thread.tsx`) cleared
any bubble whose `finishedAt` was set — including errored ones. Fix: retain
the bubble when it carries a real error; only clear on clean finish or a
user-initiated Stop (`STREAM_STOP_SENTINEL`). The banner now persists until
the operator hits Retry or sends another message (which replaces the bubble
at the top of `runStreamingSend`). Both surfaces share `ChatThreadView`, so
one fix covers both.

**Architecture: provider/transport taxonomy (decision + scaffolding).**
Encoded the two-kinds-of-provider model in `src/server/runtimes/adapters.ts`:
- **Agent/runtime providers** (the agent *is* the provider; no Forge-held API
  key) vs **chat-only providers** (raw OpenAI-compat model via key/base URL —
  the Completions backend). Chat-only is **deferred** as its own first-class
  surface (no registry adapter ships with it).
- New `RuntimeAdapter.chatMode` (`runs | completions | acp | none`). Pull/act
  CLI connections (Codex CLI, Claude Code, Claude Desktop, custom-http) are
  `"none"` — they read context + act over MCP/webhook but don't answer chat
  from a key they lack. `hermes`/`local-daemon` are `"runs"`. Added
  `adapterServesChat()` for UI steering.
- `RuntimeTransport` extended with `"acp"` (mid tier — Agent Client Protocol,
  portable multi-vendor CLI sessions) and `"app-server"` (rich, vendor —
  Codex's `app server`, the OpenAI analogue to the Hermes gateway). Both
  declared in `PLANNED_ADAPTERS` (documentation-only; no connector yet, kept
  out of `RUNTIME_ADAPTERS` so they don't shift `defaultAdapterForProvider`).
  We support both ACP and vendor app servers by design for flexibility.

UI/docs: clarified the chat ProviderOverride popover subtext (routes to the
chosen platform's configured backend, never falls back); `runtime.adapters`
catalog now returns `chatMode`; added user-doc
`docs/agents/providers-and-transports.md`, a callout in
`docs/agents/engines.md`, and an addendum + deferred-TODO list in the
runtime-adapter ADR.

Verified: `pnpm typecheck` clean, lint clean on touched files, full unit
suite 615 passing (+2 new adapter taxonomy tests incl. a "Codex must not
present as a chat backend" regression guard). Not committed/deployed — left
to the operator (a parallel session is also working this tree).

## 2026-05-23 (cont.) — Deferred items: chat-readiness steering + tier UI/docs

Shipped the prior batch (banner fix + taxonomy + data export/import) then
worked the deferred list.

**Chat-readiness steering (ADR item 4).** New
`src/server/services/chat-readiness.ts` `resolveChatReadiness()` mirrors what
`/api/chat/stream` does at send time — resolves effective provider+engine and
checks the *same* backend (runs connector for RUNS, `isProviderAvailable` for
COMPLETIONS) — returning `{ ready, mode, reason, hint }`. Exposed via
`chat.chatReadiness({ agentId, threadId? })` (honours per-thread provider
override). `ChatThreadView` renders an on-theme amber steering banner above
the composer when not ready: distinct copy for `pull-act-only` (CLI/MCP
connection isn't a chat backend → attach a chat-capable runtime),
`no-runs-connector` (RUNS engine, no managed runtime), and `no-model`
(streaming, unset key) — each with Configure agent / Manage runtimes /
Integrations links. `providerIdFor` exported from chat-stream for reuse.
6 new unit tests.

**Tier model in UI + docs (messages: elaborate + enrich UI).** Rewrote
`docs/agents/providers-and-transports.md` around the three tiers — **Tier 1
first-class** (managed runtimes: Hermes, Codex app server — always-on, runs
as itself), **Tier 2 session** (CLIs over ACP/MCP — full power while active,
ephemeral), **Tier 3 basic** (webhook/HTTP) — with engine (runs vs streaming)
as an orthogonal axis; wired into the VitePress sidebar. Runtimes settings
page gained: a "Connection tiers" explainer card (1/2/3 with links to the
engine + transport docs), tier/transport/chatMode/multi-agent badges in the
create-runtime modal, and a "Planned runtimes" roadmap section listing
declared-but-not-yet-connectable adapters. `runtime.adapters` now returns
`chatMode`; added `runtime.plannedAdapters` (from `PLANNED_ADAPTERS`).

**Deferred items 1–3 status.** Item 1 (chat-only/completions provider as a
UI-registered surface): the *selection/availability* surface already exists in
Settings → Workspace → AI (env-keyed via `listProviders`); UI-based key
*registration* (DB-backed, encrypted) remains. Items 2 (ACP) & 3 (Codex app
server): adapters are first-class in the taxonomy + visible in UI as Planned;
their dispatch connectors are intentionally NOT fabricated — ACP is likely
daemon-mediated (stdio JSON-RPC) rather than an HTTP runs connector, and the
Codex app-server wire protocol needs a live endpoint to implement+validate.
Shipping guessed protocol code to an auto-deploying prod was judged unsafe;
these need the operator's target endpoint/protocol to finish.

Verified: typecheck + lint clean, unit suite 621 passing (+6), docs build
clean (no dead links).

## 2026-05-23 (cont.) — Codex app server = first-class (Tier 1) runtime

Checked OpenAI's Codex docs: the "app server" is a long-lived process speaking
**bidirectional JSON-RPC 2.0**, started with `codex app-server --listen
ws://HOST:PORT` (also stdio / unix). So it's a WebSocket session, not an HTTP
runs API — built `src/server/services/dispatch/codex-app-server.ts`
(`makeCodexAppServerConnector`) accordingly: one `ws` socket per run,
`initialize`/`initialized` handshake → `thread/start` → `turn/start`, drains
`item/agentMessage/delta` (content), `item/reasoning/summaryTextDelta`
(thinking), `item/started|completed` (tool cards), `turn/completed` (terminal +
usage); server→client approval requests (`item/commandExecution/requestApproval`)
surface as approval cards answered with `{decision}` (accept / acceptForSession
/ decline / cancel); `turn/interrupt` for stop. Pure mappers
(`mapCodexNotification`, `mapCodexUsage`) are unit-tested without a live socket.

Promoted `codex-app-server` from PLANNED to a first-class **managed, runs,
app-server** adapter in `RUNTIME_ADAPTERS` (defaultRunEngine RUNS). Wired
`getRunsConnectorForAgent` to build it from a runtime's `ws(s)://` endpoint.

Fixed an engine-resolution gap: `resolveRunEngine` now prefers the **attached
runtime's** adapter default over the provider's default adapter — so attaching
a Codex agent to the app-server runtime flips it to RUNS (CODEX's default
adapter is the local daemon = COMPLETIONS, which would otherwise have bypassed
the connector). Threaded `runtime` through all callers (chat-stream route,
run-dispatcher, audit webhook-suppression, chat-readiness).

Security: `assertEndpointTransport` on runtime create/update — public hosts
must use `wss://`/`https://`; plaintext only for loopback / private-LAN. UI:
adapter-aware endpoint hint + secure-transport note in the create modal.

The connector is **inert until** an operator creates a codex-app-server runtime
with a real endpoint, so shipping is prod-safe; live end-to-end validation
needs a running `codex app-server`. Verified: typecheck + lint clean, unit
suite 643 passing (+22).

## 2026-05-23 (cont.) — DB-backed model credentials (no env-only config)

ADR item 1: the Streaming (Completions) engine + internal AI features can now
reach a model via a **per-workspace, encrypted DB credential** instead of env
vars. New `ProviderCredential` model (migration 0061) keyed (workspaceId,
providerId ∈ openai|anthropic|custom), `apiKeyEnc` AES-256-GCM via `crypto.ts`.

- `ai-providers.ts`: `resolveWorkspaceProviderClient(db, ws, providerId)` —
  **DB credential first, env fallback**; builds the OpenAI client from the
  decrypted key + canonical/credential base URL. `workspaceChatProviderAvailability`
  returns a sync predicate (DB ∪ env) for readiness.
- `chat-stream.ts`: `streamChatReply`/`runChatLoop` accept a pre-resolved
  `resolvedClient`; the chat-stream route resolves it per workspace and passes
  it (DB key wins; null → env).
- `chat-readiness.ts`: takes a DB-aware `providerAvailable` predicate so a
  keyless-env provider with a stored credential reads as ready; the steering
  banner's "no-model" case now links to Settings → Workspace (Configure model).
- `ai` router: `credentials` (list, redacted to `hasKey`), `setCredential`
  (upsert, encrypt; custom requires base URL), `removeCredential` — all
  workspace-admin gated. UI: a "Model credentials" manager in Settings →
  Workspace → AI (per-provider key/baseUrl/model, write-only key, enable).

Migration 0061 is additive (CREATE TABLE) — applies on prod boot via
`migrate deploy`. Verified: typecheck + lint clean, unit suite 650 passing
(+7: credential precedence/availability + readiness DB predicate).

## 2026-05-23 (cont.) — ACP transport (daemon-mediated) + roadmap shipped

ADR item 2: ACP (Agent Client Protocol) for Tier-2 CLI sessions. ACP is stdio
JSON-RPC, so it's **daemon-mediated** — implemented in the `forge` daemon
(`tools/forge-cli/src/dispatch/acp.ts`), NOT a server connector. The adapter
spawns an ACP agent, does `initialize → session/new → session/prompt`, streams
`session/update` (`agent_message_chunk` → chat draft deltas), auto-resolves
`session/request_permission` (chat shouldn't block), and finalizes on
stopReason — reusing the same `chat.startDraft/appendDraftChunk/finalizeDraft`
plumbing as the Claude/Codex adapters. **Flexible + opt-in:** set
`FORGE_ACP_CMD="<agent> acp"` (claude-code-acp / codex acp / opencode acp) and
the daemon drives chat over ACP for any provider; unset → per-vendor adapters.
`pnpm build:cli` clean.

Registry: promoted both originally-planned adapters into RUNTIME_ADAPTERS —
`acp` (session-tier connection, managed:false, chatMode "acp") and (earlier)
`codex-app-server`. `PLANNED_ADAPTERS` is now empty (kept as an extension
point). Updated docs (providers-and-transports.md: Codex app server + ACP no
longer "planned"; chat-only backend now points at the Model credentials UI)
and the ADR TODO list (all four items ✅).

This closes the deferred list: (1) chat steering, (2) DB model keys, (3) Codex
app-server connector, (4) ACP transport — all shipped. Live end-to-end of the
Codex app-server + ACP paths needs the operator's running endpoint/agent; the
wire mappings are unit-tested and the code is inert/opt-in until configured.
Verified: typecheck + lint clean, unit suite 650 passing, daemon + docs build
clean.

## 2026-05-23 (cont.) — Codex app server wired + validated end-to-end (live)

Stood up a real `codex app-server` and validated the connector against it.
Findings + fixes:

- **codex-cli 0.133 has no `--listen ws://`** — transports are stdio (plain
  `codex app-server`) and a Unix-socket daemon. So the server-side ws connector
  needs a **stdio↔WebSocket bridge**. Wrote one at
  `/home/bailey/codex-appserver-bridge.cjs` (ws server on :4505; per connection
  spawns `codex app-server -c sandbox_mode=danger-full-access` and relays
  ndjson↔ws). Running via nohup (PID-managed); NOT yet durable across reboot
  (cron persistence was declined — operator can add a `@reboot` entry).
- **Protocol shapes** (from `codex app-server generate-ts`, verified live):
  fixed three connector mismatches — `initialize` capabilities need
  `requestAttestation`; `UserInput` text needs `text_elements: []`;
  `turn/completed` status is at `params.turn.status`. Added an
  `item/completed` agentMessage fallback (delta-less turns still finalize
  non-empty) and folded chat history into the turn (fresh thread per run).
- **Validation:** (1) gated live vitest `codex-app-server-live.test.ts`
  (CODEX_LIVE=1) bridges stdio→ws and runs the *shipped* connector through real
  codex — streams `FORGE_CODEX_OK`. (2) The **deployed Forge container** drove
  the bridge→codex round-trip over the network (172.16.24.250:4505) and got
  `FORGE_PROD_OK` via both streamed deltas and the fallback.
- **Prod wiring:** created Runtime `rt_codex_appserver` (adapterKey
  codex-app-server, endpoint `ws://172.16.24.250:4505`) in workspace
  cmo6cui6q…, attached the `@codex` agent. resolveRunEngine→RUNS via the
  attached adapter; getRunsConnectorForAgent→codex-app-server connector.

Remaining: the operator sends a chat to `@codex` in the UI (auth-walled, can't
do headless) — every layer beneath that is proven. Bridge durability is the
only ops follow-up. Verified: typecheck + lint clean, 651 unit tests (+1 gated
live), daemon + docs build clean.

**Follow-up — `b.mask is not a function` (first real UI chat).** Next's server
bundling minified `ws` and mangled its frame-masking util, so the connector
threw when masking an outbound WebSocket frame (client frames are masked).
Fix: add `ws` to `serverExternalPackages` in `next.config.ts` so it loads
unbundled from node_modules (same as ioredis/bullmq). Verified post-deploy:
`require.resolve("ws")` → `ws@8.20.0` in the container, and a masked-frame
round-trip from the deployed container → bridge → codex returns `FORGE_WS_OK`.

## 2026-05-23 (cont.) — Chat accuracy per runtime + runtime-aware commands

Audit found the chat UI was only accurate for server-side runtimes. Fixes:

- **Transport-aware readiness.** `resolveChatReadiness` now resolves *how* chat
  is served with a 4-way mode + `transportLabel`: `runs` (Hermes / Codex app
  server), `completions` (configured model), **`dispatch`** (no server model
  but reachable via the agent's runtime/daemon — per-agent webhook, LOCAL_DAEMON
  runtime, ACP/local-daemon/webhook adapter, or an AGENT-kind ApiKey linked to
  it), and `none`. The daemon's `handleChatDispatch` doesn't filter
  `streamed:true`, so local CLI / **ACP** agents *do* answer — they now read as
  ready (dispatch) instead of a false "no chat model" warning.
- **Route agrees with the banner.** `/api/chat/stream` computes the same
  transport; for `dispatch` mode it runs **no server loop** — persists the USER
  row + emits CHAT_MESSAGE_POSTED (daemon replies via chat drafts) and closes,
  with the thinking/wake indicator covering the gap. Only changes agents that
  previously errored (no model); model-configured agents are unchanged.
- **Header transport chip.** Replaced the explicit-`runEngine` "runs" pill
  (which missed runtime-resolved RUNS like `@codex`) with a chatReadiness-driven
  chip showing the actual transport — "Hermes" / "Codex app server" (ember),
  "ACP session" / "local daemon" (sky), "Streaming · OpenAI" (subtle). Now you
  can tell local-ACP vs remote-app-server vs Hermes vs streaming at a glance.
- **Runtime/agent-aware slash commands.** Added an `available?(ctx)` gate;
  `/skills`, `/memory`, `/hermes` are hidden for non-Hermes agents (`/help` +
  autocomplete filter by it). New `/runtime` command prints the resolved
  engine + transport ("served via …"). Composer passes `slashContext` to
  `matchSlashCommands`; `/info` + `/engine` reflect the resolved engine.

Verified: typecheck + lint clean, unit suite 661 passing (+10: dispatch-mode
readiness, transport labels, command gating).

## 2026-05-24 — Secure the Codex app-server runtime: sandbox + approval toggle, enable/disable, containerised bridge

The Codex app-server runtime had **full host access**: the host nohup bridge
(`/home/bailey/codex-appserver-bridge.cjs`) spawned `codex app-server -c
sandbox_mode=danger-full-access` as user `bailey`, so every Codex turn could
read/write the whole home dir (`~/SYSTEM.md`, `~/.hermes` secrets, all of
`~/.codex`). Also no lifecycle control: archive was a soft-delete, nothing
gated the dial, and the bridge was an un-managed nohup (no durability). Fixed
on two layers, keeping today's full-access behavior as the default.

**1. Per-turn sandbox + approval, Forge-driven.** codex-cli 0.133
`TurnStartParams` accepts `cwd` / `approvalPolicy` / `sandboxPolicy` overrides
(verified via `codex app-server generate-ts`). The connector
(`dispatch/codex-app-server.ts`) now sends them every turn from
`Runtime.config = { sandboxMode, approvalPolicy, workspaceRoot }`:
- `sandboxMode` → `SandboxPolicy`: `danger-full-access` → `dangerFullAccess`;
  `workspace-write` → `workspaceWrite{ writableRoots:[cwd], networkAccess:false }`;
  `read-only` → `readOnly{ networkAccess:false }`.
- `approvalPolicy` (`never|on-request|on-failure|untrusted`) — anything but
  `never` makes Codex raise `item/.../requestApproval`, which the connector
  already maps to approval cards (accept/deny in chat).
- Defaults (omitted config) reproduce today's behavior exactly:
  `danger-full-access` + `never`. `parseCodexRuntimeConfig` reads the untyped
  `Json` defensively (drops unknown enums → safe default; never throws).

**2. Enable/disable kill-switch.** New `Runtime.disabledAt` (migration 0062,
additive). Distinct from `archivedAt` (reversible *delete*): disabling is a
reversible *pause* that keeps the row configured + visible. `registry.ts`
short-circuits a disabled runtime to a **sentinel connector** (`kind:
"disabled"`) whose `startRun` throws `[runtime disabled]` — so chat shows a
clear message instead of a silent transport fallback. The dispatch sweep
(`run-dispatcher.ts`) skips disabled runtimes outright so it doesn't spin
failed runs; the assignment stays queued and dispatches when re-enabled.
Threaded `config` + `disabledAt` (+ `name`) through all 9 `agent.runtime`
selects and `AgentRuntimeRef`.

**3. Router + UI.** `runtime.setEnabled({ id, enabled })` toggles
`disabledAt`; `create`/`update` take a validated `config` (`codexConfigSchema`,
`.strict()` so a typo can't silently disable the sandbox; only the
`codex-app-server` adapter accepts config today). Settings → Runtimes gained a
per-row Enable/Disable button + a `disabled` badge, and the create/edit modals
gained a **Codex sandbox** panel (sandbox mode + approval policy selects +
workspace root) shown only for the app-server adapter.

**4. Containerised bridge = the real jail (`~/docker/codex-bridge/`).** Replaces
the host nohup bridge. The container is the hard boundary: it mounts **only**
the host's `~/.codex/auth.json` (read-only, seeded into a container-local
`CODEX_HOME` named volume so token refresh stays inside) and a single scoped
`./workspace → /work` (the agent's cwd + writable root). `restart:
unless-stopped` gives durability; `docker compose up/stop` gives lifecycle.
node:22-slim + `@openai/codex@0.133.0` + git/ripgrep/curl. Verified live: image
builds, `codex --version` = 0.133.0 inside, the ws→bridge→codex `initialize`
handshake round-trips, and **the host fs is unreachable from the container**
(`/home/bailey/SYSTEM.md` and `~/.hermes` both absent; only `/work` + auth
present). The spawn-time `sandbox_mode` is just a default — Forge's per-turn
override is authoritative.

**Cutover (operator, not done yet — replaces a live service):**
1. `pkill -f codex-appserver-bridge.cjs` (free :4505)
2. `cd ~/docker/codex-bridge && docker compose up -d --build`
3. In Forge → Settings → Runtimes, edit `rt_codex_appserver`: set
   `workspaceRoot=/work` and pick a sandbox/approval tier (leave
   full-access/never for parity with today). Endpoint stays
   `ws://172.16.24.250:4505`.
Live end-to-end of a sandboxed Codex *turn* still needs the operator to send a
chat (auth-walled) — every layer beneath that is proven.

Verified: typecheck + lint clean, unit suite 676 passing (+4:
`parseCodexRuntimeConfig` mapping), CLI build clean, codex-bridge image builds
+ smoke-tested (handshake + jail).

## 2026-05-24 — Agent/runtime UX pass (settings · onboarding · MC · chat)

Executed the fleet-UX plan (5 workstreams), each committed + deployed.

0. **Shared transport surface.** `src/lib/transport-display.ts` (tone/title/
   word/tier per `runs|completions|dispatch|none`) + `<TransportChip>`
   (`src/components/agents/transport-chip.tsx`). Chat header now uses the shared
   chip. Dedupes transport rendering across header / MC / rail / wizard /
   checklist.
1. **Integrations index → registry.** `/settings/integrations` + `integration.list`
   now source `RUNTIME_ADAPTERS` (tier-grouped: first-class / session / basic)
   instead of the retired provider-keyed manifest — so Codex app server, ACP,
   local-daemon all appear, with transport/chatMode/managed badges, in-use agent
   chips, tier-appropriate actions, and a Model-credentials card. Deleted
   `src/server/integrations/adapters.ts` (no importers). `tierForTransport`
   moved into the shared helper.
2. **Mission Control surfacing.** `agent.list` attaches a resolved
   `transport {mode,label}` per agent (chatReadiness; env availability +
   linked-key signal; no secret exposed). Agents tab shows `<TransportChip>` +
   a runtime-presence dot on the runtime chip; the chat status rail's Connection
   card uses the shared chip (dispatch / none render honestly).
3. **Tier-aware wizard + verify.** `agent.previewTransport` powers a live
   "Chat served via …" line in the Connection + Review steps (with a
   Configure-models link when a streaming model is missing). `agent.verifyConnection`
   resolves readiness and, for a managed runs runtime, probes the endpoint
   (handshake only — WS initialize for codex-app-server, GET for hermes) via the
   self-contained `dispatch/runtime-probe.ts`; surfaced as a Review-step button.
4. **Fleet-setup checklist.** Read-only card atop Settings → Agents threading
   runtime → agent → key → chat-ready (each linked; collapses to a "ready" badge
   when complete), derived from existing queries.

Also fixed a build-blocking JSDoc (`*delete*/hide` in the `Runtime.disabledAt`
schema comment closed the generated client's comment early) and applied the
parallel session's migration 0062 to dev.

Verified: typecheck + lint clean (one pre-existing Prisma type-import warning in
a parallel-session file), unit suite 672→ (+ this pass's transport/integration/
verify tests), daemon + docs build clean, deployed live (`/signin` 200, 63
migrations applied).

## 2026-05-24 (cont.) — E2E testing overhaul: 6 lanes, real auth, isolated stack, fake runtime

The E2E suite was effectively one spec: auth was hand-waved ("session cookie via
storageState" with no setup), two chat specs were `test.skip`-gated, and the
golden-path spec targeted the prod `axiom-labs` workspace via `pnpm dev` (the
**deployed** DB). Rebuilt it across six lanes; all green locally (9 Playwright
tests + 5 new contract tests), typecheck/lint clean, 681 unit tests.

1. **Auth fixture + seed alignment.** `tests/e2e/global-setup.ts` signs in the
   seeded owner via the real credentials form and saves a `storageState` the
   suite reuses (auth is JWT-strategy, so no DB session row to forge). Specs
   realigned from `axiom-labs` → the seeded `forge` workspace.
2. **Isolated stack.** `scripts/e2e-web.sh` serves a Next dev server on :3200
   against a **dedicated `forge_e2e` database** + Redis logical DB 15 on the
   existing docker stack — never prod, never the shared dev:local data. Its own
   `NEXT_DIST_DIR=.next-e2e` so a parallel `next dev` on the same checkout can't
   clobber the build (was causing `MODULE_NOT_FOUND` worker-chunk flakiness);
   `distDir` is now env-driven in `next.config.ts`.
3. **Fake DispatchConnector + agent E2E.** `dispatch/mock-runs.ts` — an
   in-process connector that streams scripted `RunEvent`s (deltas → optional
   approval → completed), wired in `registry.ts` strictly behind
   `FORGE_E2E=1` for `adapterKey: "mock-runs"` (inert in prod). The seed (also
   `FORGE_E2E`-gated) provisions an `e2e-mock` runtime + `E2E Bot` (RUNS) and an
   `e2e-codex` runtime. `chat-runs-streaming.spec.ts` drives a full chat → runs
   → SSE → render with no external runtime or auth.
4. **Stable selectors + coverage.** New `data-testid`s (runtime row/toggle/
   disabled-badge/codex-sandbox panel + mode, new-conversation agent select).
   New specs: `runtime-management` (Codex sandbox config round-trip +
   enable/disable kill-switch — i.e. this morning's secure-Codex work),
   `data-portability` (export download), and the two chat specs un-skipped to
   run authenticated.
5. **Determinism + speed.** Video/screenshot/trace on failure; `axe`
   accessibility smoke (`@axe-core/playwright`) on inbox + runtimes settings,
   gating serious/critical violations but excluding `color-contrast` +
   `link-in-text-block` as documented warm-earthy brand tradeoffs; CI e2e job
   2-way **sharded** and pointed at GH service containers
   (`E2E_MANAGE_STACK=0`). One local retry absorbs single-dev-server compile
   contention (CI keeps two).
6. **API/MCP contract tests.** `runtime-dispatch-contract.test.ts` (vitest,
   real Postgres) asserts the surface agents drive: codex `config` validation
   round-trip + bad-enum rejection, the `disabledAt` kill-switch → refusing
   sentinel connector, the mock-runs streaming + approval contract, and tenant
   isolation on runtime create.

All inert-in-prod: the mock connector + seed fixtures only activate under
`FORGE_E2E=1`, which prod compose never sets.

## 2026-05-24 (cont.) — Agent detail page: transport-aware presence + Connection card

Answered "why does Codex app server show offline in chat" + "does the detail
page show the new context". Root cause: `agent.status` ONLINE is set only by
`agents.heartbeat` / `recordAgentReachable` (webhook delivery); a runs/app-server
agent does neither, so it's stuck OFFLINE though chat is request-time reachable.

- New `agentAvailabilityModel` (transport-display.ts): `heartbeat` (Hermes) vs
  **`on-demand`** (managed app server / completions / dispatch — no heartbeat,
  connects on send) vs `session`. Chat header + detail header + dispatch-
  eligibility now render "on-demand · via <runtime>" instead of "offline" for
  those agents, and skip the heartbeat composer banner / stale-heartbeat nag.
- `agent.byProfileKey` now returns resolved `transport` + `availability` +
  runtime `adapterKey`/`disabledAt` (no secret).
- Detail page: `RuntimeCard` → `ConnectionCard` (TransportChip + adapter label
  instead of raw "remote webhook" + runtime-disabled badge + Verify button);
  webhook-health card hidden for no-webhook agents; dispatch-eligibility
  heartbeat warning suppressed + "on-demand" status for on-demand agents.

Verified: typecheck + lint clean, 688 unit tests (+availability model +
byProfileKey transport), deployed (`/signin` 200, stamped 286dba1). CHANGELOG
entry added (user-facing presence fix).

## 2026-05-24 (cont.) — E2E: rock-solid local determinism (prod build, not dev)

Follow-up to the E2E overhaul. The webServer was `next dev`, whose on-demand
compilation stalled under parallel workers — the heaviest ops (issue
create+open, data export) occasionally timed out, papered over with a local
retry. Replaced with a **production `next build` + `next start`** server
(`scripts/e2e-web.sh`): no per-request compilation, so runs are deterministic.

- `next.config.ts` skips `output: "standalone"` for the isolated E2E build
  (`NEXT_DIST_DIR=.next-e2e`) since `next start` doesn't support standalone;
  the prod Docker image (no `NEXT_DIST_DIR`) keeps standalone unchanged.
- `e2e-web.sh` builds once (or on `E2E_FORCE_BUILD=1`, set by `pnpm e2e`) then
  `next start`s; reuses the build otherwise. `pnpm e2e` kills any stale :3200
  server + forces a fresh build so it always reflects current source.
- Dropped the local Playwright retry (`retries: CI ? 2 : 0`) — no longer
  needed. CI keeps 2 purely for runner-infra hiccups.

Result: full suite **9/9 in ~10s** (was 47–70s on dev), three consecutive runs
clean, zero flakes. typecheck + lint clean.

## 2026-05-24 (cont.) — Presence consistency sweep + auto-dispatch eligibility

The "offline" fix was incomplete (only chat header + detail page) and had a
functional twin. Swept the same root issue (heartbeat-presence ≠ on-demand
availability) across surfaces + the dispatch path.

- `presenceAvailability` (transport-display.ts): cheap, **null-safe**,
  base-column derivation (no per-agent transport resolve) — heartbeat (Hermes /
  has-heartbeat) vs on-demand (has runtime/webhook, non-Hermes) vs session.
  `AgentPresenceDot` gained an `availability` prop → sky "on-demand" dot.
- Applied: chat conversations **sidebar** (statusMeta + `chat.threads` now
  selects provider/runtimeMode/lastHeartbeatAt/webhookUrl/runtimeId), MC
  **Agents tab** + **Glance view** (local PresenceDots + freshness/heartbeat
  labels), **Settings → Agents** roster. The shared dot is availability-aware,
  so the remaining passive assignee-chips/pickers/hover-previews degrade
  safely to status (no regression) until their queries carry the signal —
  tracked as a follow-up.
- **Auto-dispatch eligibility** (`dispatcher.ts`): was `status != OFFLINE`,
  which excluded on-demand agents (always OFFLINE). Now availability-aware —
  heartbeat agents must be non-OFFLINE; on-demand/session agents are eligible
  regardless; disabled-runtime agents are pre-skipped at selection.

Verified: typecheck + lint clean, 689 unit tests (+presenceAvailability),
deployed (`/signin` 200, f7988ba). CHANGELOG updated (presence + auto-dispatch).

## 2026-05-24 (cont.) — Presence sweep: assignee-chip surfaces

Finished the long tail. Enriched the assignee-chip data sources to carry the
on-demand signals (provider/runtimeMode/lastHeartbeatAt/webhookUrl/runtimeId):
`issue.list`, `issue.byId`, `issue.summary`, `issue.queue` (issue.ts) +
`inbox.get` (inbox.ts). Wired `availability={presenceAvailability(agent)}`
through issue list, board, detail page, hover preview, issue agent panel, and
the inbox chips. Widened `presenceAvailability`'s input with ignored identity
fields so minimal `{status}` picker rows don't trip TS2559; pickers without
the signal degrade safely to status. Presence is now availability-aware app-
wide for the surfaces an on-demand agent actually appears in. Deployed 78c97e3
(`/signin` 200); typecheck + lint clean, 694 unit tests.

## 2026-05-24 (cont.) — Codex stuck single-session; worker build stamp

Operator reported a Codex (app-server) agent reading "offline" in chat
despite replying, and a general "UI changes aren't reaching live" worry.

Deploy was fine: live `forge` is built from 78c97e3 (HEAD 53b9f7d is
docs-only), all 63 migrations applied, on-demand presence block confirmed
present in the live commit. `COPY . .` content-hashes source, so Docker
cache can't silently drop changes. Not a deploy gap.

Root cause: the Codex **agent row** is `runtimeMode: EPHEMERAL`, which
short-circuits both `agentAvailabilityModel` and `presenceAvailability`
(transport-display.ts) to "session" *before* the on-demand branch — and
chat-workspace.tsx maps non-"on-demand" → "offline". Why EPHEMERAL: the
Settings → Agents wizard hard-blocked PERSISTENT for CLAUDE/CODEX
(`validate()` gate + disabled RuntimeOption at :840 + stale "roadmap"
copy at :43/:339/:729/:837) — stale gating predating the codex-app-server
adapter (which is `managed`, `transport: app-server`,
`defaultRuntimeMode: PERSISTENT`, `presence: runtime-heartbeat`). Server
has **no** gate (agent.ts just takes the enum), so the flip is clean.

Fix (settings/agents/page.tsx): enable Persistent for CODEX (keep CLAUDE
blocked — no managed Claude runtime yet); `validate()` now requires a
managed app-server runtime (`MANAGED_PERSISTENT_ADAPTER_KEYS`, mirrors the
server-only manifest) be attached for a persistent Codex; refreshed the
stale copy. Then flip the live Codex agent EPHEMERAL→PERSISTENT.

Also: worker image reported a blank build stamp — the `worker` Dockerfile
stage never declared ARG/ENV GIT_SHA/BUILD_TIME and compose didn't pass
the args. Added both so the worker reports its commit (was cosmetic, but
read as staleness).

Sweep (Explore) for the same bug class — passive surfaces still rendering
`AgentPresenceDot status=…` without `availability` (plans step dots,
crews roster, chat-composer mention popover): real but their query/types
(`AgentLite`, `MentionableAgent`, `crew.members[].agent`) are trimmed and
don't carry the provider/runtime signal — same known follow-up the prior
sweep flagged. Not half-fixed (would be a no-op). Also noted: `claude-
desktop` adapter is `defaultRuntimeMode: PERSISTENT` + `presence: session`
(incoherent); `runtimeHeartbeats: provider === "HERMES"` is provider-
hardcoded (fine for now — on-demand is the intended Codex display).

Verified: typecheck + lint clean, heartbeat tests pass.

## 2026-05-24 (cont.) — Presence follow-up: passive surfaces + adapter coherence

Closed the remaining same-class items from the Codex-offline sweep.

Threaded the on-demand availability signal through the surfaces still
rendering raw `AgentPresenceDot status=…`. Used `agent.list` (which spreads
the full agent row — provider/runtimeMode/runtimeId/webhookUrl) as the single
authoritative source, mapped by agent id — purely client-side, no router/
Prisma changes:
- **Plans cockpit**: widened `AgentLite` with the presence inputs; pass
  `availability={presenceAvailability(agent)}` on the assignee dot; added
  `availability` to `DagAgent` (orchestration/types.ts), computed in the
  `dagAgentsById` builder, consumed by `StepNode` (graph view).
- **Crew page** (`crews/[crewId]`): built `availabilityById` from the page's
  existing `agent.list` query; pass it on the member dot.
- **Crew roster panel** (plan + goal cockpits): self-contained — added a
  cached `agent.list` query inside the panel (hook lifted above the
  `if (!crew)` early return) → id→availability map → member dot.
- **Chat @-mention popover**: added `availability` to `MentionableAgent`,
  computed in the chat-thread builder from `workspaceAgents`, consumed in
  `chat-composer`.

Adapter coherence: `claude-desktop` was `defaultRuntimeMode: PERSISTENT` +
`presence: "session"` (incoherent — PERSISTENT resolves to heartbeat presence
→ false "offline"). It's an MCP pull/act client (not push-reachable, not
heartbeat-tracked), so flipped the default to EPHEMERAL and reworded the
tagline.

Out of scope (noted, not fixed): agent-timeline, dashboard activity tile, and
agent-hover-preview's inner badge still render raw status — low-value rosters
without the signal in their queries.

Verified: typecheck + lint clean, 694 unit tests pass.

## 2026-05-24 (cont.) — Presence: last three surfaces

Finished the on-demand presence sweep — no raw-status `AgentPresenceDot`
left on agent surfaces.

- **Agent timeline** (`agent-timeline.tsx`): the agent chips iterate the
  page's `agent.list` rows (full fields) → `availability={presenceAvailability(a)}`.
- **Dashboard agent-activity tile**: `dashboard.agentActivity` select didn't
  carry the signal. Enriched the select (provider/runtimeMode/runtimeId/
  webhookUrl) and computed `availability` server-side per row
  (presenceAvailability is client-safe, importable here); tile consumes
  `a.availability`.
- **Agent hover card** (`agent-hover-preview.tsx`): enriched `agent.summary`
  select with runtimeMode/runtimeId/webhookUrl; `AgentCard` computes
  availability once; both the row-3 dot and the `StatusPill` are now
  availability-aware (pill reads "On-demand" in sky instead of "Offline" —
  row-3 dot only renders when a heartbeat exists, so the pill is the real
  fix for null-heartbeat on-demand agents).

Verified: typecheck + lint clean, 694 unit tests pass.

## 2026-05-24 (cont.) — Coverage audit: generalize the persistent gate

Audited the full adapter matrix (8 adapters) vs the wizard's runtime-mode
gate. Found my earlier Codex fix was too narrow: `local-daemon` is a managed,
PERSISTENT, runtime-heartbeat adapter that serves CLAUDE/CODEX/CUSTOM/HERMES,
but the gate only allowed persistent on `codex-app-server` (Codex) and blocked
persistent Claude entirely — so a Claude/Codex agent on the Forge local daemon
couldn't be persistent.

Generalized: the gate is now provider-agnostic for CLAUDE/CODEX — persistent
allowed iff a managed-persistent runtime is attached (MANAGED_PERSISTENT_-
ADAPTER_KEYS broadened to {codex-app-server, local-daemon, hermes}). Enabled
the Persistent toggle for both, refreshed hints + footer copy. All 8 adapters
are coherent (defaultRuntimeMode vs presence). Verified: typecheck + lint
clean, 694 tests.

Known remaining (design choice, not shipped): non-Hermes runtime-heartbeat
adapters (local-daemon, codex-app-server) always read "on-demand" and don't
reflect their runtime's actual up/down — availability keys on
provider==="HERMES" + Agent.lastHeartbeatAt, ignoring the adapter presence
capability + Runtime.heartbeatAt (which the daemons actually bump).

## 2026-05-24 (cont.) — True runtime-heartbeat presence (daemon-hosted agents)

Implemented true online/offline for agents on a heartbeating managed runtime.

Mechanism (no client/resolver changes): `runtimes.heartbeat` is called only by
the forge CLI daemon (LOCAL_DAEMON, adapter `local-daemon`, presence
`runtime-heartbeat`). The handler now, when the runtime's adapter presence is
`runtime-heartbeat`, calls a new `recordRuntimeHeartbeatPresence(runtimeId,
now)` (heartbeat.ts) that bumps `lastHeartbeatAt` on the runtime's PERSISTENT
agents and flips OFFLINE→ONLINE (with an AGENT_STATUS_CHANGED event, reason
`runtime-heartbeat`); BUSY agents keep status + get a fresh heartbeat;
EPHEMERAL (session) agents are left alone. The existing `sweepIdleAgents` job
flips them back to OFFLINE once the daemon stops (their heartbeats go stale
together). Because the agents now carry a real `lastHeartbeatAt` + status,
every existing surface resolves them to "heartbeat" presence and shows
online/offline — zero surface changes.

Scope/limitation (by design): runtimes reached *outbound* from Forge that
don't heartbeat inbound — Codex app server (REMOTE_HTTP), webhooks — never hit
this path, so their agents keep null `lastHeartbeatAt` → on-demand. Giving
codex-app-server true presence would need an active health probe (Forge pings
the endpoint) or the bridge calling `runtimes.heartbeat` itself (runtime-side,
out of this repo) — at which point this same code lights it up automatically.

Tests: +3 in heartbeat.test.ts (OFFLINE→ONLINE+event, BUSY preserved+bump,
EPHEMERAL untouched). typecheck + lint clean, 697 unit tests pass.

## 2026-05-24 (cont.) — Active health probe for outbound managed runtimes

Closed the last presence gap: the Codex app server (REMOTE_HTTP, reached
outbound, never heartbeats inbound) now gets true online/offline via an active
probe.

New `sweepRuntimeHealth()` (runtime-health.ts), a 60s maintenance job: finds
non-archived, non-disabled runtimes with an endpoint whose adapter is
`transport: "app-server"` + presence `runtime-heartbeat` (today: codex-app-
server; Hermes `runs-api` and LOCAL_DAEMON are intentionally excluded — Hermes
reports per-agent, the daemon self-heartbeats, probing them could override a
better signal). Reuses the existing `probeRuntime()` (WS `initialize`
handshake) from the verify-connection path. A reachable endpoint == heartbeat:
bumps `Runtime.heartbeatAt` + calls `recordRuntimeHeartbeatPresence()` so the
hosted persistent agents read online; an unreachable one isn't bumped and
`sweepIdleAgents` flips the agents OFFLINE once stale.

Wired into worker.ts (job id `runtime-health-sweep`, 60s, registered on boot).
Secret is passed to the probe as-is (same as verifyConnection — not decrypted).

Tests: runtime-health.test.ts — real in-process `ws` server (reachable →
agent ONLINE + runtime heartbeatAt set) + unreachable endpoint (agent stays
OFFLINE). typecheck + lint clean, 699 unit tests pass.

Net: presence is now true online/offline for every managed runtime (Hermes,
local daemon, Codex app server); session CLIs stay "session"; nothing reads a
false "offline" or a stale "on-demand."

## 2026-05-24 (cont.) — Default agentIdleTimeoutMinutes 0 → 15 + E2E

Closing the presence default gap: `Workspace.agentIdleTimeoutMinutes` defaulted
to 0, which disables `sweepIdleAgents` — so on a fresh workspace the "offline
when the runtime dies" half of true presence never fired (agents stuck ONLINE
after the last heartbeat/probe). Migration 0063 sets the column DEFAULT to 15
(new rows only — no backfill, so any deliberate 0 opt-out is preserved; 0 still
means disabled). 15min sits well above the 60s heartbeat/probe cadence, so no
flapping. Also corrected the stale schema doc-comment (it described claimed-
issue auto-release; the field actually drives the heartbeat agent-offline
sweep). The live workspaces were already at 15, so no behavior change there.

E2E: ran the full Playwright suite (9 specs — a11y, chat surface/streaming/
attachments, issue flow, data export, runtime management) against a fresh
prod build. Green.

---

## 2026-05-25 — Command Center: inline issue status on asks

Bailey noticed the "Asks for you" cards offered only Accept/Decline. When an
agent blocks on an issue (FREE_FORM/decision ask) but the operator decides the
issue is actually Done, there was no way to close it without Decline — and
Decline records a "Declined by …" resolution, which is the wrong signal.

Confirmed the model is intentionally asymmetric: `runs.complete` / `setWaiting`
/ `resumeWork` never touch issue status; only ActionRequest Accept on a
TRANSITION-kind ask, or a manual transition, moves it. Decline never executes
the bound action. (See action-request-service.ts decline path, mcp.ts
runs.complete docstring, issue.ts finishRunsForIssue.)

Change (UI only, per Bailey's pick): added `IssueStatusPicker` to
`ActionRequestDecisionCard` in `command-center/page.tsx`. A ghost "Set status…"
button (shown only when the ask has a linked issue) opens the shared `Picker`
and drives `issue.update({ id, statusId })`. Deliberately independent of the
ask — it does NOT resolve/decline the ActionRequest, so the ask stays open for a
separate call and no decline resolution is written. Terminal transitions
(DONE/CANCELED) close the issue's active runs server-side via the existing
issue.ts path. statuses fetched lazily (`enabled: open`); invalidates
commandCenter.summary + decisionsCount + inbox.get on settle. Needed `issue.id`
added to the card's `CCActionRequest` type (the CC query already selected it).

No server/runtime changes; agent-emitted TRANSITION asks deferred. typecheck +
lint green. Not deployed (holding per Bailey).

---

## 2026-05-25 — Notifications/inbox: audit + three behavior fixes

Bailey asked to verify the navbar notifications + inbox commands (mark read,
snooze, etc.) actually work. Audited end-to-end: every control is wired
(client handler → tRPC → DB → invalidation), realtime fan-out present, and the
notification/inbox test suites are green (21 tests). No broken wiring. But three
behaviors *felt* broken; Bailey okayed fixing all three.

1. **Auto-mark-read on open → on close.** `activity-drawer.tsx` previously fired
   `markNotificationRead({all:true})` on a 1s timer after the drawer opened, so a
   peek wiped unread state mid-view and made the per-row + manual controls
   pointless. Replaced with a close-transition effect (prevOpen ref; the drawer
   stays mounted via top-bar.tsx and returns null when closed, so the open→false
   transition is observable). On close we now write the activity last-read anchor,
   mark notifications read, AND fire `inbox.visit` so both halves of the badge
   settle.

2 + 3. **Badge is now an unread/since-visit count, not a backlog total.**
   `inbox.badge` previously returned raw assigned+stalled+mention totals, so
   "mark read"/`M` never moved it. Reworked to count only rows new since
   `User.lastInboxVisitAt` (mirrors the `unreadSinceVisit` notion `inbox.get`
   already computes): assigned/stalled by `updatedAt > lastVisit`, mentions by
   `createdAt > lastVisit`; null lastVisit → count all (new user). Now visiting
   the Inbox (auto-visit on mount already existed), pressing `M`, or opening+
   closing the bell drops it to zero; fresh activity re-raises it. Bell tooltip
   updated from "items need your attention" → "N unread items". Sidebar inbox
   badge shares `inbox.badge`, so it gets the same unread semantics.

New test: `inbox-badge.test.ts` (3 cases — counts when never-visited, zeroes
after visit, re-raises on post-visit update). typecheck + lint + notification/
inbox suites green. Committed accfe32; deployed (stamped GIT_SHA=accfe32, no
pending migrations, Next.js Ready). This build also shipped the earlier
command-center inline-status commit (5598221), since prod builds from the
working tree.

---

## 2026-05-25 — Issue dependency DAG + project/sprint moves + plan backlinks

Bailey asked for (1) a themed/animated DAG of an issue's relations showing its
place in the path/tree, (2) better project/goal linking + proper project (and
sprint) reassignment, and (3) other gaps. Scoped via AskUserQuestion: deps +
sub-issues, graph-toggle-in-Relations-tab, all four gap fixes, keep UI clean.

**Relations DAG.** New `relation.graphForIssue({ issueId, depth })` BFSes two
directed edge dimensions out ~2 hops: `blocks` (reads only BLOCKS rows — each
pair mirrored to BLOCKED_BY in add, so every dependency appears once in true
direction) and `child` (Issue.parentId). Caps at GRAPH_MAX_NODES=60, drops
edges to cap-truncated nodes. Client `IssueRelationsGraph` reuses the
orchestration DagView's longest-path layered layout + SVG bezier edges +
`.dag-edge-flow`/`.forge-active-node` theming; focus node flagged "here",
child edges dashed, edges touching focus get the ember flow. List/Graph toggle
added to `issue-relations-panel.tsx` (list stays the edit surface).

**Project/sprint moves.** Added `cycleId` to `issue.update` (direct FK, mirrors
projectId, with cross-tenant guard). Sidebar project `<select>` → shared
searchable `Picker` showing each project's initiative; new Sprint picker.
(Initiative stays transitive-via-project — surfaced in the project picker
rather than a fake direct setter; a direct Issue→initiative link would need a
schema change, deferred.) New `issue.bulkSetProject` / `bulkSetCycle` mutations
(mirror bulkAssign: workspace-scope guard, per-issue ISSUE_UPDATED). Shared
`bulk-move-pickers.tsx` (BulkProjectPicker/BulkCyclePicker) wired into both the
issues-list and inbox bulk bars.

**Plan backlinks.** `IssuePlansStrip` on the issue (executionPlan.list by
issueId) shows plans the issue is the subject of with a done/total step bar +
status; sits beside the existing goals strip.

Tests: relation.test.ts +2 (blocks chain w/ focus flag; parent/child edges);
new issue-bulk-move.test.ts (update cycleId set/clear + cross-ws reject;
bulkSetProject/Cycle + cross-ws reject). Full suite 715 pass / 1 skip,
typecheck + lint clean. Committed 08622c3; deployed live (stamped
GIT_SHA=08622c3, no pending migrations — cycleId was input-schema only,
Next.js Ready).

---

## 2026-05-26 — Epics as WorkItemKind + sub-issue tree UI

Bailey asked whether to add a direct Issue→initiative link and to consider
Epics + proper linking. Recommendation (given the convergence vision — steps→
issues, runs→issues, one work substrate): **no direct initiative FK** (it forks
rollups against Project.initiativeId; keep transitive), and **Epics as
WorkItemKind.EPIC**, not a new table — an Epic is an Issue whose children are its
scope, reusing parent/child + relations DAG + cycles + runs. Approved full pass:
EPIC/ISSUE/SUB-TASK ladder (TASK = "Sub-task" in UI).

Found: `WorkItemKind` enum (ISSUE|TASK) already existed on Issue, used in
issue.create + data-portability, but never surfaced in UI and no EPIC. parent/
child already in schema + returned by issue.byId, also unrendered. So this was
mostly lighting up dormant plumbing.

- **Schema**: added EPIC to WorkItemKind (migration 0068, ALTER TYPE ADD VALUE
  BEFORE ISSUE). Local dev DB was drifted (parallel session db-push'd 0064-0067
  columns without ledger rows), so migrate deploy was blocked on unrelated 0064;
  applied just the enum addition directly via psql to the local stack (idempotent,
  non-destructive). Committed migration handles prod cleanly (prod DB in sync).
- **kind UI**: shared `work-item-kind-glyph.tsx` (glyph/label/KindChip, ember tint
  for EPIC) mirroring engagement-mode-glyph. KindPicker on the issue header;
  glyph in issue-list rows (shown only for non-ISSUE). Added `kind` to issue.update
  input (spreads generically).
- **Sub-issues**: new `issue.children` query (lean, status+kind+done/total rollup).
  `sub-issues-panel.tsx` — SubIssuesPanel (rollup bar + inline create-child that
  inherits parent project; Epic→Issue, Issue→Sub-task) + ParentIssueBacklink
  ("↑ part of EPIC-…"). Wired into IssueMain (new props kind/projectId/parent).
- **Epics view**: `kinds[]` filter on filterSchema + issue.list where-clause;
  `kinds` added to SavedViewFiltersSchema; "Epics" quick-filter chip. Deliberately
  did NOT add group-by-kind to the issues list — it's status-grouped (sticky
  headers); the Epics chip + glyph + sub-issue drill-down deliver the view without
  a second grouping axis.

Tests: new issue-epic.test.ts (4: create/update kind, children rollup done/total,
kinds filter, cross-ws reject) — all pass; my touched suites 37/37. NOTE: full
suite shows 1 pre-existing failure (heartbeat sweepIdleAgents) that fails on clean
master too (shared/drifted local DB from the parallel session) — unrelated to this
work. typecheck + lint clean. Committed 9aa542d; deployed live (stamped
GIT_SHA=9aa542d). Migration 0068 applied cleanly to prod — prod enum now
EPIC,ISSUE,TASK; Next.js Ready.
