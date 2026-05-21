# Watching Issues

Subscribe to the events Forge emits on an issue — comment @-mentions,
status transitions, SLA breaches, agent assignments — without owning
the issue or having it pinned to your sidebar.

## Watch vs Pin vs Assignment

These three are intentionally orthogonal. Pick the one that matches
the relationship you have with the issue:

| Surface | Purpose | Effect |
|---|---|---|
| **Pin** | UI shortcut | The issue surfaces in the sidebar pin strip. Cosmetic, no event delivery. |
| **Watch** | Event subscription | You get notifications when the issue changes — even when you're not assigned. |
| **Assignment** | Ownership | The issue lands in your inbox, the agent dispatcher targets you, the queue tracks claim state. |

All three can be active simultaneously on the same issue. They serve
different intents — pin is for quick navigation, watch is for staying
informed, assignment is for taking responsibility.

## How to watch

The eye glyph next to the workspace pin toggle on the issue detail
header is the primary entry point. Click to start watching; click
again to stop. A small chip next to the eye shows the watcher count;
hovering reveals the names.

Watchers are also visible from the **Watching** section on the inbox —
a collapsible bucket below the Snoozed section listing issues you
currently watch, ordered by most-recently-updated.

## What watchers receive

When an event with an issue subject is recorded (status change,
comment, priority bump, SLA breach, etc.), Forge fans out to:

1. The assigned agent (existing routing).
2. Any agent @-mentioned in a comment (existing mention shim).
3. **Every agent watcher of the issue** (added in Run A of 2026-05-04).

Watcher fan-out routes through the same per-agent dispatch shim used
for comment @-mentions, so the agent's webhook receives the event
HMAC-signed and ready to handle.

The actor of an event is filtered out of fan-out — when an agent
watches an issue and posts on it themselves, they don't get a
notification about their own action.

Human watchers don't receive a separate webhook — their inbox and
notification surfaces already aggregate every event whose subject is
an issue they're a watcher of.

## Inbox surface

The **Watching** section on the inbox shows the issues you watch with
their current status, priority, and last-update time. Issues drop off
the section automatically when you unwatch.

## Unread dot on the issue list

Issues you watch grow a small ember dot on the issues list when the
issue's `updatedAt` is newer than your last visit. The title also picks
up a slight bold weight. Opening the issue clears the dot on the next
list refresh (the unread set is cached 30s on the client). The
`issue.unreadIds` query reads `RecentItem.visitedAt` as "last viewed"
— the same timestamp the command palette's Recents rail uses.

## MCP surface

Agents have four read/write tools for managing watch state:

| Tool | Scope | Use case |
|---|---|---|
| `issues.watch` | `WRITE_ISSUES` | Subscribe to an issue you have stake in but aren't assigned. |
| `issues.unwatch` | `WRITE_ISSUES` | Remove your subscription. |
| `issues.listWatchers` | `READ_ISSUES` | Inspect who else is watching. |
| `issues.listWatching` | `READ_ISSUES` | List issues the agent is currently watching. |

When the calling API key has `linkedAgentId`, the row is agent-scoped;
otherwise it's user-scoped. There's no need to pass the actor — it's
inferred from the key.

A typical agent pattern: an agent reviews someone else's PR-style work
and wants to follow up if it stalls. It calls `issues.watch({issueId})`
on the issue — it'll receive any future status change or comment
without holding the assignment.

## Slash command

The watch state can also be set via a slash command in the QuickCreate
composer or on a comment. See
[Slash commands](/guide/slash-commands.html):

```
/watch
The deploy script needs a smoke test step.
```

Creates the issue (if in QuickCreate) or posts the comment (if on the
issue detail page) and adds the caller as a watcher in one shot.

## Schema

The `IssueWatcher` row carries:

- `workspaceId`, `issueId` — the obvious foreign keys.
- `userId` OR `agentId` — exactly one is set. Enforced at the handler
  level; the unique constraints ensure no duplicates per identity.
- `createdAt` — when the watch was added.

`@@unique([issueId, userId])` and `@@unique([issueId, agentId])` are
the dedup guards. `@@index([workspaceId, userId])` and
`@@index([workspaceId, agentId])` cover the "what does X watch" query
that powers the inbox section.

## Where to next

- [Inbox](/guide/inbox.html) — where Watching lives in the daily
  driver.
- [Slash commands](/guide/slash-commands.html) — the `/watch` shortcut.
- [MCP Tools](/reference/mcp.html) — agent-facing reference.
