# Primitives

The data model in one page. Read this and the rest of the docs map to
known territory.

Forge has eleven core models plus a couple of junctions. Everything else
in the product — sprints, dispatch rules, AI columns, attachments —
attaches to one of these. This page walks each model briefly and points
at where it's covered in depth.

## Workspace

The tenant. Every other tenant-scoped row carries `workspaceId`.

Workspaces have a short, immutable `key` — `AXI`, `PER`, `WRK` — that
becomes the prefix on every issue id (`AXI-42`). Slug and name are free
to change; the key is not. Changing it is a data migration, not a UI
edit.

The `Workspace` row is also where every operational knob lives: dispatch
mode, SLA windows, AI provider, sprint length, attachment quota, time
tracking toggle. Bailey's standing rule is that workspace-level values
should be columns here, not constants in handlers. See
[Settings → Workspace](/guide/settings.html) for the full set.

| Field of note | Meaning |
| --- | --- |
| `key` | Immutable issue prefix. |
| `cycleLengthDays` | Default sprint length (default 7). |
| `cycleCooldownDays` | Gap between sprints (default 0). |
| `attachmentQuotaMb` | Per-workspace attachment cap (default 1024). |
| `timeTrackingEnabled` | Master toggle for `TimeEntry`. |
| `autoDispatch`, `autoDispatchMode` | Dispatcher config. |

## Project

Groups issues. Optionally belongs to an `Initiative`.

Projects are workspace-scoped, support archiving (soft hide via
`archivedAt`) versus deletion (hard remove), and carry a status enum
(`PLANNED`, `ACTIVE`, `COMPLETED`, `CANCELED`). Issues optionally point
to a project via nullable `projectId` — a project-less issue is fine and
common.

## Initiative

A higher-level bucket above projects. Quarterly bets, themes, OKR-shaped
buckets — whatever you want one above project granularity.

Initiatives have status (`PLANNED`, `ACTIVE`, `COMPLETED`, `CANCELED`),
target dates, and a description. Projects nest under initiatives via
nullable `initiativeId`. Issues do not directly point at initiatives;
they reach them through their project.

## Issue

The unit of work.

| Field of note | Meaning |
| --- | --- |
| `key` | Display id (e.g. `WRK-42`). Workspace key + auto-incremented number. |
| `priority` | `NONE`, `LOW`, `MEDIUM`, `HIGH`, `URGENT`. |
| `status` | One of the workspace's `Status` rows; default categories `BACKLOG`, `TODO`, `IN_PROGRESS`, `IN_REVIEW`, `DONE`, `CANCELED`. |
| `claimedById` | Human user owning the issue (nullable). |
| `assignedAgentId` | Agent doing the work (nullable). |
| `projectId` | Optional project membership. |
| `cycleId` | Optional sprint membership. |
| `slaMinutes` | Per-issue SLA for the breach watchdog. |

The two assignment slots — `claimedById` and `assignedAgentId` — coexist
intentionally. See [Agents → Overview](/agents/overview.html).

The AI Triage columns (`aiTriageStatus`, `aiSuggestedPriority`,
`aiSuggestedLabelIds`, `aiSuggestedAgentId`, `aiTriageReasoning`,
`aiTriagedAt`, `aiTriageDecidedAt`) also live on Issue. See
[AI Triage & Coach](/agents/ai-triage-and-coach.html).

## Status

Workspace-scoped, ordered, with a category.

A `Status` row has a name (free-form), a category (one of the six
defaults — `BACKLOG`, `TODO`, `IN_PROGRESS`, `IN_REVIEW`, `DONE`,
`CANCELED`), an order, and a color. Issues point at a status by id.

Workspaces start with the six default statuses; you can add as many as
you want in any category. The category determines which watchdogs and
filters consider the issue "in flight" — non-terminal categories are
`BACKLOG`, `TODO`, `IN_PROGRESS`, `IN_REVIEW`.

## Label

Workspace-scoped, color, free-form.

Labels are the lightweight tagging primitive. Every label has a name, a
color, and lives in a single workspace. They attach to issues through
the `IssueLabel` junction. Labels feed into capability-match dispatch
(`agent.capabilities[]` ∩ `issue.labels[]`) and into the dispatch-rule
`labelId` condition.

## Cycle (Sprint in UI)

Time-boxed iteration.

The model is `Cycle`; the UI calls it "Sprint." The data model, tRPC
router (`cycle.*`), routes (`/cycles`), and MCP namespace (`cycles.*`)
all stay `cycle*`. Only display strings render as "Sprint."

Cycles have a start date, end date, name, and a `status` (`PLANNED`,
`ACTIVE`, `COMPLETED`). Issues join via nullable `cycleId`. Sprint length
defaults to `Workspace.cycleLengthDays`; cooldown between sprints
defaults to `Workspace.cycleCooldownDays`. Both are configurable.

::: info
If you're writing copy that will appear in the UI, write "Sprint." If
you're writing code, types, or API docs, write `Cycle`. The split is
deliberate.
:::

## IssueRelation

Directed, typed link between two issues.

| Field | Meaning |
| --- | --- |
| `fromIssueId` | The source issue. |
| `toIssueId` | The target issue. |
| `kind` | One of `BLOCKS`, `BLOCKED_BY`, `DUPLICATES`, `DUPLICATED_BY`, `RELATED`, `PARENT_OF`, `CHILD_OF`. |

Relations are cascade-deleted from either end — when you delete an
issue, all relations involving it disappear. Pairs of inverse kinds
(`BLOCKS` / `BLOCKED_BY`) are typically created as two rows so traversal
is symmetric.

## TimeEntry

Per-user duration rows against issues.

Only active when `Workspace.timeTrackingEnabled = true`. Every entry has
a `userId`, an `issueId`, a `startedAt`, an optional `endedAt` (open
entries are "currently running"), and a `durationSeconds`. The MCP
surface exposes start/stop/log/list/summary tools in the `time.*`
namespace.

## Attachment

Polymorphic via `targetType` + `targetId`.

| Field | Meaning |
| --- | --- |
| `targetType` | `issue`, `comment`, `project`, `initiative`, ... |
| `targetId` | The id of the target row. |
| `objectKey` | MinIO object key. |
| `mimeType`, `sizeBytes`, `name` | Standard file metadata. |

Attachments live in MinIO behind presigned URLs. The init/finalize/
download/delete pattern is in the `attachments.*` MCP namespace and the
tRPC router.

## Agent

First-class non-human actor.

The model that makes Forge what it is. `profileKey` is the cross-system
handle, unique per workspace, matching the Hermes profile directory
name. Status, capabilities, role (`WORKER`/`COACH`/`OBSERVER`),
heartbeat, max-concurrent cap, dispatch bookkeeping. See
[Agents → Overview](/agents/overview.html) for the full column-by-
column treatment.

## Comment

Issue-scoped prose.

Comments belong to an `Issue`, carry markdown body and a timestamp, and
support both human (`authoringUserId`) and agent (`authoringAgentId`)
attribution — never both, exactly one. Agent-authored comments are how
[AI Coach](/agents/ai-triage-and-coach.html) reaches the issue thread.

## Junctions

Two many-to-many junctions are worth naming for completeness:

- **`IssueAssignee`** — multi-assignee model. The `claimedById` column on
  Issue is the canonical "primary owner"; `IssueAssignee` rows allow
  additional human assignees alongside.
- **`IssueLabel`** — issue ↔ label. One row per pairing.

Both are simple junction tables; you'll mostly interact with them
through the Prisma `include`s on `Issue` rather than directly.

## Cross-references

- [Scopes & Tenancy](/concepts/scopes-and-tenancy.html) — how the
  `workspaceId` contract is enforced.
- [Activity & Audit](/concepts/activity-and-audit.html) — how mutations
  on these models are recorded and fanned out.
- [Agents → Overview](/agents/overview.html) — the Agent model in
  depth.
- [Reference → tRPC Routers](/reference/trpc.html) — the typed
  contract over these models.
