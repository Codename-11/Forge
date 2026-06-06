# Engagement Modes

> Set a mode when you assign or mention an agent to say *how far* you want the
> work taken. Configure the defaults in **Settings → Dispatch Rules**. The
> resolved mode rides on the `AgentRun` and shows as a chip on the run strip and
> in Mission Control.

## Why modes exist

When you hand an agent some work, the agent knows *what* you wrote — never *how
far* you want it taken. Without a mode, every dispatch surface tells the agent
essentially the same thing: *"You're assigned this issue. Work it, then
summarise."* So the agent picks the safest-for-it reading: **do the whole
thing, to its own interpretation, right now.**

That guess is wrong as often as it's right. Sometimes you want a full build.
Sometimes you only want the agent to **research** and report back, or to
**review** someone else's work, or just **weigh in** on a thread. The cost of
guessing wrong is unwanted work, accidental deviations, and — worst —
accidental deployments.

Engagement mode makes the intent explicit, defaults it sensibly per dispatch
surface, and lets you override it inline or by config. It also teaches the rest
of the system to stop assuming execution: a research pass no longer trips the
"you didn't move the issue" watchdog, and only an execute run can move status or
run the completion gates.

## The four modes

| Mode | Intent | What the agent may do | "Done" means |
|------|--------|------------------------|--------------|
| **Execute** | Do the work to completion | Edit code, transition status, open PRs/artifacts | Issue moved to review/done; `runs.complete` with artifacts; honors `artifactRequired` + `verificationChecklist` |
| **Research** | Investigate & report | Read, search, run read-only tools | A findings comment **with a confidence flag**; issue status untouched |
| **Review** | Critique existing work | Inspect a PR/diff/issue, judge it | A verdict (approve / request changes) |
| **Discuss** | Answer / weigh in | Reply in-thread, ask questions | A reply comment; no work product |

These map onto primitives Forge already has — they don't add a parallel
universe. **Research** leans on the existing confidence flag; **Review** leans
on review gates / action requests; **Execute** leans on `expectedOutput` /
`verificationChecklist` / `artifactRequired`.

::: tip "Execute, but don't deploy"
"Do the work but stop before the irreversible step" is **Execute + an
approval/review gate**, not a fifth mode. Set `requireApprovalBeforeStart` or
open a review gate on the deploy step. Deploy-safety stays orthogonal to mode,
so it composes with *all* modes.
:::

## Where the mode lives

Mode is a property of a **dispatch / run**, not of an issue — the same issue can
be researched on Monday and executed on Friday. The resolved value lives on
`AgentRun.engagementMode`, set at dispatch time, carried into the agent's
prompt, and read by the watchdog, the auto-transition logic, and Mission
Control.

This is distinct from `Workspace.autoDispatchMode` (ROUND_ROBIN /
CAPABILITY_MATCH / … — which decides *which agent gets picked*). Engagement mode
is *what the picked agent is asked to do*. Different axis.

## Defaults by surface

Defaults depend on *how* the work was dispatched — "mentions talk, assignments
act":

| Surface | Entry point | Default mode | Why |
|---------|-------------|--------------|-----|
| **Assignment** | assign an agent → `AGENT_ASSIGNED` | **Execute** | Assigning *is* handing over the work |
| **Queue / auto-dispatch** | queued issue + auto-dispatch | **Execute** | Queued = ready to be worked |
| **@-mention in a comment** | mention in a comment | **policy-driven** (below) | A mention is a tap on the shoulder, not a work order |
| **Chat** | Mission Control chat | **Discuss** | Chat is conversational by nature |
| **Goal / plan step / crew** | plan or crew dispatch | **the step's mode**, else **Execute** | A plan declares its own intent per step |
| **Watcher fan-out** | stalled / priority change / … | **awareness only** | Watchers observe; they don't get a work order |

Every default is overridable per dispatch, and the assignment + mention defaults
are configurable per workspace.

### How a bare @-mention is treated

A mention is the one surface where teams genuinely disagree, so it's a workspace
policy — `Workspace.mentionEngagementPolicy`:

- **Infer** *(default)* — no explicit marker → the agent infers intent from the
  comment, **and if it's ambiguous, asks before doing anything irreversible.**
  Maximum fluidity; the "ask first" clause is the safety net. This is the direct
  antidote to "it assumed I wanted it fully built."
- **Fixed** — always use `mentionDefaultMode` (e.g. Discuss) regardless of text.
  A mention never triggers execution unless you explicitly switch mode.
- **Require marker** — execution requires an explicit marker; otherwise the
  agent treats the mention as Discuss. "Nothing happens to my repo unless I said
  so."

**Explicit markers always win over policy**, on every surface. Two ways to set
one:

1. **Inline marker** in the composer — `@victor research:` / `@victor review:` /
   `@victor execute:`. Parsed client-side and carried in the mention payload.
2. **Mode chip in the mention popover** — after you pick the agent, a segmented
   control (the same one on the assign popover). For people who don't want to
   memorise markers.

Resolution order: explicit marker → mention policy → surface default → workspace
master default. One function, `resolveEngagementMode()`, mirrors the existing
`resolveRunEngine()` pattern.

## How the mode reaches the agent

Each mode has a canonical instruction block injected into the agent's turn (via
`RunInput.instructions`, prepended in the dispatcher) and surfaced in
`agent.context.bundle` so pull-based agents see it too. For example:

- **Research:** *"This is a research pass. Investigate and report your findings
  as a comment with a confidence flag. Do not modify code, move the issue, or
  open a PR. If you believe execution is warranted, say so and stop."*
- **Execute:** *"Take this to completion. The definition of done is in
  `expectedOutput`; verify against `verificationChecklist`."* (+ artifact /
  approval clauses when set.)

Forge also injects the shared run protocol, including a contract version:
ack the inbox item, mark output started when real work begins, use rolling
status comments only for meaningful operator-facing checkpoints, call
`runs.setWaiting` when blocked, and finish with `runs.complete`.

Mode is enforced in layers. Forge MCP rejects issue-state mutations from
active **Research**, **Review**, and **Discuss** runs; those runs can still
comment, post status, record a verdict, set themselves waiting, and complete
with their report. Codex app-server dispatches additionally force non-Execute
runs into a read-only sandbox for that turn. Hermes receives the per-run
`tool_allowlist` and runtime policy snapshot; it is host-enforced only when the
Runtime config is marked `modeToolPolicyEnforced` and the Hermes host honors
that contract. In Hermes, the policy gates local
terminal/filesystem/git-equivalent toolsets while leaving skills, memory, web,
Forge context reads, and delegation available. Delegated subagents inherit the
same disabled local toolsets. Otherwise that layer is prompt-only.

An active run's mode is immutable. To change mode, use **Stop + Restart with
Mode** from the run strip/agent card, or complete the current run and reassign
with the new mode. Forge will not relabel a running external turn in place.

## What each mode changes in the system

Mode is what stops the silent "always execute" assumptions:

- **Auto-transition on assign** (`startedStatusId`) fires **only for Execute**.
  Research / Review / Discuss leave issue status alone.
- **SLA / watchdog** applies the "must move the issue" expectation **only to
  Execute**. A Research run is "done" when it posts findings, so it's never
  falsely marked stalled for not moving the issue.
- **Completion gates** (`artifactRequired` / `verificationChecklist`) are
  enforced at `runs.complete` **for Execute**.
- **Research** completion requires findings plus `confidence` (`LOW`, `MEDIUM`,
  or `HIGH`) and no transition.
- **Review** completion requires a `verdict` (`APPROVE` or `REQUEST_CHANGES`).
- **Discuss** completion is reply-only: no produced artifacts, verification
  results, or follow-up work items. A Discuss agent that thinks work is
  warranted asks first and stops; a human (or an explicit `execute:` /
  `research:` marker) then restarts or re-dispatches.

## Configuring it

The home for the config is **Settings → Dispatch Rules**:

- the per-surface **assignment** default,
- the **mention policy** (Infer / Fixed / Require marker) and the
  `mentionDefaultMode` it falls back to.

Per-dispatch overrides live where you do the work: the segmented mode control on
the assign popover and the mention popover, and inline `research:` / `review:` /
`execute:` markers in the composer. The `forge` CLI takes
`forge issue assign <key> <agent> --mode research`.

## Where you see it

One shared glyph set (icon + tone per mode, in the spirit of the priority glyph)
is reused everywhere, with the warm-earthy tokens:

- **Assign + mention popovers** — segmented control with one-line subtext per
  option ("Take it to done" / "Investigate & report" / "Critique only" / "Just
  weigh in").
- **Issue detail — agent-run strip** — the active run's mode shows as a chip
  beside `currentStep`, with restart buttons for the other modes and compact
  enforcement/diagnostic badges.
- **Mission Control — run rows** — a mode chip per run, so you can scan for "all
  research runs" at a glance. Rows also show whether enforcement is Forge MCP,
  Codex sandbox, Hermes host, or prompt-only, plus protocol diagnostics such as
  never-acked or acked-without-output.

## Cross-references

- [Agents overview](/agents/overview.html) — the two ways to run agent work
  (direct dispatch vs. Goal orchestration), both riding on `AgentRun`.
- [Auto-dispatch](/agents/auto-dispatch.html) — queued issues default to
  Execute; how an agent gets *picked* (a different axis from mode).
- [Dispatch Rules](/agents/dispatch-rules.html) — where the mode defaults and
  mention policy are configured.
- [SLAs & Watchdogs](/agents/slas-and-watchdogs.html) — why a Research run isn't
  marked stalled for leaving the issue where it is.
- [Orchestration loop](/concepts/orchestration.html) — plan steps carry their
  own mode.
