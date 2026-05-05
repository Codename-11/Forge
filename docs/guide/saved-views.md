# Saved Views

A Saved View is a named snapshot of an `/issues` filter — the project
filter, status filter, assignee filter, sort key, and view mode (list
or board). Save the configuration once, recall it instantly later.

## What a view captures

A Saved View persists:

- The active filter set on `/issues` (project, status, assignee,
  priority, label, search query).
- The sort key.
- The view mode (`list` or `board`).
- An ordering position so views you reorder stay in your preferred
  order across sessions.

Saved Views are **per-user**. Stored on the `IssueSavedView` table,
keyed by `(userId, workspaceId, name)`. The legacy workspace-shared
`SavedView` table still exists for older shared filters; new personal
views all go through `IssueSavedView`.

## Saving the current filter

On `/issues`, configure the filter you want, then click **Save view**
in the filter bar. You'll be prompted for a name. The view appears
in the **Views** chip rail at the top of the page.

### Quick-save when filters match an existing view

When the current filter set matches a saved view exactly (order-
independent — arrays compare as sets, missing values and explicit
`false` collapse to "no filter"), the bar shifts mode:

- A small chip shows the matched view's name.
- **Save changes** overwrites the matched view's filters with the
  current selection.
- **New view** opens the standard create dialog so you can fork the
  filter as a new named view.

When no filters are applied at all, the **Save view** button
disables itself with a tooltip pointing you at the filter chips.

## Switching between views

Click any chip in the Views rail to apply that view. The filter,
sort, and view mode all snap to the saved configuration in one
transition. Clicking the active chip again clears the view (returns
you to the unfiltered, default-sort, list-mode default).

The chip rail respects `orderIndex` — drag to reorder.

## Pinning a view to the sidebar

A Saved View can be pinned via the sidebar's **Pin** action (or the
generic <kbd>p</kbd> chord on the saved-view chip). Pinned views
appear under the **Pinned** sidebar section so they're one click away
from anywhere in Forge — no need to open `/issues` first.

Pinning uses the same polymorphic `Pin` table as everything else in
Forge — `targetType = SAVED_VIEW`. See [Pinning](/concepts/primitives.html#pin)
for the full model.

## View vs filter

A **filter** is the transient state of `/issues` — change it freely
without committing.

A **view** is a *saved* filter — the configuration you reach for
often enough to deserve a name.

Use filters for one-off slices ("everything I changed this morning,"
"all backlog issues with the `polish` label"). Promote them to views
when you find yourself typing the same filter twice.

## Where to next

- [Issues](/guide/issues.html) — the surface where views are saved.
- [Inbox](/guide/inbox.html) — the daily driver, complementary to
  views.
- [Keyboard](/guide/keyboard.html) — pin chord and command palette
  recall.
