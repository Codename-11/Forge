# Daily Journal

A daily-summary surface for the operator and the agents working with
them. One entry per user per day, pinned to the calendar date, edited
freely throughout the day.

## Where it lives

The Journal tab inside `<QuickNotesWidget />` on the dashboard. Toggle
between **Notes** and **Journal** in the widget header. The Journal
header shows today's date in your locale (e.g. "Monday, May 4").

## What an entry is

Journal entries are stored in the same `Note` table as quick notes,
distinguished by:

- **`kind = JOURNAL`** — the variant marker.
- **`journalDate`** — UTC midnight on the user's wall-clock date,
  derived from `User.timezone` (falls back to UTC when unset).
- A **unique constraint** on `(workspaceId, userId, journalDate)`, so
  there is exactly one journal row per user per day. Subsequent calls
  to `note.todayJournal` are idempotent — they get-or-create.

The body is markdown. It can be empty (the row is created on first
visit; you fill it in over the course of the day).

## Editing

Today's entry sits at the top of the Journal tab as an editable
textarea. Auto-saves on blur, or press <kbd>⌘ Enter</kbd> to save
immediately. The widget keeps a local debounce so typing isn't a
round-trip per keystroke.

Past entries appear below today's, ordered by `journalDate desc`. Each
row collapses to a date + first-line preview; click to expand.

## Agent integration

The MCP namespace exposes two journal-specific tools:

| Tool | Scope | Use case |
|---|---|---|
| `notes.todayJournal` | `WRITE_ISSUES` | Get-or-create today's journal entry. Idempotent across calls in the same day. |
| `notes.listJournal` | `READ_ISSUES` | List recent journal entries (default 30 days). |

Common agent patterns:

- **Daily summary** — at the end of each session, append "what I
  shipped today" + open follow-ups to today's journal.
- **Blocker log** — record a blocker with the date for later review.
- **Decision record** — when a non-trivial decision is made, journal
  the rationale so it's findable on a date axis (the Lucid memory
  layer can ingest these too).

Journal is for **per-user reflection**, NOT inter-agent communication.
For that, use `comments.create` on the relevant issue — comments
fan-out to assignees and mentioned agents.

## Why it's a Note variant (not its own model)

The journal columns (`kind`, `journalDate`) are nullable additions on
the existing `Note` table. NOTE rows leave `journalDate = NULL`;
JOURNAL rows set it. Postgres allows multiple `NULL`s through a unique
constraint, so the unique on `(workspaceId, userId, journalDate)` only
applies to JOURNAL rows.

This keeps the schema compact: one table, one router, one MCP
namespace. The variant is a bit-flag, not a fork.

## Timezone handling

`note.todayJournal` reads `User.timezone` and computes the wall-clock
date in that zone, then stores UTC midnight on that date. This means
the unique constraint behaves the same regardless of DST — there's no
"two journal entries on a daylight-savings transition" edge case.

Set your timezone from `/settings/account` (the same page that holds
locale, theme, etc.).

## Where to next

- [Quick Notes](/guide/quick-notes.html) — the scratchpad surface in
  the same widget.
- [MCP Tools](/reference/mcp.html) — `notes.todayJournal` /
  `notes.listJournal` reference.
