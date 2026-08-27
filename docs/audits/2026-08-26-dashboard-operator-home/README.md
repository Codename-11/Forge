# Dashboard operator-home audit

## Problem

The previous dashboard used independently flowing card stacks. At common desktop
widths that made the left column end early while the right column continued,
creating large empty regions and obscuring the page's primary question: what
needs the operator now?

## Implemented direction

- One deterministic work surface assigns each issue to exactly one of `Now`,
  `Next`, or `Waiting`, with one recommended action above the trace.
- A fixed attention rail separates decisions, agent exceptions, and blocked
  work instead of mixing every alert into one feed.
- Agents and the current week remain compact secondary context.
- Workspace health is a single collapsible drawer. Pipeline, Throughput,
  Standup, and What's New stay visible together when expanded.
- Only What's New can be cleared; the drawer and operational metrics remain.
- Mobile keeps the same semantic order and uses dense list rows instead of a
  compressed desktop grid.

## Evidence

- `selected-dashboard-operator-home.png` — approved visual direction.
- `before-dashboard-overview.png` and `before-workspace-flow-gap.png` — source
  layout evidence.
- `after-dashboard-desktop.png` and `after-dashboard-mobile.png` — rendered
  local implementation.
- `source-vs-implementation.png` — side-by-side visual comparison.
