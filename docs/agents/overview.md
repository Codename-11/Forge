# Agents

Agents are first-class actors in Forge — rows in the same database as humans,
assigned to issues, dispatched by rules, observed via heartbeat.

This page covers the data model, the human/agent dual-assignment story, the
lifecycle of an agent, the implicit heartbeat that comes from webhook delivery,
and where to find each piece of the surface in the app.

::: info Configuration map
Use **Agent Studio** for identity, prompt, and the single primary execution
runtime; **Workspace → Agent roster** for binding policy; **Workspace → Agent
access** for one or more MCP client credentials; **Instance Administration**
for global governance; and **Mission Control** for read-only operations.
:::

## Two ways to run agent work

There are two ways to put an agent to work, and they're intentionally
different. Reach for the one that matches how much you want to drive.

|                       | **Direct dispatch**                           | **Goal orchestration**                                                            |
| --------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| Entry point           | Assign / @-mention / queue an **issue**       | State a **Goal** → approve a plan                                                 |
| Who decides the steps | You do — one issue, one unit of work          | A planner agent decomposes into a step DAG                                        |
| Who drives            | You — assign, nudge, reassign                 | An automated crew loop (plan → work → judge → retry)                              |
| Stops when            | The agent finishes that issue                 | Every step passes, or a budget/time cap trips                                     |
| Reach for it when     | You know the task and want an agent on it now | The objective is big and you want it broken down and run to completion on its own |

**Direct dispatch** is the everyday path: assign an agent to an issue (or
@-mention one, or let auto-dispatch pick from the queue) and it works that one
issue. See the rest of this page.

**Goal orchestration** is the autonomous path: you state an objective, approve
the plan a planner proposes, and a crew runs it through to "achieved" within the
budget you set. See [Orchestration loop](/concepts/orchestration.html).

::: info One observable substrate
Both paths run on the **same `AgentRun`** record — so whether work came from a
direct assignment or a Goal step, it shows up the same way in Mission Control,
counts toward the agent's load, and is watched by the same stalled-run /
watchdog logic. A Goal step can also be **materialized into a real issue** (see
the orchestration guide), so planned work appears on the board and sprint
alongside everything else. The two paths are different ways to _start_ work, not
two different systems for _tracking_ it.

Orthogonal to the path are two other dials, both also carried on the run:
the [**engagement mode**](/agents/engagement-modes.html) (how far to take the
work — execute / research / review / discuss) and the
[**execution engine**](/agents/engines.html) (who owns the agent loop —
Forge or the agent's own runtime).
:::

## The Agent model

Every agent is a row on the `Agent` table, scoped to a `Workspace`. It carries
identity, contact details, capabilities, and runtime state.

```prisma
model Agent {
  id                String       @id @default(cuid())
  workspaceId       String
  name              String
  profileKey        String       // unique per workspace
  description       String?
  avatar            String?
  provider          AgentProvider @default(HERMES)
  runtimeMode       AgentRuntimeMode @default(PERSISTENT)
  webhookUrl        String?
  webhookSecret     String?
  capabilities      String[]
  role              AgentRole    @default(WORKER)
  templateMarkdown  String?
  status            AgentStatus  @default(OFFLINE)
  lastHeartbeatAt   DateTime?
  maxConcurrent     Int          @default(0)
  lastDispatchedAt  DateTime?
  archivedAt        DateTime?
}
```

The columns worth knowing in detail:

| Column             | Purpose                                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | Internal identifier. Use this to reference an agent from API keys, dispatch rules, or issue assignments.                                                                         |
| `workspaceId`      | Tenant scope. An agent never crosses workspaces.                                                                                                                                 |
| `name`             | Human-facing display name. Free to change.                                                                                                                                       |
| `profileKey`       | Stable cross-system handle, unique per workspace. Matches the Hermes profile directory name (e.g. `victor`, `mizu`). Treat this like a username — addressable, mostly immutable. |
| `description`      | Free-form prose used in the agent picker and on the agent page.                                                                                                                  |
| `avatar`           | Optional URL or data-URI; falls back to the agent's initials.                                                                                                                    |
| `provider`         | Runtime family: `HERMES`, `CLAUDE`, `CODEX`, or `CUSTOM`. Hermes is first-class; Claude/Codex are supported as MCP clients today.                                                |
| `runtimeMode`      | `PERSISTENT` or `EPHEMERAL`. Hermes/custom bridges can be persistent; Claude and Codex are currently single-session, with persistent runners on the roadmap.                     |
| `webhookUrl`       | Where Forge POSTs assignment payloads. May also be the synthetic `agent:dispatch:{agentId}` shim — see [Activity & Audit](/concepts/activity-and-audit.html).                    |
| `webhookSecret`    | Per-agent HMAC secret. If unset, Forge falls back to the workspace synthetic secret.                                                                                             |
| `capabilities`     | Free-form lowercase tags consumed by `PRIORITY_MATCH` and `CAPABILITY_MATCH` dispatch. Use whatever vocabulary your agents announce.                                             |
| `role`             | `WORKER` (default), `COACH`, or `OBSERVER`. See [Roles](#roles).                                                                                                                 |
| `templateMarkdown` | Optional. When the agent is assigned an issue with an empty description, Forge prepends this content.                                                                            |
| `status`           | `ONLINE`, `OFFLINE`, or `BUSY`. Drives dispatcher eligibility.                                                                                                                   |
| `lastHeartbeatAt`  | Updated automatically on every successful webhook delivery.                                                                                                                      |
| `maxConcurrent`    | Cap on active issues; `0` means unlimited.                                                                                                                                       |
| `lastDispatchedAt` | Round-robin bookkeeping. Null sorts first, so brand-new agents pick up work immediately.                                                                                         |
| `archivedAt`       | When set, the agent is hidden from pickers and ineligible for auto-dispatch.                                                                                                     |

::: info
Agents are not users. They never log in, never own a session, and they don't
appear in the human members list. They show up in issue assignees, the agents
dashboard, and anywhere a human-or-agent picker is rendered.
:::

## Two assignment slots

An `Issue` carries two independent assignment columns:

- `claimedById` — the human user who owns the issue.
- `assignedAgentId` — the agent doing the work.

They coexist. A human can claim an agent's issue (to indicate review or
oversight) without displacing the agent, and an agent can be assigned to an
issue a human has claimed. The product surfaces both in the issue header and
treats them as orthogonal facts.

The MCP-facing affordance: a key with a `linkedAgentId` will resolve
`issues.assigned` to "issues assigned to that agent" without the caller having
to pass `profileKey`. See [Hermes Integration](/agents/hermes.html).

## Assignment vs. @mention

Manual assignment and comment mentions are intentionally different signals:

- **Assigning an agent** is a work-start signal. If the agent has a configured
  `webhookUrl`, Forge emits `AGENT_ASSIGNED` and routes it to that agent. A
  separate `@victor` / `@mizu` mention is not required just to start work.
- **Mentioning an agent in a comment** is a directed follow-up signal. Use it
  when the issue is already assigned/running and you need the agent to read a
  new comment now. Plain comments are recorded on the issue, but they do not
  wake every assigned agent unless that agent is explicitly mentioned or is
  watching the issue.
- **Watching an issue** is the subscription path for non-owner agents that
  should receive future issue events without becoming the assignee.

Rule of thumb: assign the agent to start or hand off ownership; `@mention` the
agent for subsequent “please read/respond to this comment” nudges.

### Hover an @profileKey to see who you're talking to

Every `@profileKey` chip in markdown — descriptions, comments, notes,
artifacts — opens a compact hover preview after a short dwell. The card
shows the agent's avatar + display name, status pill (ONLINE / BUSY /
OFFLINE), the first three capability tags (warm ember pills) with a
`+N` overflow chip for the rest, provider (HERMES / CLAUDE / CODEX /
CUSTOM), and last heartbeat. Clicking the name navigates to the agent
detail page; hover is purely additive. The same chip falls back to a
user card when the token is a workspace member's `@handle` rather than
an agent profile key.

Capabilities also surface as hover-titled pills in the agent picker
modal (`A` shortcut on the issue page → "Assign agent"), so operators
can disambiguate `triage-urgent` / `code-review` / etc. without
opening each agent's detail page.

## Lifecycle

A typical onboarding sequence:

1. **Define the identity.** Agent Studio → New profile starts with Hermes,
   Claude, Codex, or custom. Set `name`, `profileKey`, description, avatar,
   provider, and execution engine once.
2. **Choose the primary runtime.** A profile can select zero or one execution
   host. Active workspace bindings inherit later identity/execution edits.
3. **Bind it to a workspace.** The workspace roster owns local capacity,
   routing eligibility, engagement, approval, and capability overrides.
4. **Declare capabilities.** Lowercase, free-form. Common entries match
   priority names (`urgent`, `high`) for `PRIORITY_MATCH` and label names
   (`infra`, `frontend`) for `CAPABILITY_MATCH`.
5. **Set the role.** Default `WORKER`. Use `COACH` for an agent that posts
   diagnostic comments via [AI Coach](/agents/ai-triage-and-coach.html); use
   `OBSERVER` for an agent that should never auto-pick up work.
6. **Add MCP clients.** In Workspace → Agent access, issue one or more linked
   credentials for Codex, Claude, Hermes, or another MCP client. A linked key
   makes `agents.me`, `agents.heartbeat`, and `issues.assigned` self-aware
   without replacing the primary execution runtime.
7. **Bring it online.** Either call `agents.heartbeat`, flip `status` to
   `ONLINE`, or fire a webhook delivery — the first successful POST will flip
   OFFLINE → ONLINE automatically via `recordAgentReachable`.
8. **Receive assignments.** The dispatcher considers the agent eligible. See
   [Auto-dispatch](/agents/auto-dispatch.html).

```bash
# Example: create an agent via the tRPC HTTP endpoint
curl -sS https://forge.example/api/trpc/agents.create \
  -H "Content-Type: application/json" \
  -H "Cookie: $SESSION" \
  -d '{
    "json": {
      "workspaceId": "wks_axi",
      "name": "Victor",
      "profileKey": "victor",
      "description": "Lead engineering agent.",
      "provider": "HERMES",
      "runtimeMode": "PERSISTENT",
      "capabilities": ["urgent", "high", "infra", "backend"],
      "role": "WORKER",
      "maxConcurrent": 3
    }
  }'
```

## Heartbeat is push-driven

Forge does not require every agent to accept push delivery. The presence model is:

- Every successful webhook delivery to the agent's `webhookUrl` calls
  `recordAgentReachable`, which bumps `lastHeartbeatAt` and flips
  `status = OFFLINE` to `ONLINE`.
- MCP-only agents should call `agents.heartbeat` at startup and when their
  session changes state. This is the normal path for Claude and Codex today.
- Failed deliveries do not bump the heartbeat. After enough consecutive
  failures (see retries in [Activity & Audit](/concepts/activity-and-audit.html)),
  the agent stays at its last status; the worker eventually dead-letters the
  delivery.
- The idle sweep (next section) is what flips an agent back to OFFLINE.

::: tip
The `agents.heartbeat` MCP tool exists, but you should rarely need it. It's
for manual or out-of-band updates — for example, when an agent boots, before
it has any assignments, and wants to announce presence. Routine heartbeating
is implicit in the assignment round-trip.
:::

## Idle sweep

`Workspace.agentIdleTimeoutMinutes` controls staleness. When greater than zero,
a worker job runs on a schedule and flips agents to `OFFLINE` when their
`lastHeartbeatAt` is older than the timeout. Set to `0` to disable.

The sweep is intentionally one-way (online → offline). It never brings an
agent back online; that requires a successful delivery (implicit) or an
explicit `agents.heartbeat` call (manual).

## Roles

The `role` column is small but load-bearing. Three values:

- **`WORKER`** — the default. Eligible for auto-dispatch. Does work.
- **`COACH`** — eligible for [AI Coach](/agents/ai-triage-and-coach.html)
  attribution. The first non-archived COACH-role agent in the workspace is the
  author of any AI Coach comments. Coaches are also eligible for auto-dispatch
  unless `archivedAt` is set or `status = OFFLINE`.
- **`OBSERVER`** — never auto-dispatched. Can still be assigned manually
  (via the assignee picker, dispatch rule, or `issues.assign`). Useful for
  read-only agents that shouldn't be selected by the dispatcher but should
  still receive notifications when explicitly targeted.

::: warning
Changing an agent's role does not retroactively re-author existing comments.
A comment authored by an agent that was a `WORKER` at the time stays a
`WORKER` comment in the audit trail.
:::

## Per-agent issue templates

When an agent is assigned to an issue and that issue has an **empty**
description, Forge prepends the agent's `templateMarkdown` to the description.
This is a one-shot operation; if the description is non-empty, no template is
applied.

The common pattern is a checklist:

```markdown
## Triage checklist

- [ ] Reproduce the report
- [ ] Open a draft PR or write a postmortem note
- [ ] Move the issue to IN_REVIEW once a fix is up

---

(Original issue content below)
```

::: tip
Agent templates are a good place for "how I work" prose — preferred branch
naming, where the agent posts updates, escalation paths. Keep them short;
they're prepended in front of the operator's actual content.
:::

## Agent run controls

Once an agent is in flight on an issue, the operator can intervene
without waiting for the agent to notice. Each `AgentRun` carries a
`controlState` (`AgentRunControlState`):

| State              | Meaning                                                  |
| ------------------ | -------------------------------------------------------- |
| `NONE`             | Steady state. The run is proceeding normally.            |
| `PAUSE_REQUESTED`  | Operator asked the agent to pause on its next loop tick. |
| `CANCEL_REQUESTED` | Operator asked the agent to abort the run.               |

Three procs write the state:

- `agentRun.requestPause({ runId })`
- `agentRun.requestCancel({ runId })`
- `agentRun.requestRedirect({ runId, toAgentId })` — cancel + reassign,
  which triggers the regular `AGENT_ASSIGNED` dispatch chain for the
  new agent.

Each call:

1. Writes the new `controlState` plus `controlRequestedAt` and
   `controlRequestedById`.
2. Fires an `AGENT_RUN_CONTROL_REQUESTED` audit event.
3. POSTs an `AGENT_RUN_CONTROL` webhook to the agent's `webhookUrl`
   (best-effort, same plumbing as comment fan-out).

The runtime is responsible for honoring the request on its next loop
tick and resetting `controlState` to `NONE` (or transitioning the run
to a terminal state for cancel). Until the runtime acks, the UI
renders a "pause requested" / "cancel requested" badge so the operator
knows the request is in flight but not yet effective.

`RUN_PAUSED`, `RUN_RESUMED`, and `RUN_CANCELED` events are emitted by
runtimes that have adopted the protocol (Hermes; Claude Code via the
local `forge` daemon). Runtimes that haven't adopted it yet just don't
act on the requests; the request stays pending until the operator
clears it or the run reaches a terminal state on its own.

The agent UI surfaces these via `<RunControlMenu />` on each in-flight
pipeline row, with options for pause / cancel / redirect-to-…

## Stalled visibility

Forge tracks two distinct flavours of "stalled" — the difference matters
because the right response is different:

| Flavour           | Definition                                                                                                                                                                                                                                              | Where it surfaces                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stalled run**   | An `AgentRun` is still `ACTIVE` but `lastEventAt` is older than `STALE_RUN_MS` (5 min). Defined once in `src/lib/agent-stale.ts`; consumed by the Mission Control overlay, the agent detail page, the dashboard tile, and the `agentRun.kick` mutation. | Mission Control "Needs attention" lane, agent detail Stalled bucket, dashboard Agents tile (red `N stl` chip), Mission Control glance roster (per-agent red `N stl` pill). |
| **Stalled issue** | An issue is in `IN_PROGRESS` / `IN_REVIEW` and `updatedAt` is older than `Workspace.stalledThresholdDays` (default 7d, settings-driven, `0` disables).                                                                                                  | Inbox "Stalled" sub-buckets (yours / agents), dashboard "Stalled" column, agent detail Stalled bucket, dashboard Agents tile (warning `N quiet` chip).                     |

A stalled _run_ is usually a runtime glitch — the agent's last loop tick
crashed, the webhook didn't deliver, the runner is offline. The
operator's first move is the **Kick** button (`agentRun.kick`), which
re-fires the dispatch webhook without changing assignment.

A stalled _issue_ is usually a design / dependency wait — the agent did
its turn and is now waiting on a human review, an external dependency,
or a clarifying answer in the comment thread. There is no "Kick" for
issues; the right move is to read the thread, comment, and possibly
reassign.

The agent detail page's Stalled bucket renders both lists side-by-side.
When the same issue appears in both (an issue is past the day-threshold
_and_ its run is past the 5-minute threshold), the issue row carries an
"also stalled run" tag so the operator doesn't read the same incident
twice.

The dashboard's Agents tile aggregates per-agent counts so a single
glance tells you which agent is worst off. Sorted by stalled-run count
first — runtime glitches are the higher-urgency signal.

The Mission Control glance view shows per-agent stalled-run pills next
to the load fraction so the floating widget gives the same signal
without leaving the current page.

## Where to look

- **Agents dashboard** — `/w/<slug>/agents`. List of all non-archived agents
  with status, last heartbeat, in-flight load, and recent activity.
- **Agent detail page** — `/w/<slug>/agents/<id>`. Pipeline (assigned-but-not-
  yet-acked → in-progress → recent), timeline (assignment, ack, transition,
  comment events), uptime sparkline, webhook delivery health.
- **Settings → Agents** — `/w/<slug>/settings/agents`. Create, edit, archive.
- **Settings → Workspace** — `/w/<slug>/settings/workspace`. The dispatch
  knobs that govern agent selection.
- **Settings → Dispatch Rules** — declarative routing, evaluated before
  mode-based selection.

## Cross-references

- [Orchestration loop](/concepts/orchestration.html) — the second way to run
  agent work: Goal → plan → crew loop, and how its steps open runs and can
  become issues.
- [Engagement modes](/agents/engagement-modes.html) — _how far_ a dispatch
  takes the work (execute / research / review / discuss).
- [Chat & Dispatch engines](/agents/engines.html) — _who owns the loop_ for a
  run (Forge-owned Completions vs. runtime-owned Runs).
- [Hermes Integration](/agents/hermes.html) — how `profileKey` maps to a
  Hermes runtime profile, and what the MCP self-management loop looks like.
- [Auto-dispatch](/agents/auto-dispatch.html) — the four modes that govern
  who picks up an unassigned issue.
- [Dispatch Rules](/agents/dispatch-rules.html) — declarative routing layered
  on top of auto-dispatch.
- [SLAs & Watchdogs](/agents/slas-and-watchdogs.html) — what happens when
  agents drop, stall, or breach.
- [AI Triage & Coach](/agents/ai-triage-and-coach.html) — the only first-party
  AI features, and where COACH-role agents come in.
- [Chat](/agents/chat.html) — per-agent persistent chat threads, streaming replies,
  and slash commands.
- [Runtime Modes](/agents/runtime-modes.html) — PERSISTENT vs EPHEMERAL, heartbeat
  sources, and the idle sweep.
- [Integrations](/agents/integrations.html) — adapter manifests and key lifecycle
  per runtime type.
