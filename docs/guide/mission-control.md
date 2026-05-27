# Mission Control

Mission Control is the cross-workspace home — the screen at `/` when you
sign in. Where a workspace shows you one tenant's world, Mission Control
shows you *all of them at once*: your assigned work, your agents, your
runtimes, and live activity, each row stamped with the workspace it
belongs to.

::: tip Chord
<kbd>g</kbd> <kbd>h</kbd> brings you home to Mission Control from
anywhere. It's the first item in the global rail (the **Mission
Control** nav row).
:::

## The concourse shell

Mission Control renders inside the global ("concourse") shell — a
distinct chrome from the per-workspace shell. The left rail carries
three global destinations, the workspace switcher, and links into
account-level settings:

- **Mission Control** (`/`) — this page.
- **Inbox** (`/inbox`) — your mentions and assignments, aggregated
  across workspaces.
- **Activity** (`/activity`) — the live cross-workspace run + event feed.

Everything in the concourse is **read-only**. The cards show you what's
happening and link you *into* the right workspace; the actual
writes — transitioning an issue, replying to a comment, dispatching an
agent — happen once you've clicked through into that workspace's shell.
This is deliberate: a single mutation always has one unambiguous tenant.

## The cards

The page is a metric strip over a 12-column card grid. All data streams
client-side from the `global.*` tRPC routers.

### Metric strip

Four tiles across the top:

| Tile | Shows |
|---|---|
| **Assigned to me** | Count of issues assigned to you, across every workspace |
| **Open issues** | Open-issue count summed across all your workspaces |
| **Agent runs · live** | Active `AgentRun` count, plus how many agents are online |
| **Runtimes online** | `online / total` runtimes you've registered |

### My work

Issues assigned to you, anywhere. Each row carries a workspace chip, the
issue id (`KEY-number`), title, current status, and last-updated time.
Clicking a row takes you to that issue inside its workspace.

### Workspaces

One card per workspace you belong to, with its avatar, key, and a quick
rollup (`open · live · members`). Click to enter the workspace. The
**manage** link goes to `/settings/workspaces`.

### My agents

Your agent **profiles** (global definitions you own), each with an
online pip, `@profileKey`, the workspaces it's bound into, and its
provider. Click through to the profile detail under `/settings/agents`.
See [Agent profiles & bindings](/agents/profiles-and-bindings.html) for
the profile → binding model.

### Runtimes

The compute hosts you've registered, with a kind glyph
(`LOCAL_DAEMON` / `REMOTE_HTTP` / `CLOUD`), an online pip, and last
heartbeat. Empty until you run `forge daemon start` on a host. See
[Runtimes](/agents/runtimes.html).

### Activity

A compact live feed of recent events across all workspaces — each row
dense-chipped with its workspace, the event kind, and the actor.

## The workspace switcher

Three ways to switch tenants from the concourse:

1. **The rail switcher** — a Slack-style list of your workspaces in the
   left rail. Each shows its badge, key, and a mention count when you
   have unread @-mentions there. Click to enter.
2. **⌘K / "Search everywhere"** — the command palette at the top of the
   rail jumps across workspaces, issues, and destinations.
3. **The Workspaces card** — on the Mission Control body itself,
   clicking a workspace card enters it.

Entering a workspace switches you into its per-workspace shell; the
concourse rail is replaced by that workspace's navigation. Come back to
the concourse with <kbd>g</kbd> <kbd>h</kbd>.

## /inbox and /activity (global)

These are the cross-workspace versions of the per-workspace surfaces:

- **`/inbox`** — the same bucketed inbox model (queue, mentions,
  stalled, …) but unioned across every workspace you're in, so you
  don't have to hop tenants to clear your plate. See
  [Inbox](/guide/inbox.html) for the bucket semantics.
- **`/activity`** — the live event/run stream for everything you can
  see. The pulsing **Activity** pill in the topbar (<kbd>5</kbd>) opens
  it.

## Where to next

- [Workspaces](/guide/workspaces.html) — what a single tenant contains.
- [Inbox](/guide/inbox.html) — the bucket model the global inbox reuses.
- [Agent profiles & bindings](/agents/profiles-and-bindings.html) — the
  agents and runtimes the cards summarize.
- [Instance admin](/guide/instance-admin.html) — the separate `/admin`
  shell for instance operators.
