# Dispatch Rules

Declarative routing evaluated *before* mode-based selection — the right
agent for the right kind of issue, no scripting required.

Where [auto-dispatch](/agents/auto-dispatch.html) picks an agent based on
runtime state (round-robin order, capability overlap), dispatch rules let
you state policy directly: "this kind of issue goes to this agent." Rules
fire first; if none match, the configured mode takes over.

## The model

```prisma
model DispatchRule {
  id            String     @id @default(cuid())
  workspaceId   String
  order         Int
  active        Boolean    @default(true)
  // Conditions — all optional, AND-ed together.
  priority      Priority?  // NONE | LOW | MEDIUM | HIGH | URGENT
  labelId       String?
  projectId     String?
  // Target — the agent that picks up the issue when the rule fires.
  targetAgentId String
  createdAt     DateTime   @default(now())
}
```

A rule has up to three conditions: `priority`, `labelId`, `projectId`. Each
is independently optional — `null` means wildcard. All present conditions
are AND-ed: a rule with `priority = URGENT` and `projectId = ops` matches
issues that are URGENT **and** in the `ops` project.

A rule with all three conditions null is a catch-all and will fire on every
queued issue. That's almost always a configuration mistake; the UI warns
when you save one.

## Evaluation order

Rules are evaluated in a single pass:

1. Load all `active` rules for the workspace.
2. Sort by `order ASC, createdAt ASC` (the explicit order column wins; ties
   broken by creation time so older rules sit above newer ones with the
   same `order`).
3. Walk the list and pick the first rule whose conditions all match.
4. If a rule matches, attempt to dispatch to its `targetAgentId`.
5. If no rule matches, fall through to mode-based selection.

::: info
First match wins. There is no "best match"; ordering is the operator's
responsibility. Drag rules to reorder them in Settings → Dispatch Rules.
:::

## Eligibility fallback

A matching rule does **not** stall the queue if its target is ineligible.
If the target is offline, archived, or at `maxConcurrent`, the dispatcher
records the rule as having matched but falls through to mode-based
selection — picking the same way it would have if no rule had matched.

The decision-provenance reason captures both halves:

```
rule:dr_01HX:target-ineligible,round-robin pick
```

Read that as "rule `dr_01HX` matched but target was ineligible; fell
through to round-robin." The full rule id is preserved so you can pull it
up in the UI and decide whether to add a backup rule, raise the target's
`maxConcurrent`, or change ordering.

::: warning
Eligibility is checked at dispatch time, not at rule-save time. Saving a
rule that targets an offline agent is fine; the rule just won't fire while
the agent is offline.
:::

::: info Run controls and dispatch
The dispatcher also respects active `AgentRun.controlState`. An agent
with a `PAUSE_REQUESTED` or `CANCEL_REQUESTED` run is treated as
ineligible for new work until the runtime acks the request and the
state returns to `NONE`. Operators can pause an agent in flight without
worrying that auto-dispatch will silently route more work to it. See
[Agents → Overview → Run controls](/agents/overview.html#agent-run-controls).
:::

## Where to manage rules

Settings → Dispatch Rules. The page lets you:

- **List** all rules with current ordering, conditions, target, and
  active state.
- **Create** a new rule from a small form (priority dropdown, label
  picker, project picker, agent picker).
- **Update** any field on an existing rule.
- **Reorder** by drag-and-drop. The new `order` is persisted on drop.
- **Toggle active** — flip a rule off without deleting it.
- **Delete** — permanent.

All four operations write audit rows and emit `ActivityEvent` entries, so
"who made this change" is captured.

## Worked examples

### 1. All bugs labelled `infra` go to victor

```bash
# Assumes: lbl_bug, lbl_infra, agt_victor
curl -sS https://forge.example/api/trpc/dispatchRules.create \
  -H "Content-Type: application/json" \
  -H "Cookie: $SESSION" \
  -d '{
    "json": {
      "workspaceId": "wks_axi",
      "order": 10,
      "labelId": "lbl_infra",
      "targetAgentId": "agt_victor"
    }
  }'
```

::: details Why a single label condition?
This rule routes anything tagged `infra`, regardless of priority or project.
If you want to narrow further — say, only `infra` issues that are also
`bug` — you have two options:

- Add a separate `bug` label and chain two rules with the same target.
- Use a single more-specific label (e.g. `infra-bug`) on the rule.

Forge currently supports a single label condition per rule. Multi-label
rules are on the roadmap.
:::

### 2. All URGENT issues in project OPS go to oncall

```json
{
  "workspaceId": "wks_axi",
  "order": 5,
  "priority": "URGENT",
  "projectId": "prj_ops",
  "targetAgentId": "agt_oncall"
}
```

`order: 5` puts this rule above the `infra` rule (which sits at `order: 10`).
That's intentional: an URGENT infra issue in OPS should reach the on-call
agent, not the default infra owner. First match wins.

### 3. All issues in project RESEARCH go to mizu

```json
{
  "workspaceId": "wks_axi",
  "order": 50,
  "projectId": "prj_research",
  "targetAgentId": "agt_mizu"
}
```

A project-only rule. Mizu owns research without further qualification.

### 4. URGENT bugs that are also frontend go to a specialist

```json
{
  "workspaceId": "wks_axi",
  "order": 1,
  "priority": "URGENT",
  "labelId": "lbl_frontend",
  "targetAgentId": "agt_aria"
}
```

`order: 1` puts this above everything else. URGENT + frontend short-circuits
the rest of the rule chain and reaches Aria.

## Rule-design tips

- **Use orders in tens.** Numbering rules `10, 20, 30, ...` leaves room to
  insert new rules between them without re-numbering. The drag-to-reorder
  UI handles this automatically, but if you create rules via API it's a
  good convention.
- **Put narrow rules above broad rules.** The matcher is first-match-wins,
  not best-match. A catch-all "everything to victor" rule at `order: 1`
  shadows everything below it.
- **Prefer mode-based dispatch for fungible work.** If your team's agents
  are interchangeable for most issues, leave `autoDispatchMode` doing the
  routing and only use rules for genuinely policy-driven exceptions.
- **Audit ineligible-fallback events.** A rule that frequently records
  `target-ineligible` is a sign the target is undersized — bump
  `maxConcurrent` or add a backup target via a lower-priority rule.

## Cross-references

- [Auto-dispatch](/agents/auto-dispatch.html) — the mode-based fallback
  that runs when no rule matches (or a matched rule's target is
  ineligible).
- [Agents → Overview](/agents/overview.html) — the eligibility filter
  rules share with the dispatcher.
- [Concepts → Activity & Audit](/concepts/activity-and-audit.html) — where
  rule-firing decisions are written.
