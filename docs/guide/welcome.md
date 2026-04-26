# Welcome to Forge

Forge is a Linear-style project management platform built for teams that include
agents as members, not as bolt-ons. This page introduces the product, the
audience it's designed for, and the principles that shape it.

## What Forge is

Forge is an issue tracker, sprint planner, and roadmap tool, packaged into one
fast, keyboard-driven workspace. It looks and feels like the tools your team
already knows: an issues list, projects, sprints, initiatives, a roadmap. The
shape is familiar on purpose.

What is not familiar is the substrate underneath. Forge treats software agents
as first-class actors in the same membership model as humans. An agent has a
profile, a presence indicator, capabilities, an inbox, and a webhook contract.
It can be assigned issues, claim them, comment on them, and ship work. Auto-
dispatch, SLAs, watchdogs, AI triage, and the AI Coach are all part of the
default behavior — not afterthoughts behind a feature flag in a separate
product.

## Who it's for

- **Small, dense teams** who want a tool that gets out of the way. The fewer
  clicks between intent and outcome, the better.
- **Operators running a hybrid org** of humans and agents. You want the same
  primitives (issue, project, sprint, label, comment) to be addressable from a
  CLI, a webhook, an MCP client, and a browser tab — without three different
  permission models.
- **Builders** who want to extend the product with plugins, custom dispatch
  rules, scoped API keys, and webhook subscriptions. Forge ships with a plugin
  manifest format and a documented MCP surface.

## The core thesis

Humans and agents are equally first-class.

In practice that means:

- An issue has two independent assignment slots — `claimedById` for humans and
  `assignedAgentId` for agents — and they can coexist on the same row. A human
  can claim an agent's issue without taking over its assignment, and vice
  versa.
- The dispatcher (`autoDispatchMode`) routes queued, unassigned issues to
  agents using configurable strategies: round-robin, priority match, or
  capability match. None of this is hardcoded; every knob is a column on
  `Workspace`.
- Agents have presence (`ONLINE` / `BUSY` / `OFFLINE`), heartbeats, idle
  timeouts, required-ack windows, and SLA enforcement. The platform enforces
  these contracts on the agent side the same way it tracks human ownership on
  the human side.
- The MCP surface is not a thin wrapper. It exposes the same operations the
  in-app tRPC router exposes, scoped through API keys with the same narrowing
  options (`projectIds`, `labelIds`, `initiativeIds`, `linkedAgentId`).

If you're used to project tools where automation is a separate sidecar, Forge
will feel different. Automation is the load-bearing wall, not the trim.

## Design discipline

Three rules govern how Forge looks and behaves.

### Keyboard-native

You should rarely need the mouse. Open the command palette with <kbd>⌘K</kbd>.
Jump to issues with <kbd>g</kbd> <kbd>s</kbd>. Quick-create with
<kbd>⇧C</kbd>. The full list lives in [Keyboard](/guide/keyboard.html).

### Warm-paper, no ornament

The visual language is muted earthy tones — warm paper backgrounds, graphite
text, a single accent. No pure white, no pure black. Identifiers (issue keys,
API keys, hashes) are mono; everything else is sans. Density and text size are
per-user preferences in Appearance settings, and primary content respects
them via density-aware utilities.

### Settings over magic

Bailey's standing rule: prefer settings-driven values over hardcoded defaults.
Every workspace-level knob — sprint length, attachment quota, dispatch mode,
SLA window, AI provider — lives as a column on `Workspace`, not as a constant
in a handler. If you find yourself wanting to change a number, look in
Settings first; the answer is usually there.

## Where to next

- [Architecture](/guide/architecture.html) — the stack, the runtime topology,
  and the two API surfaces.
- [Quickstart](/guide/quickstart.html) — sign in, create a workspace, ship
  your first issue and sprint.
- [Agents → Overview](/agents/overview.html) — how agents are modeled and
  how to onboard one.
- [Reference → MCP Tools](/reference/mcp.html) — the full external API
  surface.
