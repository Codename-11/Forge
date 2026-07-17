# Issues

The issue is the unit of work in Forge. Everything else — projects, sprints,
initiatives, time entries, attachments — orbits the issue. This page covers
the fields, the assignment model (humans and agents in parallel), the
queue concept, bulk operations, and how relations link issues together.

## Fields

| Field             | Type     | Notes                                                                         |
| ----------------- | -------- | ----------------------------------------------------------------------------- |
| `id`              | uuid     | Internal identifier                                                           |
| `key`             | string   | Public key, e.g. `WRK-42`. Workspace-prefixed and unique within the workspace |
| `kind`            | enum     | `ISSUE` or `TASK`. Tasks are lighter-weight; defaults are typically tighter   |
| `title`           | string   | Required, single line                                                         |
| `description`     | markdown | Optional, free-form                                                           |
| `statusId`        | fk       | Status row in this workspace's status set                                     |
| `priority`        | enum     | `NONE` / `LOW` / `MEDIUM` / `HIGH` / `URGENT`                                 |
| `authorId`        | fk       | The user who created the issue                                                |
| `dueDate`         | date     | Optional                                                                      |
| `estimate`        | int      | Optional, dimensionless points                                                |
| `slaMinutes`      | int      | Optional per-issue SLA in minutes; nonzero overrides workspace default        |
| `projectId`       | fk       | Optional grouping                                                             |
| `parentId`        | fk       | Optional sub-issue parent                                                     |
| `cycleId`         | fk       | Optional sprint membership                                                    |
| `claimedById`     | fk       | Human assignee (independent slot)                                             |
| `assignedAgentId` | fk       | Agent assignee (independent slot)                                             |
| `queued`          | bool     | Is this issue ready for an agent to pick up?                                  |
| `aiTriageStatus`  | enum     | `PENDING` / `READY` / `APPLIED` / `DISMISSED` / `ERROR` / null                |

::: info
Status is not an enum — it's a foreign key to a workspace-defined status row.
That lets you create custom statuses (`Code Review`, `Blocked on Vendor`)
per workspace. Each status sits in a **category** (`BACKLOG`, `TODO`,
`IN_PROGRESS`, `IN_REVIEW`, `DONE`, `CANCELED`) so dashboards and burndowns
can aggregate without caring about the local labels.
:::

## Status categories

Forge ships these status categories. Workspaces can have many statuses
within each category, but the category set is fixed.

| Category      | Meaning                    |
| ------------- | -------------------------- |
| `BACKLOG`     | Not yet planned            |
| `TODO`        | Planned, not started       |
| `IN_PROGRESS` | Actively being worked      |
| `IN_REVIEW`   | Submitted for review or QA |
| `DONE`        | Shipped, closed positively |
| `CANCELED`    | Closed without shipping    |

## Search

Issue search is workspace-scoped and uses one contract across the Issues page,
relation and time-entry pickers, the command palette, and MCP `issues.list`.

- `AXI-117`, `117`, and `#117` are direct identifiers. They match the exact
  issue number; full keys are case-insensitive and the prefix must equal the
  current workspace key.
- Other text searches the issue title and description plus operator-facing
  metadata: project key/name, label name, human assignee name/handle/email, and
  assigned-agent name/profile key.
- Status and priority remain facets, not free-text terms. Lifecycle scope,
  archive mode, saved-view facets, board columns, and API-key narrowing still
  apply to every result, including direct identifiers.

Search does not inspect comments, attachments, audit text, AI reasoning, or
external-resource bodies. Forge currently uses ordinary indexed relational
filters and deterministic cursor sorting; the current data scale does not
justify a full-text or trigram extension.

## The two assignment slots

Forge keeps human and agent assignment **independent**. An issue can have:

- A `claimedById` — the human currently responsible.
- An `assignedAgentId` — the agent currently responsible.
- Both. Or neither. Or just one.

This isn't a quirk; it's load-bearing. A common pattern: an agent is
assigned a routine implementation issue (`assignedAgentId`), and a human
on-call lead claims it (`claimedById`) to remain accountable for the
outcome without taking the keys away from the agent. Comments and audit
events distinguish the two.

The MCP tool `issues.assigned` infers "my work" from the calling API key —
if the key is linked to an agent (`linkedAgentId`), it returns issues with
matching `assignedAgentId`. If the key is linked to a human session, it
returns by `claimedById`. The caller doesn't need to pass a profile.

### When to assign vs. @mention an agent

Use the agent picker/assignment field when you want to give an agent ownership
of the issue. Assignment emits `AGENT_ASSIGNED` and wakes push-capable agents
such as Hermes profiles; you do not need to also type `@victor` in the same
moment just to start the run.

Use `@profileKey` in a comment when the issue is already assigned and you want
the agent to read/respond to that specific comment now. A normal comment is
part of the issue history, but it is not a targeted wake-up for the assignee
unless the agent is mentioned or has watched the issue.

## The queue

`queued: true` means "this issue is ready for an agent to pick up." It's
the signal the auto-dispatcher reads. The dispatcher only considers
queued + unassigned issues (where `assignedAgentId IS NULL`).

Setting `queued` is explicit:

- In the UI, toggle **Queue for agent** in the issue actions.
- Via tRPC or MCP: `issues.setQueued`.

Once an agent is assigned (manually or via dispatch), `queued` is
typically left as-is — agents complete their work and either close or
hand back. If they hand back (`issues.release`), `queued` returns to
`true` and `assignedAgentId` is cleared so the next dispatch tick can
re-route.

## Creating issues

Two paths.

**Quick create.** Press <kbd>⇧C</kbd> from anywhere. The dialog covers title,
description, priority, project, and kind. <kbd>⌘ Enter</kbd> submits. Creating
from a board column or status group also preserves that originating status;
creating from the command palette always opens issue mode, even while viewing
an existing issue. This is the primary creation path.

The QuickCreate input also recognises [slash commands](/guide/slash-commands.html)
at the start of the line:

```
/assign @victor
/priority urgent
/label deploy
The deploy script silently swallows non-zero exit codes.
```

The slash commands are stripped from the title; the cleaned tail is
the issue title; the matching field updates fire as
`applyCommands` on `issue.create`. The same parsing works in the
issue detail comment composer.

Sub-issues are created from the parent issue's Sub-issues panel. Attachments,
relations, sprint membership, and agent assignment can be added from the issue
detail after capture. All creation paths call `issue.create` under the hood.
From the API:

```ts
await trpc.issue.create.mutate({
  title: "Wire onboarding email",
  priority: "HIGH",
  projectId,
});
```

## Bulk operations

When you select multiple rows on the Issues list, the action bar exposes
bulk operations that are also available on the API surface:

- `issue.bulkTransition` — move N issues to a target status
- `issue.bulkAddLabel` / `issue.bulkRemoveLabel` — add/remove a label
  across N issues (mixed-state aware: rows that already have/don't
  have the label are no-ops)
- `issue.bulkAssign` — set `claimedById` across N issues
- `issue.bulkAssignAgent` — set `assignedAgentId` across N issues
- `issue.bulkArchive` — confirmation-gated soft-delete via
  `Issue.deletedAt`
- `issue.bulkRestore` — restore selected rows from the Archived issues view
- `issue.snoozeMany` — set `snoozedUntil` across N issues

Each bulk call writes a single audit envelope per issue and fans out one
event per issue, so consumers see N coherent updates rather than one
opaque batch.

### Selection chords

| Chord          | Action                                                |
| -------------- | ----------------------------------------------------- |
| <kbd>x</kbd>   | Toggle selection on the row your cursor is over       |
| <kbd>⇧X</kbd>  | Select range from the last selected row to the cursor |
| <kbd>esc</kbd> | Clear selection                                       |

Selection is shared with the Inbox bulk bar — the same `<BulkBar />`
primitive renders on both surfaces. The Issues board view intentionally
skips bulk-select; drag-and-drop covers the highest-frequency op and
checkbox-on-cards is visually noisy.

## Archive and restore

Issue archive is reversible. Archiving sets `Issue.deletedAt`, removes the
issue from active lists and boards, clears queue/claim state, abandons live
agent runs, and cancels an unambiguous active materialized plan step. History
and relations remain stored for a later restore.

Use **Archive** on an issue detail or select rows and choose **Archive** in the
list bulk bar. The **Archive** control on the issues page opens the archived-only
view. Open an archived issue or select archived rows to restore them. Restore
only returns the issue to active visibility; it does not resurrect claims,
agent runs, or canceled plan steps.

::: tip
For very large bulk operations (hundreds of issues), use the MCP REST
endpoints and chunk into batches of ~50 to stay under request size
limits.
:::

## Snooze

`Issue.snoozedUntil DateTime?` lets you mark an issue "intentionally on
hold until later." While `snoozedUntil > now()`, the issue is filtered
out of:

- Every Inbox bucket (Queue, Mentions, Stalled).
- The dashboard "Stalled" column.
- The dashboard suggestions strip.

When `snoozedUntil` falls into the past, the row resurfaces wherever
its actual state lands it (typically Stalled or Queue). There's no
background sweep — comparison is `snoozedUntil > now()` everywhere
that filters.

Set snooze from a row's quick-action menu (Snooze for…) or via tRPC:

```ts
await trpc.issue.snooze.mutate({ id, until });
await trpc.issue.unsnooze.mutate({ id });
await trpc.issue.snoozeMany.mutate({ ids, until });
```

## AI triage state

When `Workspace.aiEnabled` and `aiTriageOnCreate` are both on, every newly
created issue runs through AI triage. The state lives on the issue as
`aiTriageStatus`:

| State       | Meaning                                        |
| ----------- | ---------------------------------------------- |
| `null`      | AI triage didn't run (feature off, or not yet) |
| `PENDING`   | Queued for triage                              |
| `READY`     | Suggestions generated, awaiting review         |
| `APPLIED`   | Suggestions accepted by a human                |
| `DISMISSED` | Suggestions rejected                           |
| `ERROR`     | Triage failed (provider error, timeout, etc)   |

Triage suggestions cover priority, labels, and project — never the title or
description. See [Agents → AI triage and coach](/agents/ai-triage-and-coach.html)
for what the suggestions look like and how the Coach behaves around stalls
and SLA breaches.

## Issue relations

Issues are linked through `IssueRelation` rows: directed and typed.

| Type         | Meaning                                            |
| ------------ | -------------------------------------------------- |
| `BLOCKS`     | This issue blocks the target                       |
| `BLOCKED_BY` | This issue is blocked by the target                |
| `DUPLICATES` | This issue duplicates the target (close as dup of) |
| `RELATES_TO` | Soft link, no semantic constraint                  |

`BLOCKS` and `BLOCKED_BY` are inverses; creating one writes both records
so both sides of the graph are queryable cheaply.

Relations cascade-delete from either end. If you delete an issue, every
relation involving it goes with it. The audit log preserves the relation
history.

API: `relations.add`, `relations.remove`, `relations.listForIssue`. From
the UI, the Related panel on the issue detail handles all three.

## Unread indicator

Issues you're watching grow a small **ember dot** on the issues list when
something has happened since you last viewed them. The title also picks up
a slight bold weight — quiet, not a notification badge.

"Last viewed" is the timestamp `recentItem.track` writes when the issue
detail page mounts (the same row that feeds the command palette's Recents
rail). "Activity" is the issue's `updatedAt` — comments, status changes,
assignments, label edits all bump it. An issue you watch but have never
visited is treated as unread.

Clearing is automatic: opening the issue refreshes the `RecentItem` row,
and the next `issue.unreadIds` query (cached 30s) drops the dot.

Watch / unwatch flips the dot's eligibility — see
[Watching](/guide/watching.html).

## Quick-comment slash templates

The comment composer accepts four **template** keywords on top of the
seven structured slash commands. Templates expand to a templated body
in-place (and, in two cases, fire a follow-up mutation). They show up in
the same autocomplete dropdown as the commands, listed after them.

| Template                        | Expands to                                                                           | Side-effect                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `/status [<next-step>]`         | `**Status:** Working on <next-step>`                                                 | —                                                                              |
| `/blocked <reason>`             | `**Blocked:** <reason>`                                                              | Opens a `FREE_FORM` action request titled "Unblock needed" on this issue       |
| `/approve`                      | `**Approved** ✓`                                                                     | —                                                                              |
| `/handoff @<agent> [<context>]` | Injects `/assign @<agent>` at the top, then `**Handing off to @<agent>:** <context>` | Reassigns the issue to the named agent via the existing `/assign` command path |

Picking a template from the dropdown replaces the line and parks your
cursor in the right spot to keep typing. Hitting <kbd>⌘⏎</kbd> submits the
comment; queued side-effects fire after the comment lands so a transient
failure doesn't leave a stale unblock request without a comment to
anchor it.

Templates are scoped to the comment composer only — QuickCreate's
slash commands set issue fields and templates would conflict with the
"body becomes the title" contract.

## Where to next

- [Projects & Initiatives](/guide/projects-and-initiatives.html) — grouping
  issues into broader work.
- [Sprints](/guide/sprints.html) — time-boxing issues.
- [Agents → Auto-dispatch](/agents/auto-dispatch.html) — how queued issues
  become assigned.
- [Agents → AI triage and coach](/agents/ai-triage-and-coach.html) — the
  triage state machine end to end.
