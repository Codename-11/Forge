# Engagement Modes

> **Status: shipped (2026-05-26).** Set a mode when you assign or mention an
> agent; configure defaults in **Settings → Dispatch Rules**. Modes ride on the
> `AgentRun` and are surfaced as a chip on the run strip + Mission Control.

## The problem

When you hand an agent some work, the agent only knows *what* you wrote —
never *how far you want it taken*. Today every dispatch surface tells the
agent essentially the same thing: *"You are assigned issue FRG-42. Work the
issue using your tools, then summarise what you did."*
(`run-dispatcher.ts:34`). So the agent assumes the safest-for-it default:
**do the whole thing, to its own interpretation, right now.**

That assumption is wrong as often as it's right. Sometimes you want a full
build. Sometimes you only want the agent to **research** and report back.
Sometimes you want it to **review** someone else's work, or just **weigh in**
on a thread. The cost of guessing wrong is exactly what you flagged:
unwanted work, accidental deviations, and — worst — accidental deployments.

The whole system currently bakes in the EXECUTE assumption in places that
aren't obvious:

- **Auto-transition** flips an assigned issue to *In Progress* /
  `startedStatusId` on assignment — even if you only wanted research.
- **SLA / watchdog** marks a run **STALLED** if it doesn't move the issue out
  of TODO within `assignmentSlaMinutes` — but a research pass *shouldn't* move
  the issue at all.
- **`artifactRequired` / `verificationChecklist`** are completion gates that
  only make sense for execution.

**Engagement mode** makes the intent explicit, defaults it sensibly per
dispatch surface, lets you override it inline or by config, and teaches the
rest of the system to stop assuming EXECUTE.

## The four modes

| Mode | Intent | What the agent may do | "Done" means | Pairs with |
|------|--------|------------------------|--------------|------------|
| **`EXECUTE`** | Do the work to completion | Edit code, transition status, open PRs/artifacts | Issue moved to review/done; `runs.complete` with artifacts; honors `artifactRequired` + `verificationChecklist` | approval gates, review gates |
| **`RESEARCH`** | Investigate & report | Read, search, run read-only tools | A findings comment **with a confidence flag**; issue status untouched | `ConfidenceLevel`, artifacts as references |
| **`REVIEW`** | Critique existing work | Inspect a PR/diff/issue, judge it | A verdict (approve / request changes) | `reviewGates.*`, `actionRequests.*` |
| **`DISCUSS`** | Answer / weigh in | Reply in-thread, ask questions | A reply comment; no work product | `suggestedReplies`, chat |

These map onto primitives we already have — they don't add a parallel
universe. `RESEARCH` leans on the existing `ConfidenceLevel`; `REVIEW` leans
on `reviewGates`/`actionRequests`; `EXECUTE` leans on
`expectedOutput`/`verificationChecklist`/`artifactRequired`.

> **EXECUTE but don't deploy.** "Do the work but stop before the irreversible
> step" is **`EXECUTE` + an approval/review gate**, not a fifth mode. Set
> `requireApprovalBeforeStart` or open a review gate on the deploy step. Keeping
> deploy-safety orthogonal to mode means it composes with *all* modes and we
> don't fork the enum every time a new "stop here" point appears.

## Where the mode lives

Mode is a property of a **dispatch / run**, not of an issue — the same issue
can be researched on Monday and executed on Friday. So the resolved value
lives on **`AgentRun.engagementMode`** (new column, `@default(EXECUTE)`), set
at dispatch time, carried into the prompt, and read by the watchdog, the
auto-transition logic, and Mission Control.

> **Naming:** this is `engagementMode`, distinct from
> `Workspace.autoDispatchMode` (ROUND_ROBIN / CAPABILITY_MATCH / … — which
> agent gets *picked*) and from `dispatchReason.mode` (a mirror of the
> selection strategy). Engagement mode is *what the picked agent is asked to
> do*. Different axis; keep the names apart in code and copy.

## Default by surface

You asked for defaults that depend on *how* the work was dispatched. They do.
This is the heart of the design — "mentions talk, assignments act":

| Surface | Entry point | Default mode | Rationale |
|---------|-------------|--------------|-----------|
| **Assignment** | `issues.assign` → `AGENT_ASSIGNED` | **`EXECUTE`** | Assigning *is* handing over the work |
| **Queue / auto-dispatch** | `issues.setQueued` + `autoDispatch` | **`EXECUTE`** | Queued = ready to be worked |
| **@-mention in a comment** | `COMMENT_CREATED` + `mentions.agentIds` | **policy-driven** (see below) | A mention is a tap on the shoulder, not a work order |
| **Chat** | `CHAT_MESSAGE_POSTED` | **`DISCUSS`** | Chat is conversational by nature |
| **Goal / plan step / crew** | plan/crew dispatch | **inherits the step's mode**, else `EXECUTE` | A plan declares its own intent per step |
| **Watcher fan-out** | `ISSUE_STALLED`, priority change, … | **no work** (awareness only) | Unchanged — watchers observe, they don't get a work order |

### The mention question (your call to make)

For @-mentions specifically you asked: *infer unless explicitly stated? let
the agent decide, add an explicit marker, or both — as a config option?* The
answer is **a workspace policy that picks between those**, so different teams
get different behaviour:

`Workspace.mentionEngagementPolicy`:

- **`INFER`** *(proposed default)* — no explicit marker → the agent is told to
  infer intent from the comment, **and if it's ambiguous, ask before doing
  anything irreversible.** Maximum fluidity; the safety net is the "ask first"
  clause. This is the direct antidote to "it assumed I wanted it fully built."
- **`FIXED`** — always use `mentionDefaultMode` (e.g. `DISCUSS`) regardless of
  text. Most conservative; a mention never triggers execution unless the
  human explicitly switches mode.
- **`REQUIRE_MARKER`** — execution requires an explicit marker; otherwise the
  agent treats it as `DISCUSS`. "Nothing happens to my repo unless I said so."

**Explicit markers always win over policy**, on every surface. Two ways to set
one, both supported (the "both" you wanted):

1. **Inline marker** in the comment composer — `@victor research:` /
   `@victor review:` / `@victor execute:`. Parsed client-side like the
   existing chat slash-commands (`src/lib/chat-slash-commands.ts`), carried in
   the payload as `mentions: { agentId, mode }`.
2. **Mode chip in the mention popover** — after you pick the agent, a small
   segmented control (the same one used on the assign popover). For people who
   don't want to memorise markers.

So: explicit marker → policy (`INFER` / `FIXED` / `REQUIRE_MARKER`) → surface
default → workspace master default. One resolution function,
`resolveEngagementMode()`, mirrors the existing `resolveRunEngine()` pattern
(`dispatch/registry.ts`).

## How the mode reaches the agent

Two levels, shipped in order:

### Phase 1 — guidance (prompt injection)

Each mode has a canonical instruction block injected into the agent's turn via
the **`RunInput.instructions`** field (defined in `dispatch/types.ts` and
currently unused — this is its first consumer) and prepended in
`run-dispatcher.ts`'s `issueMessage()`. Also surfaced in
`agent.context.bundle` so pull-based agents see it. Sketch:

- **`RESEARCH`:** *"This is a research pass. Investigate and report your
  findings as a comment with a confidence flag. Do **not** modify code, move
  the issue, or open a PR. If you believe execution is warranted, say so and
  stop."*
- **`EXECUTE`:** *"Take this to completion. The definition of done is in
  `expectedOutput`; verify against `verificationChecklist`. "* (+ artifact /
  approval clauses when set.)
- **`REVIEW` / `DISCUSS`** similar.

Cheap, immediate, honors the agent's judgment. Honest about its limit: a
misbehaving agent *can* ignore the prompt.

### Phase 2 — enforcement (scoped tools)

The real guarantee against accidental deployment: **gate the run's tool
allowlist by mode.** `RESEARCH` / `DISCUSS` runs get a read-mostly tool
profile (no `issues.transition`, no PR/deploy tools); only `EXECUTE` gets the
mutating set. This makes "don't deviate" a property of the sandbox, not a
polite request. Tracked as a follow-on so Phase 1 can ship first.

## Completion contract per mode

This is where mode stops the silent-EXECUTE assumptions across the system:

- **Auto-transition on assign** (`startedStatusId`) fires **only for
  `EXECUTE`**. Research/review/discuss leave issue status alone.
- **SLA / watchdog** (`assignmentSlaMinutes` → `ISSUE_STALLED`) applies the
  "must move the issue" expectation **only to `EXECUTE`**. A `RESEARCH` run is
  "done" when it posts findings, not when it transitions the issue — so it's
  never falsely stalled.
- **`artifactRequired` / `verificationChecklist`** are enforced at
  `runs.complete` **only for `EXECUTE`**.
- **`RESEARCH`** is expected to terminate with a `ConfidenceLevel`-tagged BODY
  comment; `runs.complete({ summary })` with no transition.
- **`REVIEW`** terminates via a `reviewGates`/`actionRequests` verdict.
- **`DISCUSS`** may not open a heavyweight `AgentRun` at all — a reply is
  enough (same lightweight path chat already uses).

## Schema changes

```prisma
enum EngagementMode { EXECUTE RESEARCH REVIEW DISCUSS }

enum MentionEngagementPolicy { INFER FIXED REQUIRE_MARKER }

model AgentRun {
  // …
  engagementMode EngagementMode @default(EXECUTE)
}

model Workspace {
  // …
  assignmentEngagementMode EngagementMode          @default(EXECUTE)
  mentionEngagementPolicy  MentionEngagementPolicy @default(INFER)
  mentionDefaultMode       EngagementMode          @default(DISCUSS)
}
```

Optional, deferred: `Issue.preferredEngagementMode EngagementMode?` so a
"Research"-labelled issue auto-dispatches as `RESEARCH`. Not in v1 — labels +
policy cover most of it and we avoid a column we might not need.

No data migration risk: every column defaults, every existing run is
EXECUTE (= today's behaviour), so the change is behaviour-preserving until
someone picks a different mode.

## UI / UX (themed, pattern-following)

All surfaces use one shared control and the warm-earthy tokens — no ad-hoc
colors, mono only for identifiers.

- **Mode glyph set** — a small icon + tone per mode, in the spirit of the
  existing `PriorityGlyph`: `EXECUTE` (filled / ember), `RESEARCH` (magnifier /
  muted), `REVIEW` (check-eye / warning), `DISCUSS` (speech / muted). One
  source of truth, reused everywhere below.
- **Assign popover** — a segmented control next to the agent picker, each
  option with one-line subtext ("Take it to done" / "Investigate & report" /
  "Critique only" / "Just weigh in"). Default highlighted per surface.
- **Mention popover** — the same chips after agent selection; inline `mode:`
  markers also accepted in the composer.
- **Issue detail — agent-run strip** — show the active run's mode as a chip
  beside `currentStep`, so it's obvious *what kind of work* is in flight.
- **`dispatch-reason-chip`** — extend to include the resolved mode + where it
  came from (explicit / policy / default), so "why is it doing this?" is
  answerable at a glance.
- **Mission Control — RunRow** — mode chip + a filter, so you can see "all
  research runs" at once.
- **Settings → Dispatch Rules** — the natural home for the config. Add: the
  per-surface default (assignment), the mention policy
  (`INFER`/`FIXED`/`REQUIRE_MARKER`) and `mentionDefaultMode`. Matches the
  columnar routing-matrix style already on that page; the read-only
  "fall-through" section becomes editable here.

## System ripple — what else this touches

A deliberate inventory so nothing silently keeps assuming EXECUTE:

1. **`AgentRun`** gains `engagementMode`; every reader (Mission Control,
   RunRow, watchdog, run-dispatcher) must read it.
2. **Watchdog / SLA** (`slas-and-watchdogs.md`) — gate "stalled for not
   transitioning" on `EXECUTE`.
3. **Auto-transition on assign** — gate `startedStatusId` on `EXECUTE`.
4. **Completion gates** — `artifactRequired` / `verificationChecklist` only
   for `EXECUTE`.
5. **Auto-dispatch** (`auto-dispatch.md`) — queued issues default `EXECUTE`;
   honor `Issue.preferredEngagementMode` if/when added.
6. **Confidence chip** — becomes the expected terminal signal for `RESEARCH`.
7. **Review gates / action requests** — terminal for `REVIEW`.
8. **MCP surface** — `issues.assign` gains an optional `mode`; `comment.create`
   accepts per-mention `mode`; tool descriptions updated.
9. **`forge` CLI** — `forge issue assign <key> <agent> --mode research`.
10. **Docs** — this file (promote from spec to guide), plus edits to
    `dispatch-rules.md`, `auto-dispatch.md`, `slas-and-watchdogs.md`,
    `chat.md`, and the root `CLAUDE.md` dispatch sections. **CHANGELOG** entry
    on ship.

## Decisions (resolved 2026-05-25)

1. **Mention default policy → `INFER` + ask-if-unsure.** No marker → the agent
   infers intent and must ask before anything irreversible. `FIXED` /
   `REQUIRE_MARKER` remain available per workspace; explicit markers always
   win.
2. **Enforcement → prompt-guidance first.** Phase 1 (inject mode into
   `RunInput.instructions`) ships first; scoped-tool enforcement (Phase 2) is a
   follow-on we commit to only after measuring whether agents respect the
   guidance.
3. **No per-user mode preference.** Mode is about the work, not the person.
   Config lives at workspace level (Dispatch Rules) + the per-dispatch
   override. No `User` column.

4. **`DISCUSS` is lightweight — no `AgentRun`.** A DISCUSS dispatch posts a
   BODY comment reply, mirroring the existing chat-reply path
   (`ensureChatMessage`); it does **not** open a run. This keeps Mission
   Control's RunRow a list of *real work*, and makes escalation explicit: a
   DISCUSS agent that thinks work is warranted asks first and stops — a human
   (or an explicit `execute:`/`research:` marker) then re-dispatches, and *that*
   opens the run. Token/cost for the reply is untracked in v1 (same as a chat
   reply); if per-reply cost visibility is needed later, add a lightweight
   usage field on the comment rather than forcing a heavyweight run.
