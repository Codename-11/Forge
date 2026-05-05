# Inbox

The Inbox is the daily driver. Open it first, work it, close it. Most
days you should never need to leave the Inbox surface to know what's on
your plate or what the team needs from you.

::: tip Chord
<kbd>g</kbd> <kbd>i</kbd> opens the Inbox from anywhere.
:::

## What's in the Inbox

The Inbox is split into bucketed tabs. Each tab is a different kind of
"something is asking for your attention," surfaced from the same data
the rest of Forge sees, but pre-filtered to the rows that matter for
*you* right now.

### Pulse

The "what's happening" tab. Live activity stream of recent events
across the workspace — comments, transitions, assignments, agent runs.
Read-only by design; this is where you skim before the stand-up to
catch up on what changed since you last looked.

The Pulse tab pulses (literally — a small ember dot in the tab label)
when new events have landed since your last visit. The pulse clears
when you open the tab.

### Queue

Issues *assigned to you* that aren't blocked. The queue is what you
should actually be working on. Sorted by priority + due date so the
most urgent thing is on top.

Items leave the queue when they're done (transitioned to a DONE/
CANCELED status), reassigned away from you, or when their blocking
relations resolve and they un-block (which usually means they re-enter
the queue, not leave it — they're now actionable).

### Mentions

Comments that @-mention you specifically. Conversational, one-step-
removed. Mentions don't bulk-select (the actions don't compose
cleanly across "reply" and "snooze"), but each row has a quick-action
to jump to the issue and reply.

### Stalled

Two sub-buckets:

- **Human-stalled** — issues assigned to you whose `updatedAt` is older
  than `Workspace.stalledThresholdDays` (default 7). The threshold is
  a workspace setting; admins tune it in **Settings → Workflow**.
- **Agent-stalled** — issues whose `assignedAgentId` is set, but the
  agent has been silent past the threshold. The agent presence chip
  on the row shows the runtime state — useful for spotting the case
  where the agent is offline vs just slow.

Stalled is the bucket that surfaces "things slipping through the
cracks." If it's empty most days, your throughput is healthy.

### Snoozed

Issues you've explicitly marked "on hold until later." Collapsed by
default — the surface is meant to stay quiet about the thing you've
chosen to defer. Each row has an inline **Unsnooze** action to bring
it back into the active flow.

Snooze is set on the issue row via a row quick-action; it writes
`Issue.snoozedUntil DateTime`. While `snoozedUntil > now()`, the
issue is filtered out of every other Inbox bucket (and the dashboard
"Stalled" column). On expiry the row resurfaces in whichever bucket
matches its actual state (typically Stalled or Queue).

### Watching

Issues you've subscribed to via the eye glyph on the issue detail
page. Distinct from assignment / pin / snooze — watching is event
subscription without ownership. Collapsed by default. Each row links
straight to the issue detail page.

The bucket is sourced from `issue.watching` (per-user view of
`IssueWatcher`). Pin and Watch are orthogonal — both can be active
on the same issue. See [Watching](/guide/watching.html) for the full
breakdown.

## Last-visit unread tracking

The Inbox tracks `User.lastInboxVisitAt` so it can show you "new since
you last looked." Each bucket carries a small ember pill — `{count}
new` — when the bucket has rows that have moved (`updatedAt` advanced)
since your last visit. The same logic surfaces a per-row ember dot.

The visit timestamp updates on mount, debounced 5 seconds server-side.
Quickly tabbing through Inbox tabs doesn't cost you the unread state.

## Inline actions

Hover any row to surface a `<RowQuickActions />` strip:

- **Status** picker — transition the issue without opening it.
- **Assignee** picker — reassign in one click.
- **Snooze** — set `snoozedUntil` to "tomorrow," "next week," or a
  custom date.
- **Nudge** — drop a quick comment that tags the assignees (their own
  inbox lights up via the existing comment fan-out).
- **Mark read** — clear the per-row unread dot without changing the
  underlying row.

These mirror the bulk action set so single-row and multi-row workflows
feel the same.

## Bulk actions

Select rows with the checkbox on the left edge. <kbd>x</kbd> toggles
selection on the row your cursor is over; <kbd>⇧X</kbd> selects the
range from your last selection to the cursor row. Once at least one
row is selected, the sticky **Bulk action bar** appears at the bottom
of the viewport with:

- **Mark read**
- **Snooze for…** (date picker)
- **Reassign…** (assignee picker)
- **Cancel** (clears the selection)

Mentions deliberately don't bulk-select — the actions don't map cleanly
to "reply" or "resolve" the way the other tabs do.

## Where the Inbox plumbs in

- The `inbox.list` tRPC procedure honors `Workspace.stalledThresholdDays`
  and splits stalled into `humanStalled` / `agentStalled` /
  `snoozed` buckets.
- `inbox.visit` bumps `User.lastInboxVisitAt` (debounced server-side).
- `inbox.badge` powers the sidebar Inbox count chip.
- The dashboard's **Stalled** column reads `dashboard.stalledInProgress`,
  which honors the same threshold setting — no hardcoded 3-day cutoff.

## Where to next

- [Issues](/guide/issues.html) — bulk actions, snooze, the row-level
  surface.
- [Quick Notes](/guide/quick-notes.html) — fast capture for things
  that don't yet warrant an issue.
- [Saved Views](/guide/saved-views.html) — when the Inbox isn't the
  shape you need, save the filter.
