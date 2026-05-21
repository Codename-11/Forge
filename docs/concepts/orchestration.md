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
  `totalCostUsd`.
- **ExecutionPlan** — a decompose attempt for a goal. New loop columns:
  `goalId`, `maxStepRetries` (default 2), `maxTotalCostUsd`,
  `maxWallTimeMinutes`, `totalCostUsd`, `isActiveAttempt`, `autoJudge`
  (default true).
- **ExecutionStep** — a unit of work in the plan DAG. New loop columns:
  `judgeVerdict` (JSON), `retryCount`, `lastFeedback`, `childPlanId`.
- **AgentCrew** — the roster. Members hold roles `PLANNER` / `WORKER` /
  `REVIEWER` (+ `OBSERVER` / `OPERATOR_PROXY`). The loop resolves "who
  plans / works / judges" from crew membership (lowest `position` wins).

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
plan step (`ExecutionStep.sourceRunId`) folds the cost delta into the
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

UI surfaces (sidebar **Crews**, chord `g u`):

- **`/w/<slug>/crews`** — the crew index: each crew with its avatar
  stack, role breakdown (e.g. "1 planner · 3 workers · 1 reviewer"), and
  parallel cap. Heavy create/archive CRUD still lives under
  `/settings/crews`.
- **`/w/<slug>/crews/<crewId>`** — the crew detail: roster with live
  presence + "what each member is running right now" (active RUNNING /
  REVIEW steps on this crew's plans), inline add / change-role / remove,
  goal history (every goal the crew has run, linked to its goal page),
  and aggregate stats (goals run, success rate = ACHIEVED / total, avg
  cost per goal, avg steps per plan — all computed server-side via
  `agentCrew.detail` / `stats` / `goalHistory`).

A crew can be assigned to a goal at creation: the **New goal** form on
`/w/<slug>/goals` includes a crew picker (`CrewSelector`).
