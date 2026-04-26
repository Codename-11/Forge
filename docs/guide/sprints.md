# Sprints

A sprint is a time-boxed iteration. Issues move into a sprint when planned,
move out at rollover if not finished, and hit `DONE` (or `CANCELED`) inside
the window in the happy case. This page covers the sprint model, the
planning workflow, rollover, and the standup view.

::: info
Forge calls this primitive **Sprint** in the UI. The underlying data model
is **Cycle**, and that name shows up in places you'll touch as a developer:
the Prisma model is `Cycle`, the tRPC router is `cycle.*`, the URL is
`/cycles`, and the MCP namespace is `cycles.*`. Only the display strings
were renamed (in 2026-04-24). If you write user-facing copy, write
"Sprint". If you write code or curl, you'll see `cycle*`.
:::

## Fields

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | Internal identifier |
| `name` | string | Display name (e.g. "Sprint 12") |
| `startsAt` | datetime | Sprint window start |
| `endsAt` | datetime | Sprint window end |
| `lengthDays` | int | Defaults from `Workspace.cycleLengthDays` |
| `cooldownDays` | int | Defaults from `Workspace.cycleCooldownDays` |
| `status` | enum | `PLANNED` / `ACTIVE` / `COMPLETED` / `CANCELED` |

The default `lengthDays` for a new sprint is the workspace setting
`cycleLengthDays` (7 out of the box). You can override per sprint when you
want a longer or shorter window.

`cooldownDays` is the gap before the next sprint starts. With cooldown set
to 0 (the default), sprints are back-to-back. Set it to 1 or 2 if you want
explicit breathing room for cleanup, retros, or planning.

## Status semantics

| Status | Meaning |
|---|---|
| `PLANNED` | Created, scheduled, not yet started |
| `ACTIVE` | Currently running (between `startsAt` and `endsAt`) |
| `COMPLETED` | Window has elapsed; rollover has been run or is implicit |
| `CANCELED` | Closed without running |

Forge does not auto-advance a sprint from `PLANNED` to `ACTIVE` based on
clock time alone. You explicitly activate (and complete) sprints. This
keeps the activity feed honest — sprint transitions are intentional events,
not background sweeps.

## Adding and removing issues

Two paths.

**From the UI.** The active sprint page has an **Add issues** action that
opens a picker; multi-select and confirm. Drag-and-drop from the Issues
list also works.

**From the API.**

```ts
await trpc.cycles.addIssue.mutate({
  workspaceId,
  cycleId,
  issueId,
});

await trpc.cycles.removeIssue.mutate({
  workspaceId,
  cycleId,
  issueId,
});
```

Adding an issue sets `Issue.cycleId`. Removing clears it. An issue can sit
in at most one sprint at a time; moving it from one sprint to another is a
single `addIssue` call (the new sprint claims it).

## Planning workflow

Sprint planning has two phases: **draft** and **commit**.

The `cycles.plan` mutation supports both. In draft mode, you stage a set of
issues against an upcoming sprint without finalizing — useful for reviewing
the proposed scope with the team before locking it in. In commit mode, the
draft is finalized: issues are written to `Issue.cycleId` and the sprint
moves from "draft scope" to "real scope."

```ts
await trpc.cycles.plan.mutate({
  workspaceId,
  cycleId,
  issueIds: [...],
  mode: "draft",  // or "commit"
});
```

Drafts are visible in the sprint detail page under a "Proposed" group.
Commits move them to the canonical issues list.

::: tip
Use draft mode if you want async review of a planned sprint. Commit when
you're ready for the work to start.
:::

## Rollover

A sprint ends. Some issues are `DONE`, some aren't. What happens to the
unfinished ones?

`cycles.rollover` is the answer. It moves all incomplete issues (anything
not in `DONE` or `CANCELED`) from the closing sprint into the next one.
Optionally, you can pass `targetCycleId` to move them to a specific
sprint, or set `targetCycleId: null` to drop them back to the unscheduled
backlog.

```ts
await trpc.cycles.rollover.mutate({
  workspaceId,
  fromCycleId,
  targetCycleId, // optional; defaults to next sequential sprint
});
```

Rollover writes one audit row per issue moved, so you can answer "what
was rolled out of sprint 11?" later.

## The standup view

Press <kbd>g</kbd> then <kbd>u</kbd> to open the Standup view. This is a
purpose-built page for the daily standup ritual: it groups the active
sprint's issues by assignee (human or agent), shows what's in flight, what
moved yesterday, and what's blocked.

Three columns per assignee:

- **In progress** — issues with `IN_PROGRESS` status
- **Awaiting review** — issues with `IN_REVIEW`
- **Blocked** — issues with at least one `BLOCKED_BY` relation pointing at
  an open issue

The view updates live via SSE; no refresh needed.

## Quick-open the active sprint

Press <kbd>c</kbd> from anywhere to open the active sprint. If multiple
sprints are `ACTIVE` (uncommon — typically one), the most recently started
opens first.

If no sprint is active, <kbd>c</kbd> opens the sprints list with the
nearest planned sprint highlighted.

## A typical sprint week

1. **Plan.** Use `cycles.plan` in draft mode to stage scope. Review with
   the team.
2. **Commit.** Move the draft to commit; issues bind to the sprint.
3. **Activate.** Set the sprint to `ACTIVE`. The dispatcher sees queued
   sprint issues and routes them to agents.
4. **Standup.** Daily, <kbd>g</kbd> <kbd>u</kbd> to open Standup; review
   in-flight, awaiting-review, blocked.
5. **Close.** Set the sprint to `COMPLETED`. Run `cycles.rollover` to
   carry incomplete issues into the next sprint or back to the backlog.
6. **Cooldown.** If `cooldownDays > 0`, the next sprint starts after the
   gap.

## Where to next

- [Issues](/guide/issues.html) — what fills sprints.
- [Projects & Initiatives](/guide/projects-and-initiatives.html) —
  orthogonal grouping; an issue can be in both a project and a sprint.
- [Agents → Auto-dispatch](/agents/auto-dispatch.html) — how queued sprint
  issues find agents.
