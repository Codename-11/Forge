# Agents

Agents are first-class actors in Forge — rows in the same database as humans,
assigned to issues, dispatched by rules, observed via heartbeat.

This page covers the data model, the human/agent dual-assignment story, the
lifecycle of an agent, the implicit heartbeat that comes from webhook delivery,
and where to find each piece of the surface in the app.

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

| Column | Purpose |
| --- | --- |
| `id` | Internal identifier. Use this to reference an agent from API keys, dispatch rules, or issue assignments. |
| `workspaceId` | Tenant scope. An agent never crosses workspaces. |
| `name` | Human-facing display name. Free to change. |
| `profileKey` | Stable cross-system handle, unique per workspace. Matches the Hermes profile directory name (e.g. `victor`, `mizu`). Treat this like a username — addressable, mostly immutable. |
| `description` | Free-form prose used in the agent picker and on the agent page. |
| `avatar` | Optional URL or data-URI; falls back to the agent's initials. |
| `webhookUrl` | Where Forge POSTs assignment payloads. May also be the synthetic `agent:dispatch:{agentId}` shim — see [Activity & Audit](/concepts/activity-and-audit.html). |
| `webhookSecret` | Per-agent HMAC secret. If unset, Forge falls back to the workspace synthetic secret. |
| `capabilities` | Free-form lowercase tags consumed by `PRIORITY_MATCH` and `CAPABILITY_MATCH` dispatch. Use whatever vocabulary your agents announce. |
| `role` | `WORKER` (default), `COACH`, or `OBSERVER`. See [Roles](#roles). |
| `templateMarkdown` | Optional. When the agent is assigned an issue with an empty description, Forge prepends this content. |
| `status` | `ONLINE`, `OFFLINE`, or `BUSY`. Drives dispatcher eligibility. |
| `lastHeartbeatAt` | Updated automatically on every successful webhook delivery. |
| `maxConcurrent` | Cap on active issues; `0` means unlimited. |
| `lastDispatchedAt` | Round-robin bookkeeping. Null sorts first, so brand-new agents pick up work immediately. |
| `archivedAt` | When set, the agent is hidden from pickers and ineligible for auto-dispatch. |

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

For the MCP-facing affordance: a key with a `linkedAgentId` will resolve
`issues.assigned` to "issues assigned to that agent" without the caller having
to pass `profileKey`. See [Hermes Integration](/agents/hermes.html).

## Lifecycle

A typical onboarding sequence:

1. **Create the agent.** Settings → Agents → New, or via tRPC. Set `name`,
   `profileKey`, `description`, and an avatar. The agent starts at
   `status = OFFLINE`.
2. **Set the webhook.** Either configure a real `webhookUrl` plus
   `webhookSecret`, or leave it as the synthetic dispatch shim and let the
   worker resolve it at delivery time.
3. **Declare capabilities.** Lowercase, free-form. Common entries match
   priority names (`urgent`, `high`) for `PRIORITY_MATCH` and label names
   (`infra`, `frontend`) for `CAPABILITY_MATCH`.
4. **Set the role.** Default `WORKER`. Use `COACH` for an agent that posts
   diagnostic comments via [AI Coach](/agents/ai-triage-and-coach.html); use
   `OBSERVER` for an agent that should never auto-pick up work.
5. **Bring it online.** Either flip `status` to `ONLINE` directly, or fire a
   webhook delivery — the first successful POST will flip OFFLINE → ONLINE
   automatically via `recordAgentReachable`.
6. **Receive assignments.** The dispatcher considers the agent eligible. See
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
      "capabilities": ["urgent", "high", "infra", "backend"],
      "role": "WORKER",
      "maxConcurrent": 3
    }
  }'
```

## Heartbeat is push-driven

Forge does not require agents to poll. The presence model is:

- Every successful webhook delivery to the agent's `webhookUrl` calls
  `recordAgentReachable`, which bumps `lastHeartbeatAt` and flips
  `status = OFFLINE` to `ONLINE`.
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
