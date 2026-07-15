# Mission Control

Mission Control is Forge's cross-workspace operating layer. The overview at
`/` shows every workspace at once; **Agents** at `/agents` is the global fleet
control plane for defining identities, binding them into workspaces, and
monitoring live use.

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
- **Agents** (`/agents`) — global profiles, execution connections, workspace
  bindings, recent runs, and safe archive/removal controls.
- **Inbox** (`/inbox`) — your mentions and assignments, aggregated
  across workspaces.
- **Activity** (`/activity`) — the live cross-workspace run + event feed.

The overview, Inbox, and Activity remain **read-only across workspaces**. The
Agents destination is the deliberate exception and carries a **Global control
plane** scope label. Its binding writes always name one workspace explicitly
and require an owner/admin membership there; workspace policy edits still
happen inside that workspace's settings.

## The cards

The page is a metric strip over a 12-column card grid. All data streams
client-side from the `global.*` tRPC routers.

### Metric strip

Four tiles across the top:

| Tile                  | Shows                                                    |
| --------------------- | -------------------------------------------------------- |
| **Assigned to me**    | Count of issues assigned to you, across every workspace  |
| **Open issues**       | Open-issue count summed across all your workspaces       |
| **Agent runs · live** | Active `AgentRun` count, plus how many agents are online |
| **Runtimes online**   | `online / total` runtimes you've registered              |

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
provider. Click through to the profile detail under `/agents`.
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
