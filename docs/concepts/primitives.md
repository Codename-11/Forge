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

| Field of note                      | Meaning                                      |
| ---------------------------------- | -------------------------------------------- |
| `key`                              | Immutable issue prefix.                      |
| `cycleLengthDays`                  | Default sprint length (default 7).           |
| `cycleCooldownDays`                | Gap between sprints (default 0).             |
| `attachmentQuotaMb`                | Per-workspace attachment cap (default 1024). |
| `timeTrackingEnabled`              | Master toggle for `TimeEntry`.               |
| `autoDispatch`, `autoDispatchMode` | Dispatcher config.                           |

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

| Field of note     | Meaning                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `key`             | Display id (e.g. `WRK-42`). Workspace key + auto-incremented number.                                                        |
| `priority`        | `NONE`, `LOW`, `MEDIUM`, `HIGH`, `URGENT`.                                                                                  |
| `status`          | One of the workspace's `Status` rows; default categories `BACKLOG`, `TODO`, `IN_PROGRESS`, `IN_REVIEW`, `DONE`, `CANCELED`. |
| `claimedById`     | Human user owning the issue (nullable).                                                                                     |
| `assignedAgentId` | Agent doing the work (nullable).                                                                                            |
| `projectId`       | Optional project membership.                                                                                                |
| `cycleId`         | Optional sprint membership.                                                                                                 |
| `slaMinutes`      | Per-issue SLA for the breach watchdog.                                                                                      |

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

| Field         | Meaning                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `fromIssueId` | The source issue.                                                                                 |
| `toIssueId`   | The target issue.                                                                                 |
| `kind`        | One of `BLOCKS`, `BLOCKED_BY`, `DUPLICATES`, `DUPLICATED_BY`, `RELATED`, `PARENT_OF`, `CHILD_OF`. |

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

| Field                           | Meaning                                          |
| ------------------------------- | ------------------------------------------------ |
| `targetType`                    | `issue`, `comment`, `project`, `initiative`, ... |
| `targetId`                      | The id of the target row.                        |
| `objectKey`                     | MinIO object key.                                |
| `mimeType`, `sizeBytes`, `name` | Standard file metadata.                          |

Attachments live in MinIO behind presigned URLs. The init/finalize/
download/delete pattern is in the `attachments.*` MCP namespace and the
tRPC router.

## Agent

First-class non-human actor.

The model that makes Forge what it is. `profileKey` is the cross-system
handle, unique per workspace. For Hermes it usually matches the profile
directory name; for Claude, Codex, and custom clients it is the stable Forge
handle bound to their MCP key. Provider, runtime mode, status, capabilities,
role (`WORKER`/`COACH`/`OBSERVER`), heartbeat, max-concurrent cap, and
dispatch bookkeeping live here. See
[Agents → Overview](/agents/overview.html) for the full column-by-
column treatment.

## Comment

Issue-scoped prose.

Comments belong to an `Issue`, carry markdown body and a timestamp, and
support both human (`authoringUserId`) and agent (`authoringAgentId`)
attribution — never both, exactly one. Agent-authored comments are how
[AI Coach](/agents/ai-triage-and-coach.html) reaches the issue thread.

## Pin

Per-user, polymorphic pin. Each row pins one entity (Issue / Project /
Initiative / SavedView / Cycle / Agent) for the owning user. Surfaces
the entity in the **Pinned** sidebar section and in the command
palette empty-state rail. `workspaceId` is nullable — null means a
"cross-workspace" pin (the legacy topbar-strip semantic where the user
pinned an issue from any workspace they're in). `targetId` is **not**
a foreign key (the table is polymorphic across multiple targetType
tables); hydration silently drops dead targets.

The legacy `User.pinnedIssueIds String[]` column was dropped in
migration 0023 — all pin reads/writes now go through this table.

## RecentItem

Per-(user, workspace, target) LRU-ish row. Upserted on every entity-
detail mount via `recentItem.track`; `visitedAt` becomes the recency
key. Powers the command palette empty-state rail and the recent-items
component. Server-side debounced 5 seconds — fast nav (back/forward)
doesn't spam writes.

## IssueSavedView

Per-user named filter preset for `/issues`. Distinct from the legacy
`SavedView` model (which mixes workspace-shared and user-private
rows). Each `IssueSavedView` is owned by exactly one user; `filters`
is an opaque JSON blob (shape lives client-side / in zod), `sortKey`
is an optional sort hint, `orderIndex` is the explicit chip-rail
ordering. See [Saved Views](/guide/saved-views.html).

## Note

Per-(workspace, user) markdown scratchpad. Surfaced via the dashboard
`<QuickNotesWidget />` and the `notes.*` MCP namespace. Pinned notes
float to the top; `archivedAt` is the soft-delete path. Notes are
**personal** — agents leave notes for _themselves_, not for the
operator. The `note.convertToIssue` mutation spawns a real Issue from
a note's body without auto-archiving the source. See
[Quick Notes](/guide/quick-notes.html).

`Note` has two variants distinguished by `kind`:

- **`NOTE`** (default) — the scratchpad described above. `journalDate`
  is `NULL`.
- **`JOURNAL`** — a daily-summary entry. `journalDate` is set to UTC
  midnight on the user's wall-clock date; the unique constraint
  `(workspaceId, userId, journalDate)` enforces one journal row per
  user per day. Surfaced in the Journal tab of the Notes widget. See
  [Daily Journal](/guide/journal.html).

## IssueWatcher

Per-(issue, user OR agent) subscription row. A watcher receives
event fan-out for every event whose subject is the watched issue —
agents through their webhook (the same per-agent dispatch shim used
for comment @-mentions), humans through the inbox/notification
surfaces. Either `userId` OR `agentId` is set, never both. The actor
of an event is filtered out of fan-out.

Pin and Watch are intentionally orthogonal: pin is a UI shortcut,
watch is event subscription. Both can be active on the same issue
simultaneously. See [Watching](/guide/watching.html).

## Junctions

Two many-to-many junctions are worth naming for completeness:

- **`IssueAssignee`** — multi-assignee model. The `claimedById` column on
  Issue is the canonical "primary owner"; `IssueAssignee` rows allow
  additional human assignees alongside.
- **`IssueLabel`** — issue ↔ label. One row per pairing.

Both are simple junction tables; you'll mostly interact with them
through the Prisma `include`s on `Issue` rather than directly.

## Agentic work OS primitives

Shipped in the 2026-05-19 rollout. These models extend Forge from a
PM + chat system into a cohesive agentic work OS: capture intent,
curate context, execute plans, produce durable outputs, request
human review, and arrange work spatially. Every model below is
workspace-scoped and writes audit + activity events through the
shared `recordChange` path.

### Artifact + ArtifactVersion

Durable, versionable output objects — specs, decisions, runbooks,
reports, briefs, verification logs, and accepted agent deliverables.
Body edits snapshot a new `ArtifactVersion` automatically;
metadata edits stay in-place. Polymorphic `sourceType` / `sourceId`
back-link to the chat-message / comment / note / agent-run / issue
the artifact was promoted from.

Surfaces: `/w/{slug}/artifacts` index + `/w/{slug}/artifacts/{slug}`
detail. tRPC `artifact.*`. MCP `artifacts.list/get/create/update/
archive/promote`.

### ContextSet + ContextSetItem

Reusable bundles of canonical refs an agent receives at dispatch
time. Items are polymorphic via `targetType` / `targetId` and
carry an `includeMode` of `INCLUDE` / `EXCLUDE` / `SUMMARY_ONLY`.
Owned by a user OR an agent. Hydration goes through the shared
entity-hydration service so any future primitive plugs in
automatically.

Surfaces: tRPC `contextSet.*`. MCP `contextSets.list/hydrate/
create/addItem/removeItem`.

### Agent completion contract

Three columns on Issue make "done means..." explicit before an
agent starts work: `expectedOutput` (markdown spec),
`verificationChecklist` (structured JSON array of checks), and
`artifactRequired` (must the agent attach an artifact?). On the
other side, AgentRun gains `producedArtifactIds`,
`verificationResult`, and `followUps` so the final response is
structured.

MCP `agent.context.bundle` for issues exposes both a `completionContract`
block and, for plan-linked issues, an `orchestrationContext` block with the
Goal, Plan, current Step, dependencies, retry feedback, source-run evidence,
and non-excluded ContextSet references. MCP `runs.complete` is the structured
submission tool.

### ExecutionPlan + ExecutionStep

Multi-step plans an agent (or crew) executes under an issue or
project. Steps form an ordered list with optional
`dependsOnStepIds` so the runner can mark later steps READY only
when prerequisites are DONE. Steps can be assigned to agents or
humans and carry their own per-step `expectedOutput` /
`verification`.

Plan lifecycle: `DRAFT` → `APPROVED` → `RUNNING` →
`BLOCKED` / `COMPLETED` / `CANCELED`.
Step lifecycle: `TODO` → `READY` → `RUNNING` →
`BLOCKED` / `REVIEW` / `DONE` / `CANCELED`.

Surfaces: tRPC `executionPlan.*`. MCP `executionPlans.list/get/
create/transition/transitionStep`.

### AgentCrew + AgentCrewMember + ReviewGate

A crew is a group of agents bound to roles (`PLANNER`, `WORKER`,
`REVIEWER`, `OBSERVER`, `OPERATOR_PROXY`). The same agent can
hold multiple roles on the same crew. ExecutionPlans optionally
point at a crew via `crewId`.

ReviewGate is an approval checkpoint attached to any reviewable
target (artifact / execution-plan / execution-step /
action-request / agent-run). Gates block downstream automation
until resolved; re-resolution rejects.

Surfaces: tRPC `agentCrew.*` + `reviewGate.*`. MCP
`agentCrews.list` + `reviewGates.list/open/resolve`.

### ActionRequest

Precise, resolvable asks. Replaces vague notifications:
"the agent needs your decision before continuing" rather than
"the agent commented." Lifecycle: `OPEN` → `RESOLVED` /
`DISMISSED` / `SNOOZED`. The Inbox `actionRequestsForMe` query
unions OPEN rows assigned to the caller with the existing
@-mention `waitingOnMe` stream.

Surfaces: tRPC `actionRequest.*` + `inbox.actionRequestsForMe`.
MCP `actionRequests.list/create/transition`.

### Command Center

Read-only aggregator at `/w/{slug}/command-center` that unions
the operator's action requests, pending review gates, active
and stalled agent runs, recent artifacts, issues due in the
next 7 days, and the currently-running timer. Every card links
to the canonical detail page — writes never happen here.

Surfaces: tRPC `commandCenter.summary`.

### WorkspaceCanvas + WorkspaceCanvasNode + WorkspaceCanvasEdge

Infinite spatial board for synthesis work. Stores layout +
entity refs only; canonical content always comes from the
source row via the entity-hydration service. Nodes point at
any entity type (issue / artifact / chat-thread / attachment /
agent-run / execution-plan / execution-step); deleted-source
nodes render as dead-ref placeholders rather than disappearing.

Surfaces: tRPC `canvas.*`. MCP `canvases.list/get` (read-only
for v0; mutation stays in the human UI).

### Shared entity refs + hydration

Every primitive above shares a typed reference contract
(`src/lib/entity-ref.ts`) — a `{ type, id }` pair where `type` is
one of the 16 canonical entity types. The server-side
`entity-hydration.ts` service resolves any list of refs into
display-ready rows ({ label, subLabel, url, missing, meta }) so
canvas cards, context-set items, agent context bundles, and
command-center surfaces render uniformly.

## Cross-references

- [Scopes & Tenancy](/concepts/scopes-and-tenancy.html) — how the
  `workspaceId` contract is enforced.
- [Activity & Audit](/concepts/activity-and-audit.html) — how mutations
  on these models are recorded and fanned out.
- [Agents → Overview](/agents/overview.html) — the Agent model in
  depth.
- [Reference → tRPC Routers](/reference/trpc.html) — the typed
  contract over these models.
