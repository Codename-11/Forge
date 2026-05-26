# Orchestration loop

> The multi-agent orchestrator-judge loop: a Goal is decomposed into an
> ExecutionPlan by a PLANNER, approved by an operator, dispatched to
> WORKER agents step-by-step, and judged by a REVIEWER — with retries,
> budgets, and human review gates wired throughout.

This builds on the orchestration substrate (ExecutionPlan / ExecutionStep
DAG, AgentCrew, ContextSet, ReviewGate, ActionRequest). It adds the
**Goal** model plus the loop automation that ties the pieces together.

## Primitives

- **Goal** — the top-level objective. Owns one or more `ExecutionPlan`
  attempts; exactly one is `isActiveAttempt`. Status:
  `OPEN → PLANNING → ACTIVE → ACHIEVED` (or `ABANDONED`). Carries optional
  budgets `maxTotalCostUsd` / `maxWallTimeMinutes` and accumulated
  `totalCostUsd`. Optionally sits under an **Initiative** via nullable
  `initiativeId`, so a quarterly bet can group the goals that pursue it
  alongside its projects.
- **ExecutionPlan** — a decompose attempt for a goal. New loop columns:
  `goalId`, `maxStepRetries` (default 2), `maxTotalCostUsd`,
  `maxWallTimeMinutes`, `totalCostUsd`, `isActiveAttempt`, `autoJudge`
  (default true).
- **ExecutionStep** — a unit of work in the plan DAG. New loop columns:
  `judgeVerdict` (JSON), `retryCount`, `lastFeedback`, `childPlanId`.
- **AgentCrew** — the roster. Members hold roles `PLANNER` / `WORKER` /
  `REVIEWER` (+ `OBSERVER` / `OPERATOR_PROXY`). The loop resolves "who
  plans / works / judges" from crew membership (lowest `position` wins).

## How a goal runs

A **goal** is an automated loop that runs to completion — not a static
checklist you tick off by hand. You state the objective, approve the plan,
and the crew drives it through to "achieved" on its own, within the budget
and time caps you set.

1. **Objective** — You state a high-level goal and (optionally) assign a
   crew to run it.
2. **Plan** — The crew's planner decomposes the goal into a
   dependency-ordered set of steps.
3. **Approve** — You review the proposed plan and approve it. Nothing runs
   until you do.
4. **Execute** — Workers pick up steps as their dependencies clear and run
   them in parallel.
5. **Review** — A reviewer judges each finished step. A pass advances the
   plan; a fail sends it back with feedback to retry.
6. **Achieved** — When every step passes, the goal completes. Budget and
   time caps stop runaway loops automatically.

### Use cases

- A **multi-step migration** run by a crew: design schema → write
  migration → wire the API → add tests, each step gated on the last.
- A **research-then-write** goal: gather sources, synthesize findings, then
  draft the writeup — the draft step waits on the research steps.
- A **refactor where a reviewer enforces a quality bar**: failing steps
  bounce back with feedback and retry automatically until they pass.
- A **one-off goal kicked off from an issue** via `/goal <objective>` in
  the issue, when you don't need a standing crew.

## Steps, runs, and issues

A Goal is one of [**two ways to run agent work**](/agents/overview.html) — the
autonomous one. The other is direct dispatch (assign an agent to an issue). The
two are different ways to *start* work, but they share the same observable
substrate, so orchestrated work isn't a black box:

- **Each step that starts running opens a real `AgentRun`.** When a step
  becomes `READY` and a worker is dispatched, the loop opens (or touches) an
  `AgentRun` linked to the step via `AgentRun.executionStepId`. That means a
  Goal's work shows up in Mission Control, counts toward the agent's load, gets
  a [engagement-mode](/agents/engagement-modes.html) chip, and is watched by the
  same stalled-run / cost logic as any directly-dispatched run. (Earlier, Goal
  steps dispatched a fire-and-forget webhook and were invisible to all of that.)

- **A step can be materialized into a real Issue.** Any plan step can be turned
  into a tracked `Issue` (`ExecutionStep.issueId`), carrying its `expectedOutput`
  and verification checklist across. The issue then lives on the board and in
  the sprint like any other work, while still belonging to the plan. This is the
  "Plan if you want to" path: keep a step as pure plan scaffolding, or promote it
  to a first-class issue when you want it tracked, assignable, and visible
  outside the plan view. Materializing is idempotent — a step points at exactly
  one issue.

So planning, issues, and runs are one connected graph: a Goal owns a plan, a
plan's steps can become issues, and running a step opens a run — all linked, all
visible in the same surfaces.

## The loop

```
            goals.create
                 │
                 ▼
            ┌─────────┐
            │  OPEN   │
            └────┬────┘
                 │ plans.decompose  (picks PLANNER; creates DRAFT plan)
                 ▼
            ┌──────────┐   PLANNER dispatched via webhook + event
            │ PLANNING │──────────────────────────────────────────┐
            └────┬─────┘                                           │
                 │ plans.addSteps  (PLANNER fills the DRAFT plan)  │
                 │ plans.requestApproval  → ActionRequest (FREE_FORM,
                 │                          sourceType=execution-plan)
                 ▼
        operator Accepts the ActionRequest
                 │  (actionRequest.accept → activatePlan)
                 ▼
            ┌─────────┐   plan DRAFT → RUNNING, goal → ACTIVE,
            │ ACTIVE  │   startedAt stamped, root steps cascade READY
            └────┬────┘
                 │
                 ▼
      ┌───────────────── step lifecycle ─────────────────┐
      │                                                   │
      │  TODO ──(all deps DONE)──▶ READY ──(worker)──▶ RUNNING
      │                              ▲                     │
      │                              │                     ▼
      │                       (FAIL, retries left)      REVIEW
      │                       retryCount++,                │
      │                       lastFeedback stored      (autoJudge or
      │                              │                  plans.judge)
      │                              │                     ▼
      │                              └──────────────── recordVerdict
      │                                                    │
      │                          ┌── PASS ──▶ DONE ──▶ cascade readiness
      │                          │                       (dependents → READY)
      │                          └── FAIL (retries        │
      │                              exhausted) ──▶ BLOCKED + ReviewGate
      │                                                    │
      └────────────────────────────────────────────────────┘
                 │
                 │ (every step DONE)
                 ▼
            ┌──────────┐
            │ ACHIEVED │   plan → COMPLETED, goal → ACHIEVED, achievedAt
            └──────────┘
```

### Step lifecycle (exact)

```
TODO → READY     all dependsOnStepIds are DONE
     → RUNNING   worker dispatched (worker flips this itself)
     → REVIEW    worker posted output; awaiting judge
     → DONE       judge PASS
     → READY      judge FAIL + retries remain (retryCount++)
     → BLOCKED    judge FAIL + retries exhausted (+ ReviewGate opened)
```

No new `ExecutionStepStatus` values — the existing enum
(`TODO | READY | RUNNING | BLOCKED | REVIEW | DONE | CANCELED`) is reused.

### Readiness cascade

When a step reaches `DONE` (via `plans.recordVerdict` PASS **or** a manual
`executionPlans.transitionStep` to DONE), the plan re-evaluates every
`TODO` step: any whose `dependsOnStepIds` are now all `DONE` flip to
`READY`, which resolves a worker and dispatches it. This cascade is
transactional with the status change.

### Worker dispatch payload

A step entering `READY` emits `EXECUTION_STEP_READY` and queues a webhook
delivery to the resolved worker (explicit `assignedAgentId`, else the
crew's `WORKER`). The event payload carries:

```jsonc
{
  "planId": "...",
  "stepId": "...",
  "title": "...",
  "body": "...",
  "expectedOutput": "...",
  "verification": [ /* completion-contract checklist */ ],
  "contextSetId": "...",      // the plan's shared ContextSet
  "assignedAgentId": "...",
  "lastFeedback": "...",       // populated on a retry dispatch
  "retryCount": 1
}
```

### judgeVerdict JSON shape (contract)

`ExecutionStep.judgeVerdict` and the `plans.recordVerdict` write store:

```jsonc
{
  "verdict": "PASS" | "FAIL",
  "feedback": "string",
  "score": 0.0,                 // optional, 0..1
  "judgedByAgentId": "agent_…", // optional (set when an agent key judges)
  "judgedAt": "2026-05-20T…Z"
}
```

### Budgets + watchdog

Each `runs.recordUsage` call that records a `costUsd` and is tied to a
plan step (resolved via the run's `executionStepId` FK, falling back to
the older `ExecutionStep.sourceRunId`) folds the cost delta into the
step's `plan.totalCostUsd` **and** the `goal.totalCostUsd`. When a
RUNNING plan exceeds `maxTotalCostUsd` or `maxWallTimeMinutes`, the plan
flips to `BLOCKED`, emits `PLAN_BUDGET_EXCEEDED`, and opens a ReviewGate
("Budget exceeded — approve continuation or abandon").

## Agent-facing MCP sequence

A typical PLANNER → WORKER → REVIEWER run:

```
# 1. Operator (or agent) creates the goal
goals.create({ title, crewId, maxTotalCostUsd: 5 })           → { id: goalId }

# 2. Kick off decomposition — picks the crew PLANNER, creates a DRAFT plan,
#    dispatches the planner, flips the goal to PLANNING.
plans.decompose({ goalId })                                   → { planId, status: "PLANNING" }

# 3. PLANNER authors steps (index-based deps).
plans.addSteps({ planId, steps: [
  { title: "Design schema", expectedOutput: "schema.sql" },
  { title: "Write migration", dependsOnStepIndexes: [0] },
  { title: "Wire the API", dependsOnStepIndexes: [1] },
] })                                                          → { stepIds: [...] }

# 4. PLANNER asks the operator to approve.
plans.requestApproval({ planId })                            → { actionRequestId }

# 5. Operator Accepts the ActionRequest (UI or actionRequests.accept).
#    → plan DRAFT → RUNNING, goal → ACTIVE, root steps dispatch.

# 6. A WORKER picks up an EXECUTION_STEP_READY dispatch, does the work,
#    then flips the step to REVIEW:
executionPlans.transitionStep({ stepId, status: "REVIEW" })

#    If the plan has autoJudge=true and a REVIEWER exists, a judge is
#    dispatched automatically. Otherwise:
plans.judge({ stepId })                                       → { judgeAgentId }

# 7. The REVIEWER evaluates and records a verdict:
plans.recordVerdict({ stepId, verdict: "PASS", feedback: "meets contract", score: 0.95 })
#    PASS → step DONE → cascade → dependents become READY → dispatch.
#    FAIL → retry (READY + retryCount++ + lastFeedback) or BLOCKED + gate.

# When every step is DONE, the plan COMPLETEs and the goal is ACHIEVED.
```

Crew management (admin-scoped):

```
agentCrews.create({ name, members: [{ agentId, role: "PLANNER" }] })
agentCrews.addMember({ crewId, agentId, role: "WORKER" })
agentCrews.setMemberRole({ memberId, role: "REVIEWER" })
agentCrews.removeMember({ memberId })
agentCrews.update({ id, name, maxParallel })
agentCrews.archive({ id })
```

## Crews

A **crew** is a reusable, standing team — distinct from a *plan run*,
which is a single decompose-and-execute pass against one goal. The crew
is the roster (who can plan / work / review); the plan run is the work.
One crew runs many goals over its lifetime; each goal/plan points back at
its crew via `Goal.crewId` / `ExecutionPlan.crewId`. `maxParallel` caps
how many of the crew's steps run simultaneously.

The loop resolves roles from crew membership: the PLANNER decomposes, a
WORKER executes each READY step, a REVIEWER judges steps that enter
REVIEW (when `autoJudge` is on). The same agent can hold multiple roles
on one crew.

### Roles

Every crew member holds one or more roles. These are the one-line
summaries shown in the product's role picker:

- **Planner** — Breaks the goal into an ordered plan of steps. (The brain
  of the crew; you approve its plan before any work begins.)
- **Worker** — Executes the plan's steps and reports results. (The hands;
  runs steps in parallel up to the crew's parallel cap.)
- **Reviewer** — Judges each finished step — pass to advance, fail to
  retry. (The quality gate; a fail sends the step back with feedback.)
- **Observer** — Watches the run without acting. (Read-only; never
  assigned steps.)
- **Operator proxy** — Stands in for you — can approve gates while you're
  away. (A human stand-in so the loop keeps moving.)

UI surfaces (sidebar **Crews**, chord `g u`):

- **`/w/<slug>/crews`** — the crew index: each crew with its avatar
  stack, role breakdown (e.g. "1 planner · 3 workers · 1 reviewer"), and
  parallel cap. **Create a crew right here** with the **New crew** button,
  which opens a modal with a role-explaining picker. `/settings/crews`
  still exists for heavier management, but it's the secondary path — not
  where you go to create.
- **`/w/<slug>/crews/<crewId>`** — the crew detail: roster with live
  presence + "what each member is running right now" (active RUNNING /
  REVIEW steps on this crew's plans), inline add / change-role / remove,
  goal history (every goal the crew has run, linked to its goal page),
  and aggregate stats (goals run, success rate = ACHIEVED / total, avg
  cost per goal, avg steps per plan — all computed server-side via
  `agentCrew.detail` / `stats` / `goalHistory`).

A crew can be assigned to a goal at creation: the **New goal** form on
`/w/<slug>/goals` includes a crew picker (`CrewSelector`).
