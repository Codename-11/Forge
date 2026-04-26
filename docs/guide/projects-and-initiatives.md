# Projects & Initiatives

Two grouping primitives sit above the issue. **Projects** group issues
that ship together. **Initiatives** group projects that pursue a common
theme. This page covers fields, when to use which, archival semantics, and
how they connect to the roadmap view.

## Project

A project is a named collection of issues with an optional timeline.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | Internal identifier |
| `name` | string | Display name |
| `key` | string | Short, lowercase, used in URLs and search |
| `description` | markdown | Optional, free-form |
| `icon` | string | Lucide icon name |
| `color` | string | Token-aware accent color |
| `archived` | bool | Reversible hide; see below |
| `startDate` | date | Optional, when the project starts |
| `targetDate` | date | Optional, intended completion |
| `initiativeId` | fk | Optional, parent initiative |

Projects are workspace-scoped. An issue can belong to at most one project
(`projectId`); it can also belong to no project at all (a loose backlog
issue is fine).

## Initiative

An initiative is a higher-level container — a quarterly bet, a multi-team
program, an annual theme. Projects nest under initiatives via the nullable
`initiativeId` foreign key.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | Internal identifier |
| `name` | string | Display name |
| `slug` | string | URL segment |
| `description` | markdown | Optional, free-form |
| `targetDate` | date | Optional |
| `color` | string | Token-aware accent color |
| `status` | enum | `PLANNED` / `ACTIVE` / `COMPLETED` / `CANCELED` |
| `position` | int | Sort order in the initiative list |

Initiatives are workspace-scoped and orderable; the position is what the
roadmap and list views sort by.

## When to use which

Pick the smaller container by default.

- **Use a project** when you have a coherent body of work that ships as a
  unit and lives for days to a few weeks. "Onboarding email overhaul",
  "Switch to MinIO for attachments", "Q2 marketing site refresh."
- **Use an initiative** when you have a theme that several projects roll
  up to, that lives for weeks to months, and that you want to talk about
  on a roadmap. "Reduce activation friction", "Self-serve plan", "AI
  features V1."

Don't reach for an initiative just because the project is big. Make the
project bigger. Reach for an initiative when there's more than one project
and they share a destination.

::: info
Initiatives are not required. A workspace can run forever with just
projects (or even just loose issues). Initiatives exist for teams that
want a roadmap; they do not change anything else about how issues
behave.
:::

## Archival vs delete

Forge distinguishes the two.

**Archive** is reversible. Setting `archived = true` hides the project
from default lists, freezes mutations on its issues by convention, but
keeps every row addressable by id. Unarchive returns the project to the
default lists with no data loss.

**Delete** is destructive. It removes the project row and unsets
`projectId` on every issue that pointed at it (the issues themselves
survive — they're just unparented). Delete is admin-gated and audit-
logged.

The recommendation: prefer archive. Delete only when the project was
created by mistake.

## Linking projects to initiatives

Two operations move a project in or out of an initiative:

- `initiatives.linkProject` — set `Project.initiativeId`.
- `initiatives.unlinkProject` — clear `Project.initiativeId`.

```ts
await trpc.initiatives.linkProject.mutate({
  workspaceId,
  initiativeId,
  projectId,
});
```

Both operations are admin-gated and audit-logged.

A project can move freely between initiatives, including back to no
initiative. Issues inside the project don't care; the move is purely a
parent-pointer change.

## Roadmap view

Press <kbd>g</kbd> then <kbd>r</kbd> to jump to the Roadmap. It plots
initiatives on a horizontal timeline, with their child projects nested
underneath. Initiatives without `targetDate` show as "open-ended" lanes;
projects without timelines render as flat pills.

The roadmap respects ordering — drag an initiative to change its
`position`; drag a project under a different initiative to relink it.
Both actions go through the same tRPC mutations as the API.

::: tip
The roadmap is one of the few places mouse interaction is faster than
keyboard. Drag-and-drop is the natural expression of "move this here."
:::

## Project lifecycle in practice

A typical flow:

1. Create the project from the **Projects** page or via `projects.create`.
2. Set `startDate` and `targetDate` if you want it on the roadmap.
3. Optionally link it to an initiative (`initiatives.linkProject`).
4. Add issues — either by dragging existing issues onto the project, by
   creating new issues with `projectId`, or by selecting "Project" on
   the quick-create dialog.
5. Track progress in the project page's overview (status counts, burnup,
   timeline).
6. When the work ships, archive the project. Unarchive later if it
   reopens.

## Where to next

- [Sprints](/guide/sprints.html) — orthogonal time-boxing inside or
  across projects.
- [Issues](/guide/issues.html) — what goes inside a project.
- [Workspaces](/guide/workspaces.html) — the configurability principle.
