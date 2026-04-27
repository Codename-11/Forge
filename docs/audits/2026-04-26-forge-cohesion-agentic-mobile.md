# Forge Cohesion, Agentic Dispatch, and Mobile Audit - 2026-04-26

> **Historical/restored audit note (2026-04-27):** This report was restored from the Hermes session transcript after the original untracked `docs/audits/` files were no longer present in the Forge worktree. The original mobile screenshot artifacts were reported during the 2026-04-26 Codex run but are not present in the repo as of 2026-04-27. Findings are retained from the audit transcript; screenshots should be recaptured before using mobile findings as visual regression evidence. Some verification status has changed since the original run: `pnpm typecheck` passes at HEAD `e9fd9d3`.

## Executive Summary
- Overall completeness: Partial. Forge is cohesive as a human PM/workflow layer for AXI/PER/WRK-style work, but it is not yet operationally complete as a reliable autonomous Hermes dispatch layer.
- Biggest strength: The core product primitives are well-shaped and visible: issues, queue, Sprints, projects, initiatives, agents, MCP, webhooks, AgentRun telemetry, watchdog events, and dispatch analytics all exist.
- Biggest operational risk: The documented Hermes ack loop is not reliable because key MCP write paths bypass `recordChange()`, so comments/transitions can fail to emit the events required for ack, webhooks, activity history, and analytics.
- Biggest mobile risk: Phone layouts are explicitly degraded and mostly usable for read/triage, but several dense operator surfaces remain desktop-shaped. Current dirty notification-state work also caused tRPC 500s during mobile capture.
- Recommended next 3 actions:
  1. Restore MCP mutation parity for issue create, transition, and comment create before relying on noack or dispatch analytics.
  2. Enforce dispatch push gates (`autoStartOnAssign`, `requireApprovalBeforeStart`) and agent role eligibility (`WORKER` only for auto-dispatch).
  3. Stabilize current notification-state schema/router work, then add authenticated mobile Playwright coverage for inbox, issues, agents, settings agents, and deliveries.

Readiness verdict: Not ready for unattended Hermes production dispatch. It is usable for human-supervised work and MCP pull/poll workflows, provided operators understand the current reliability gaps.

## System Flow Map
Capture -> Issue -> Queue -> Dispatch -> Agent Work -> Review/Done -> Analytics

- Capture: Quick-create exists and is fast, but docs overstate fields and a full-page `/issues/new` path is not implemented.
- Issue: Core issue model is mature, with labels, projects, Sprints, relations, attachments, time, human claims, and agent assignment.
- Queue: `queued` is explicit and visible in Inbox/Agents; queue counts distinguish ready, blocked, assigned, and claimed work.
- Dispatch: Modes and dispatch rules exist, but push/approval gates and role semantics are incomplete.
- Agent Work: MCP, AgentRun, status comments, and webhook push exist; normal MCP comments/transitions do not fully join the event/audit pipeline.
- Review/Done: tRPC status changes set lifecycle timestamps and close active runs; MCP transitions do not.
- Analytics: Dispatch analytics and activity views exist, but they depend on events that some MCP/bulk paths do not emit.

## Workflow Cohesion Matrix
| Area | Status | Evidence | Gap | Recommended action |
|---|---|---|---|---|
| Capture | Partial | `docs/guide/issues.md:93` says quick-create covers title, description, status, priority, project, kind; `src/components/quick-create.tsx:300` sends title/project/priority only. | Docs describe a richer create flow and `/issues/new`, but implementation is lightweight. | Either implement richer create/template flow or revise docs to the actual fast-capture contract. |
| Templates -> issues | Partial | Issue template router/settings exist; quick-create uses empty `labelIds` and does not expose templates. | Templates are not in the primary capture path. | Add template picker to quick-create/full create, or position templates as settings-only until wired. |
| Backlog / inbox / queue | Complete | `issue.setQueued`, `issues.queue`, Inbox queue counts, and Agents pool lanes exist. | Docs imply `issues.release` hands agent work back to queue; router release only clears human claim fields. | Clarify human claim release vs agent handback, or add explicit agent unassign/requeue action. |
| Project / initiative / Sprint | Partial | UI says Sprint while code/routes stay `cycle*`; project/initiative pages and Sprint planning exist. | Docs overstate draft/commit planning, targeted rollover, and roadmap drag/relink. | Align docs with current implementation or add missing planning/roadmap mutations. |
| Human / agent assignment | Risk | tRPC assignment and bulk assignment emit `AGENT_ASSIGNED`; `src/server/services/dispatcher.ts:75` selects agents by non-archived/non-OFFLINE. | Dispatcher does not filter `role: WORKER`; push/approval knobs are read but not enforced. | Enforce role and push gating in the dispatch event path. |
| Execution | Risk | AgentRun, Mission Control, status comments, and MCP tools exist. | `issues.create`, `issues.transition`, and `comments.create` in MCP bypass important tRPC invariants. | Make MCP write paths call shared service helpers that record audit/activity/lifecycle consistently. |
| Review / done | Partial | tRPC issue update sets `completedAt` and closes active runs on terminal states. | MCP transition only updates `statusId`, so Done can miss timestamps/run closure/events. | Add lifecycle handling to MCP transition and bulk status paths. |
| Analytics / history | Partial | Dispatch analytics query `ActivityEvent`; agent timelines hydrate issue/agent context. | Analytics/history are incomplete when writes bypass `recordChange()`. Event docs omit current `AGENT_RUN_*` kinds. | Fix event parity, then refresh docs/reference. |

## Agentic Dispatch Flow Map
Hermes push + MCP pull loop:

1. Operator creates an `Agent` with `profileKey`, provider/runtime metadata, capabilities, optional `webhookUrl`, optional secret, and `maxConcurrent`.
2. Operator issues an API key with `linkedAgentId`; `agents.me`, `agents.heartbeat`, and `issues.assigned` infer identity from that key.
3. Agent heartbeats or receives a successful webhook delivery, which can make it reachable.
4. Operator queues an issue. `maybeAutoDispatch()` runs when `autoDispatch` is enabled and the issue is queued/unassigned.
5. Dispatcher applies dispatch rules first, then mode selection (`ROUND_ROBIN`, `PRIORITY_MATCH`, `CAPABILITY_MATCH`) and writes `AGENT_ASSIGNED`.
6. `recordChange()` creates `ActivityEvent` and `WebhookDelivery`; the worker resolves synthetic `agent:dispatch` webhooks to real agent URLs.
7. Hermes receives the signed wake event, returns 2xx, and should act through MCP.
8. Hermes calls MCP (`comments.upsertStatus`, `comments.create`, `issues.transition`, attachments/time/etc.) to acknowledge, work, and report progress.
9. Watchdogs emit `AGENT_NOACK`, `ISSUE_STALLED`, `ISSUE_SLA_BREACH`, and `AGENT_RUN_STALLED` when follow-through fails.
10. Operators inspect Agents, Mission Control, deliveries, activity, and analytics.

The loop is structurally present. The weak link is event parity and gate enforcement between steps 6 and 8.

## Hermes Integration Completeness Checklist
| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Agent profile identity | Complete | `Agent.profileKey`, unique per workspace. | Matches Hermes profile handle. |
| Provider/runtime onboarding | Partial | Settings Agents stepper supports Hermes/Claude/Codex/custom. | Role is not exposed in create/update inputs. |
| Linked API key | Complete | `ApiKey.linkedAgentId`; `agents.me`, `agents.heartbeat`, `issues.assigned`. | Good self-identification model. |
| Heartbeat | Partial | MCP heartbeat updates status/lastHeartbeatAt. | MCP heartbeat does not emit `AGENT_STATUS_CHANGED`; tRPC heartbeat is broad workspace-member write. |
| Queue dispatch modes | Partial | Modes and rules implemented. | Role filtering missing; BUSY remains eligible by design but successful delivery flips BUSY to ONLINE. |
| Dispatch rules | Partial | Ordered rule layer and ineligible fallback exist. | UI drag/drop lacks touch fallback; rules target single label/agent only. |
| Push webhook delivery | Partial | Synthetic webhooks and delivery rows exist. | Failed initial delivery is marked FAILED and not retried by the drain loop. |
| Push approval/start gates | Missing | Docs describe `autoStartOnAssign`/approval gating. | `recordChange()` queues agent dispatch on `AGENT_ASSIGNED` regardless. |
| Hermes ack path | Risk | Required-ack checks comment/status events. | Documented `comments.create`/`issues.transition` do not emit those events. |
| MCP work loop | Partial | 52 tools exist across issues/comments/projects/Sprints/etc. | Tool docs say 46; README says 44; some writes bypass audit/lifecycle. |
| Noack/stale/SLA recovery | Partial | Services and worker jobs exist. | Correctness depends on missing MCP events; required-ack has reassignment/window edge cases. |
| Observability | Partial | Agent timeline, webhook health, dispatch analytics exist. | Skewed by missing events and generic dispatch target resolution. |
| Permissions | Partial | API scopes and project/label/initiative narrowing exist. | No per-agent lattice such as "only assigned issues" or "comment only on assigned work." |

## Agentic/Reliability Gaps
| Priority | Finding | Evidence | Recommended action |
|---|---|---|---|
| P0 | MCP `issues.create`, `issues.transition`, and `comments.create` bypass audit/activity/lifecycle, breaking ack, history, webhooks, timestamps, and analytics. | `src/server/services/mcp.ts:186`, `:234`, `:794`; `src/server/services/required-ack.ts:92`. | Extract shared issue/comment mutation services or make MCP paths mirror tRPC `recordChange()` behavior. |
| P0 | `autoStartOnAssign` and `requireApprovalBeforeStart` are documented but not enforced. | Dispatcher reads the fields at `src/server/services/dispatcher.ts:51`; `recordChange()` queues agent dispatch at `src/server/audit.ts:141`. | Add dispatch-start state and skip/schedule webhook rows according to workspace gates. |
| P0 | Auto-dispatch ignores `Agent.role`; OBSERVER/COACH can be routed if online and under cap. | Schema comments say only WORKER should dispatch; dispatcher query at `src/server/services/dispatcher.ts:75` has no role filter. | Filter `role: WORKER`; expose role in agent settings/onboarding. |
| P0 | Webhook retry durability does not match docs. | Worker sets non-2xx to `FAILED`; drain only enqueues `PENDING` at `src/server/worker.ts:270`. | Use BullMQ attempts/backoff for initial jobs or have drain requeue due FAILED rows by `nextAttemptAt`. |
| P0 | Current notification-state dirty work blocks typecheck and causes tRPC runtime 500s. | `NotificationStatus.UNREAD` undefined in dev logs; `pnpm typecheck` fails on missing Prisma exports. | Land/fix migration and Prisma generate path before mobile/operator release. |
| P1 | Generic `agent:dispatch` resolves recipient from current issue assignment at delivery time. | `src/server/audit.ts:141`; `src/server/worker.ts:58`. | Use per-agent synthetic dispatch URL for assignment deliveries, or store target agent on `WebhookDelivery`. |
| P1 | Required-ack can false-positive/false-negative. | First comment only, no upper bound, any actor status move counts, no check that original agent still owns issue. | Scan all post-assignment comments within window, require assigned-agent auth or agent-run ack, and skip if reassigned. |
| P1 | `issues.reassign` payload lacks top-level `agentId` and handoff comment agent attribution is weak. | `src/server/services/mcp.ts:659`. | Include `agentId`, `profileKey`, from/to fields consistently; stamp `authoringAgentId` when key-linked. |
| P1 | MCP heartbeat does not emit status-change events; tRPC heartbeat can be called by any workspace member. | `src/server/services/mcp.ts:2312`; `src/server/routers/agent.ts:317`. | Route heartbeats through a shared audited helper and restrict tRPC heartbeat to admin or self-linked key flow. |
| P1 | Per-agent permissions remain too coarse. | API key scopes/narrowing are workspace/resource scoped. | Add policies like only assigned issues, comment-only, no reassign, no project mutation, allowed transitions. |
| P1 | Dispatch decisions are event-rich but not fully operator-explainable in UI. | Payload has candidates/reasons; pages summarize but do not expose full candidate/ineligible table everywhere. | Add "why this agent" drill-down on issue/agent timeline. |
| P2 | MCP `tools/list` is unfiltered/public while docs say filtered. | `src/app/api/mcp/rpc/route.ts:84`; docs at `docs/reference/mcp.md:20`. | Require auth for `tools/list` or update docs and threat model. |

## Mobile Audit Findings
Screenshots were captured under `docs/audits/artifacts/2026-04-26-forge-mobile/` for iPhone SE 375x667, iPhone 14-ish 390x844, iPhone landscape 844x390, and iPad mini 768x1024.

| Severity | Route | Viewport | Finding | Evidence | Likely files |
|---|---|---|---|---|---|
| P0 | `/w/axiom-labs/issues/:id` and tRPC-backed client areas | iPad mini, some reloads | Current dirty notification-state code caused tRPC 500s and blank/partial issue detail content during recheck. | `ipad-mini-issue-detail-recheck.png`; dev log `NotificationStatus.UNREAD` undefined. | `src/server/services/notifications.ts`, `src/server/routers/notification.ts`, `prisma/schema.prisma` |
| P1 | `/w/:slug/settings/integrations/deliveries` | 375/390px | Delivery table is a six-column desktop grid. It avoids page-level overflow but content is cramped/truncated and hard to inspect. | `iphone-se-settings-deliveries.png`; grid at page `:159` and `:174`. | `src/app/(app)/w/[slug]/settings/integrations/deliveries/page.tsx` |
| P1 | `/w/:slug/agents` | 375/390px | Agent pipeline uses fixed two-column and three-column grids, making lanes narrow on phones. | `iphone-se-agents.png`; `src/components/agent-pipeline.tsx:74`, `:123`. | `src/components/agent-pipeline.tsx` |
| P1 | `/w/:slug/settings/agents` | 375/390px | Agent cards are readable, but action row and metadata are dense; onboarding stepper likely needs a phone pass before claim of support. | `iphone-se-settings-agents.png`. | `src/app/(app)/w/[slug]/settings/agents/page.tsx` |
| P1 | `/w/:slug/issues` | 375/390px | Issue filters and rows are desktop-dense; search is fixed `w-48`, row metadata competes with title/agent/avatar. | `iphone-14-issues.png`; `src/app/(app)/w/[slug]/issues/page.tsx:38`, `src/components/issue-list.tsx:293`. | `src/app/(app)/w/[slug]/issues/page.tsx`, `src/components/issue-list.tsx` |
| P1 | `/w/:slug/issues/:id` | 375/390px | Detail page stacks, but status/priority/assignee controls are dense and long agent names can crowd the header. | `iphone-se-issue-detail.png`. | `src/app/(app)/w/[slug]/issues/[id]/page.tsx` |
| P1 | `/w/:slug/inbox` | 375/390px | Topbar action cluster fits in capture but remains dense; "This workspace / All my workspaces / Workspace overview" competes with title area. | `iphone-se-inbox.png`. | `src/app/(app)/w/[slug]/inbox/page.tsx`, `src/components/topbar.tsx` |
| P2 | Shell | Phones | Product intentionally says tablet+ and uses an icon rail. This is coherent, but should be treated as degraded mobile, not full phone parity. | `src/app/(app)/w/[slug]/layout.tsx:113`. | `src/app/(app)/w/[slug]/layout.tsx`, `src/components/sidebar.tsx` |
| P2 | Settings nav | Phones/tablet | Settings nav is one of the better responsive patterns: horizontal overflow works. | `iphone-se-settings.png`. | `src/components/settings/settings-navbar.tsx` |
| P2 | `/w/:slug/projects`, `/cycles`, `/dashboard` | Phones | Read-only scanning is broadly usable, but dense cards and long titles will need regression screenshots. | Screenshots in artifact directory. | Page-specific files |

Mobile shippability: Tablet-first is close after the notification-state blocker is fixed. Phone is degraded but usable for scanning and light triage; not shippable for confident operator workflows until delivery health, agent pipeline, issue rows, and issue detail controls get mobile-specific layouts.

## Test Coverage Gaps
| Gap | Current coverage | Recommended test |
|---|---|---|
| MCP write parity | Service tests cover many MCP tools but not audit/event parity for create/transition/comment create. | Assert MCP issue create emits `ISSUE_CREATED`; transition emits `ISSUE_STATUS_CHANGED` and timestamps; comment create emits `COMMENT_CREATED` with `authoringAgentId`. |
| Required ack documented path | Required-ack tests manufacture events directly. | End-to-end service test: `AGENT_ASSIGNED` delivery followed by MCP `comments.create` and `issues.transition` suppresses noack. |
| Push gate enforcement | No coverage found for `autoStartOnAssign` / `requireApprovalBeforeStart`. | Dispatcher/worker tests that assignment creates or suppresses `WebhookDelivery` according to knobs and approval state. |
| Agent role eligibility | Dispatcher tests cover modes and maxConcurrent but not role. | Tests for WORKER eligible, OBSERVER/COACH excluded from auto-dispatch, manual assignment still allowed as intended. |
| Webhook retries | Admin delivery tests exist; normal initial failure retry loop is not covered. | Worker test for failed delivery scheduling retry/backoff and final DLQ. |
| Generic dispatch retargeting | Not covered. | Delivery created for old assignee, issue reassigned before drain, delivery still goes to original target. |
| Mobile regression | Playwright has only Desktop Chrome and one auth-assumed test. | Add authenticated `390x844` and `768x1024` projects with screenshot or overflow assertions for inbox/issues/agents/settings/deliveries. |
| E2E quick-create | Current test presses `c`; quick-create binds `shift+c`. | Use `[data-quick-create]` or `Shift+C`, with a real `storageState`/global setup. |

## Recommended Backlog
| Priority | Title | Type | Acceptance criteria | Files likely touched |
|---|---|---|---|---|
| P0 | Make MCP issue/comment writes emit canonical audit events | Reliability | MCP create/transition/comment paths produce the same ActivityEvents, lifecycle timestamps, run closure, and webhook fan-out as tRPC. Required-ack passes with documented MCP calls. | `src/server/services/mcp.ts`, shared issue/comment services, tests |
| P0 | Enforce agent dispatch start/approval gates | Reliability | `autoStartOnAssign=false` and `requireApprovalBeforeStart=true` do not push webhooks until approved/started; UI exposes the start approval action. | `src/server/audit.ts`, `dispatcher.ts`, worker/UI pipeline |
| P0 | Restrict auto-dispatch to WORKER agents and expose role | Permissions | OBSERVER/COACH never auto-dispatch; role is visible/editable in settings; manual assignment behavior is explicit. | `dispatcher.ts`, `agent.ts`, settings agents page |
| P0 | Repair webhook retry/backoff for first delivery failures | Reliability | Non-2xx/network failures retry automatically with backoff and end in DLQ after budget; admin retry remains manual override. | `src/server/worker.ts`, admin delivery tests |
| P0 | Finish notification-state schema/router migration | Stability | `pnpm typecheck` passes; tRPC no longer throws `NotificationStatus.UNREAD` undefined; mobile issue detail renders reliably. | `prisma/schema.prisma`, `src/server/services/notifications.ts`, `src/server/routers/notification.ts` |
| P1 | Harden required-ack semantics | Reliability | Ack is tied to original agent and assignment window; reassigned/completed issues do not false-noack; all qualifying comments are considered. | `required-ack.ts`, tests |
| P1 | Add per-agent permission lattice | Permissions | Agent keys can be limited to assigned issues, allowed status transitions, comment-only, no project mutations, and no arbitrary assignment. | `api-key-auth.ts`, schema/settings/MCP |
| P1 | Make dispatch target resolution immutable per delivery | Reliability | Assignment delivery cannot be sent to a new assignee after reassignment. | `audit.ts`, `worker.ts`, schema optional |
| P1 | Add operator "why dispatched" drill-down | Operator UX | Issue/agent timeline shows mode, rule, chosen agent, ineligible agents, and fallback reason. | agent timeline, issue activity, analytics UI |
| P1 | Add mobile card layouts for deliveries and agent pipeline | Mobile | Phone screenshots show readable cards/stacked lanes with no critical truncation. | deliveries page, `agent-pipeline.tsx` |
| P1 | Add mobile issue list/detail compaction | Mobile | Phone can triage/read/assign/comment without cramped desktop rows or clipped controls. | issue list/detail/topbar components |
| P1 | Add authenticated mobile Playwright matrix | Test | `390x844` and `768x1024` projects run with storage state; screenshots or overflow assertions cover core routes. | `playwright.config.ts`, tests setup/specs |
| P1 | Correct MCP docs/tool count and event reference | Docs | README/docs agree with actual 52 tools or generated catalog; event docs include `AGENT_RUN_*`; docs flag scope of `tools/list`. | README, docs/reference/mcp.md, docs/reference/events.md |
| P2 | Align quick-create/template docs with reality | Product/docs | Either quick-create supports templates/description/status/kind, or docs describe current minimal capture accurately. | quick-create, issue-template UI, docs |
| P2 | Align Sprint planning docs with router behavior | Product/docs | Draft/commit/rollover docs match implementation, or missing features are added. | `cycle.ts`, cycle UI, docs/guide/sprints.md |
| P2 | Align roadmap docs with current read-only UI | Product/docs | Drag/relink docs are removed or roadmap supports audited reorder/relink. | roadmap page, initiative/project routers, docs |
| P2 | Add touch fallback for dispatch rule reorder | Mobile | Rules can be reordered without drag/drop on touch devices. | settings dispatch-rules page |
| P2 | Decide full phone support vs degraded banner contract | Product | Product states whether phone is read-only/degraded or fully supported; tests match that contract. | shell/layout docs/tests |

Backlog count: P0 = 5, P1 = 8, P2 = 5.

## Verification Log
| Command | Result |
|---|---|
| `git status --short` | Dirty work existed before the report and remains. New audit artifacts are under `docs/audits/`. |
| `sed -n ... AGENTS.md README.md TODO.md DEVLOG.md` | Completed. |
| Docs/source/test read list | Completed by local audit plus three read-only subagents. |
| `curl -I --max-time 5 http://127.0.0.1:3000 || true` | HTTP 200, but port 3000 was an unrelated netboot.xyz UI, not Forge. |
| `PORT=3123 AUTH_URL_DEV=http:/...3123 pnpm dev:live` | Started Forge on alternate port for screenshots; logged `thread-stream` worker resolution errors and current notification tRPC errors. Stopped after capture. |
| Mobile Playwright capture | Logged in successfully and captured screenshots for all requested route classes/viewports under `docs/audits/artifacts/2026-04-26-forge-mobile/`. |
| `pnpm typecheck` | Failed due current dirty notification-state code missing Prisma generated types/models (`NotificationStatus`, `NotificationSeverity`, `notificationState`). |
| `pnpm vitest run src/server/services/__tests__/dispatcher.test.ts src/server/services/__tests__/dispatch-rule.test.ts src/server/services/__tests__/required-ack.test.ts src/server/services/__tests__/mcp.test.ts` | Failed environment setup: tests used `.env` `localhost:55432` Postgres and Redis, which were unavailable. 58 failed, 2 passed; failures were DB connection errors. |
| `pnpm exec playwright test tests/e2e/issue-flow.spec.ts --project=chromium` | Failed. Playwright config reused `localhost:3000`, which was non-Forge netboot UI; the spec also presses `c` while quick-create is `shift+c`. |
| `git diff --check` | Clean. |
| `git status --short` | Shows pre-existing dirty work plus new `docs/audits/` artifacts/report. No commit made. |

## Blockers / Unknowns
- Current worktree has notification-state changes that are not schema/generated-client complete. This blocks typecheck and caused tRPC runtime failures during mobile issue-detail recheck.
- Repo-local `.env` points at unavailable `localhost:55432` Postgres and Redis, so DB-backed tests are environment-blocked unless run against the intended compose/test services.
- Port 3000 is occupied by an unrelated netboot service, so Playwright's default `reuseExistingServer` can test the wrong app.
- Mobile screenshots used live Forge data via `dev:live` on port 3123. No production data mutations were performed beyond normal authentication/session access.
- I did not verify Hermes-side receiver/runtime behavior directly; findings are based on Forge-side contracts, docs, routes, and code.

