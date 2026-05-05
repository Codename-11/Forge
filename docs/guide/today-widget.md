# Today Widget

The **Today** tile sits between the dashboard greeting and Quick
Notes. It's the focused "what's happening this week" surface — a
glance at the active sprint, what's due soon, and the shape of the
week ahead.

## What you see

Up to three regions, in one card:

1. **Active sprint countdown** — the sprint's name and how many days
   are left before it ends. Click it to open the sprint detail page.
   Hidden when no sprint is active in the workspace.
2. **Due soon** — up to five issues whose `dueDate` falls within the
   next seven days, sorted by date ascending. Already-overdue rows
   that aren't yet closed surface here too. Click any row to open
   the issue.
3. **This week** — a Mon–Sun strip showing today's day highlighted
   plus a small dot under any day with one or more issues due.
   Clicking a day routes to `/issues` (filter-by-date is coming in a
   future iteration).

When all three regions are empty, the widget collapses to a single
"Nothing scheduled — fluid week" tile rather than disappearing
entirely.

## Data sources

The widget calls `dashboard.today` (tRPC), which composes:

- `cycle.findFirst` for the active sprint.
- `issue.findMany` over the next seven days (excluding done /
  canceled) for the due-soon list.
- `issue.findMany` over the current ISO week (Mon–Sun in UTC) to
  build the seven per-day counts.

The proc returns a single payload so the dashboard makes one
round-trip; the client renders each region inline based on
emptiness.

## Where to next

- [Dashboard: What's New](/guide/whats-new.html) — the recent-changes
  rail that lives below Today.
- [Issues](/guide/issues.html) — the full triage surface the day
  cells link into.
- [Sprints](/guide/sprints.html) — sprint lifecycle the countdown
  reads from.
