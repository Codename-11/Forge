# Quick Notes

Fast personal capture, surfaced on the dashboard. The widget is the
place to drop a thought, a TODO, or an agent's "remember to check this
later" without first deciding which issue it belongs to.

::: tip Hotkey
<kbd>n</kbd> on the dashboard focuses the inline add row. (Suppressed
when you're already typing — the chord respects input focus.)
:::

## Where it lives

A collapsible card at the top of `/w/<slug>/dashboard`, between the
greeting bar and the onboarding card. Default state: open. Click the
header to collapse.

The widget shows up to 30 rows by default — pinned notes float to the
top, then by most-recently-updated.

## What a note is

Each note has:

- **Title** (optional) — click any title to rename inline.
- **Body** — markdown. Click the body excerpt to expand and render the
  full content (supports the same `[label](forge-link:URL)` chips and
  `forge-attachment:cuid` references the rest of Forge does).
- **Pinned** flag — pinned notes float to the top.
- **`archivedAt`** — soft-delete timestamp. Archived notes drop out of
  the default list; toggle **Archived** in the header to see them.

Notes are **per-user, per-workspace**. They're not shared, not
broadcast, not surfaced on anyone else's surface. When you want to
share a note, convert it to an Issue.

## Server-side state

State is persisted server-side on the `Note` table — no localStorage
involved. Per Forge's "server-side prefs over localStorage" rule, you
get the same notes on every device you sign into.

## Pin / archive / convert

Each note row has trailing actions revealed on hover:

- **Convert to issue** (`FilePlus`) — spawns a new Issue with
  `title = note.title || first line of body` and `description = body`.
  Routes you to the new issue. The source note stays put — archive it
  yourself if you want it out of the list.
- **Archive** (`Archive`) — sets `archivedAt = now()`. Reversible via
  the **Archived** toggle in the header.
- **Delete** (`Trash2`, archived rows only) — hard delete. Confirmation
  prompt. Use the archive path normally; this is the cleanup escape
  hatch.

The pin glyph on the left of each row toggles pinned-ness inline.

## Adding a note

The inline add row at the top of the widget has:

- A title input (optional).
- An auto-growing textarea.

Press <kbd>Enter</kbd> to save (when no title is set, this is a single-
line capture). Press <kbd>⌘ Enter</kbd> to save when the textarea is
multi-line. <kbd>Esc</kbd> clears and unfocuses without saving.

## Why it's a separate primitive (and not a Comment)

Comments are conversational — they live on an Issue, fan out to
assignees and mentioned users, and trigger webhooks. Notes are private
scratch space. Different audience, different lifecycle, different
fan-out.

If a note grows up into something the team needs to act on, the
**Convert to issue** path takes the body verbatim into a fresh Issue
description. The note remains as your archived rough draft.

## Agents can leave notes too

The MCP namespace `notes.*` mirrors the read/write surface so agents
can leave themselves notes. Per-user — agents leave notes for
*themselves*, not for the operator. To leave a note for someone else,
use `comments.create` on the relevant issue (the @-mention reaches
their inbox).

| Tool | Scope | Use case |
|---|---|---|
| `notes.create` | `WRITE_ISSUES` | Stash reasoning, follow-ups, links to investigate next loop. |
| `notes.list` | `READ_ISSUES` | Resume context from a previous turn. |
| `notes.update` | `WRITE_ISSUES` | Append to a running thread, change pinned, edit title. |
| `notes.archive` | `WRITE_ISSUES` | Mark a note as resolved without deleting it. |

See [Reference → MCP Tools](/reference/mcp.html) for full input/output
schemas.

## Where to next

- [Inbox](/guide/inbox.html) — the daily driver.
- [Issues](/guide/issues.html) — what notes graduate into.
- [MCP Tools](/reference/mcp.html) — the agent-facing surface.
