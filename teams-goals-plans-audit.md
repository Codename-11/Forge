# Teams / Goals / Plans production audit

Audit time: 2026-07-11 15:59 EDT
Production build: `68d59d5` (`forge` and `forge-worker`)
Mode: read-only production database, worker logs, deployed-source trace, and
Firefox capture against an isolated production-data snapshot

## Scope

Trace the active production goal from crew composition through plan activation,
step dispatch, run completion, judging, downstream readiness, watchdog coverage,
notifications, and the operator-facing Goal / Plan surfaces.

The signed-in flow was captured in Firefox at 1600 × 1200 against an isolated
snapshot of production data. The temporary database and local app server were
removed after capture. The screenshots preserve the live record state without
making a production mutation.

## Visual evidence

- `01-crews-list.png` — crew index
- `02-dev-team.png` — Dev-Team roster and goal history
- `03-goals-list.png` — goal index
- `04-active-goal.png` — active Rich Rendering goal
- `05-plans-list.png` — plan index
- `06-running-plan.png` — running plan and first READY step
- `07-axi-84.png` — AXI-84 header, Done status, no active run, and plan link
- `07b-axi-84-completion-note.png` — successful completion note while AXI-84 is
  Done and the issue rail reports no active run
- `08-inbox.png` — Inbox with no goal/plan recovery signal and an empty Agent
  queue

All files are saved under
`/home/bailey/.codex/audits/forge-teams-goals-plans-2026-07-11/` and were opened
and inspected before acceptance. The first Goals/Plans captures caught the
staggered entry animation mid-fade and were rejected; the accepted files above
were recaptured after the screen stabilized.

## Production incident

Goal: **Enhance Issues to support Rich Rendering**
Goal id: `cmqfu0tdg003pqt07yf8x1ynj`
Goal status: `ACTIVE` since 2026-06-18
Plan: **Plan for: Enhance Issues to support Rich Rendering**
Plan id: `cmqjkctwa0003mo07aonmhg1j`
Plan status: `RUNNING`; `startedAt` is null
Crew: **Dev-Team** — Victor / PLANNER, Codex / WORKER, no REVIEWER

The first step, **Audit current issue content rendering paths**, is still
`READY`. Its materialized issue AXI-84 is `DONE`, and its latest step-bound run
completed successfully on 2026-07-08 17:01 UTC with a valid Forge completion
contract and all four verification checks marked done. There are no ACTIVE or
WAITING runs on the plan. The remaining five steps stay `TODO` because they all
depend directly or transitively on the first step becoming `DONE`.

No production mutation was made.

## Root cause

This is a state-machine split, not an agent outage:

1. A plan step becoming `READY` opens a step-bound `AgentRun` and, for a
   runtime-only worker, materializes an Issue.
2. The runtime dispatcher starts that run from the Issue record and gives the
   agent the normal Issue/run completion contract. It does not include the
   orchestration step id or instruct the worker to transition the step to
   `REVIEW`.
3. `runs.complete` closes the `AgentRun` and may move the Issue to the workspace
   review status, but it does not update the linked `ExecutionStep`.
4. Downstream readiness only advances when the step becomes `DONE`, normally
   through `plans.recordVerdict(PASS)` or a manual step transition.

The production run therefore completed exactly as instructed while the plan
continued to treat the step as queued.

## Additional wedge paths

- **Missing reviewer:** Dev-Team has no REVIEWER. Even if successful run
  completion moved the step to `REVIEW`, auto-judge would silently no-op and no
  durable gate or operator request would be created.
- **Watchdog blind spot:** the orchestration watchdog only scans RUNNING plans
  with a non-null wall-time cap. This plan has no cap, so it is never examined.
  Even inside the scan, a `READY` step counts as in-flight without confirming an
  ACTIVE/WAITING run exists.
- **No stalled-plan signal:** no `PLAN_STALLED` event exists. The notification
  mapper handles budget breaches and retry-exhausted judged steps, but normal
  run completion, ready steps, and non-terminal goal transitions intentionally
  create no NotificationState. The July 8 ready/start/completed events produced
  zero notifications.
- **Issue/step drift:** a materialized Issue can reach `DONE` while its source
  step remains non-terminal; there is no synchronization path in either
  direction.
- **Manual completion gap:** manually setting the last step to `DONE` cascades
  readiness but does not call the plan/goal completion reconciliation used by
  judge PASS.
- **Free-form plan status:** the Plan status control can write statuses directly
  without enforcing valid transitions or synchronizing Goal/step/run state.
- **Legacy timing gap:** this active plan predates `ExecutionPlan.startedAt` and
  has no backfilled value, so the Plan UI cannot show elapsed time and an added
  wall-time cap would fall back to `createdAt` server-side.

## Flow audit

1. **Crew setup — unhealthy.** `01-crews-list.png` and `02-dev-team.png` show a
   crew presented as active/valid with one planner and one worker, but no
   REVIEWER and no missing-role warning. Dev-Team simultaneously labels Codex
   `ready` and the goal history `ACTIVE` while its summary says `idle`.
2. **Goal activation — partially healthy.** The Goal and Plan transitioned to
   ACTIVE/RUNNING and the root step dispatched. Legacy `startedAt` is missing,
   weakening time-based visibility.
3. **Worker execution — healthy.** `07b-axi-84-completion-note.png` visibly shows
   the delivered implementation note, Done issue status, and `no active run`.
   Database evidence confirms the run acknowledged, recorded four completed
   checks, and closed cleanly in about two minutes.
4. **Run-to-step handoff — broken (P0).** Successful completion did not move the
   linked step to REVIEW or store it as the step's source run.
5. **Review/judging — broken (P1).** No reviewer exists and that condition
   creates neither a gate nor an operator-facing action.
6. **Dependency cascade — blocked by design.** The next step correctly waits for
   the first step to become DONE; the upstream handoff never reaches that state.
7. **Watchdog/recovery — broken (P1).** The plan is RUNNING with no live work,
   but an unlimited plan is excluded and READY is treated as proof of in-flight
   work.
8. **Notifications — broken for this failure mode (P1).** The system records
   normal activity events but has no alertable event representing a plan whose
   execution state contradicts its run state.
9. **Goal UI — misleading (P1).** `04-active-goal.png` simultaneously says
   `Queued for pickup`, `waiting for acknowledgement`, `RUNS 1 done`, and
   `ELAPSED 33439m`. The active border and highlighted Codex row reinforce a
   false live state; no warning or recovery action appears.
10. **Plan UI — insufficient recovery (P1).** `05-plans-list.png` labels the plan
    RUNNING and only says `Updated 3d`. `06-running-plan.png` shows 0/6 done,
    step one READY, a highlighted worker, and a direct status selector, but no
    completed-run diagnosis, stale age, missing reviewer warning, or safe
    reconciliation action.
11. **Issue UI — locally truthful but systemically disconnected (P1).**
    `07-axi-84.png` and `07b-axi-84-completion-note.png` correctly show Done,
    `no active run`, the delivered result, and `From plan · step 1`. Nothing on
    the Issue warns that the linked step still says READY.
12. **Inbox — blind to the incident (P1).** `08-inbox.png` shows nine focus
    issues, five stale personal issues, one unrelated stalled agent run, and an
    Agent queue of zero. The active stalled plan is absent, leaving the operator
    with no notification or recovery path from the daily work surface.

## Accessibility and state-communication risks

- The contradictory state is conveyed through several small badges and metric
  tiles without a single status summary that assistive technology can announce.
- Realtime changes are visually refreshed, but the inspected Goal and Plan
  surfaces do not expose an obvious live-region announcement for lifecycle
  changes. This needs screen-reader verification; screenshots alone cannot
  confirm announcement behavior.
- Color is not the only state cue—text labels are present—but orange active/
  ready treatments visually imply healthy motion even when no run exists.
- The Plan status control permits consequential lifecycle edits from a compact
  selector without explaining downstream effects or presenting an error-
  recovery model.
- Keyboard order and focus visibility were not exhaustively tested in this
  capture pass. Responsive reflow below 1600 px was also outside this incident-
  focused audit.

## Recommended repair order

1. **Make run completion and step handoff atomic.** When `runs.complete` closes a
   run with `executionStepId`, set `sourceRunId`, transition READY/RUNNING to
   REVIEW, record the step event, and invoke auto-judge after commit. Make it
   idempotent and reject contradictory terminal rewrites.
2. **Create a real orchestration reconciler.** Scan every RUNNING plan and compare
   step state with live/latest runs, materialized Issue state, dependency
   readiness, and crew role coverage. Reconcile safe cases; raise durable action
   requests for ambiguous ones.
3. **Add `PLAN_STALLED`.** Emit one state-based, deduplicated event with reason
   codes such as `completed_run_nonterminal_step`, `ready_without_live_run`,
   `review_without_reviewer`, or `no_ready_root`. Materialize a persistent
   notification linking directly to the Goal/Plan recovery surface.
4. **Validate crews before activation.** Require a reachable worker for each root
   step and either a REVIEWER or an explicit human-review policy when autoJudge
   is enabled. Missing coverage should block activation or create an explicit
   operator gate.
5. **Derive UI health from reconciled state.** Replace “Queued for pickup” when
   the latest run is terminal; show last progress age, missing reviewer, and the
   exact recovery action. Surface stale health on Goal, Plan, Crew, Dashboard,
   and Command Center consistently.
6. **Constrain manual transitions.** Route Goal/Plan/Step status changes through
   the same lifecycle service so terminal state, dependencies, runs, and parent
   records cannot drift.
7. **Backfill legacy `startedAt`.** Use activation events or Goal start time for
   existing RUNNING plans.

## Safe recovery for the current production goal

After the lifecycle fix is deployed, reconcile the first step from its clean
completed run into REVIEW. Because Dev-Team has no REVIEWER, either add a
reviewer or open a human review gate. A PASS can then mark the step DONE and
dispatch the second step. Do not simply retry AXI-84 again; the work already
completed and another retry would repeat output without repairing the plan.
