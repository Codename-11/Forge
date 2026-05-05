# Slash Commands

Inline shortcuts for setting fields when you're typing an issue title
or a comment. Type the command at the start of the line, type the
content below it, and Forge applies both in one shot.

## Where they work

Two surfaces parse leading slash commands today:

| Surface | Notes |
|---|---|
| **QuickCreate** (<kbd>⇧ C</kbd>) | Issue and Sub-issue modes. Commands appear on their own line(s) at the start; the cleaned tail becomes the issue title. |
| **Comment composer** | On the issue detail page. Cleaned body is posted as the comment; commands fire as a separate mutation right after. |

Commands DON'T parse on cycles, projects, or initiatives — those have
their own full-form dialogs.

## The seven commands

| Command | Argument | Effect |
|---|---|---|
| `/assign` | `@handle` | Set the issue's `assignedAgent` by `profileKey` (e.g. `victor`, `mizu`). |
| `/due` | `today` / `tomorrow` / `in 3 days` / `in 1 week` / `next Monday` / `2026-05-15` / `May 15` | Set `dueDate`. |
| `/label` | `<name>` | Attach a Label by name (case-sensitive). |
| `/priority` | `urgent` / `high` / `medium` / `low` / `none`<br/>or `!!!` / `!!` / `!` / `·` | Set `priority`. |
| `/project` | `<KEY>` | Set `projectId` by `Project.key` (e.g. `AXI`, `ENG`). |
| `/watch` | _(no arg)_ | Add the caller as a watcher. |
| `/unwatch` | _(no arg)_ | Remove the caller as a watcher. |

## Examples

Create a triage-ready issue from QuickCreate:

```
/assign @victor
/priority high
/label deploy
The deploy script silently swallows non-zero exit codes.
```

Apply commands via a comment:

```
/priority urgent
/watch
This needs attention before EOD.
```

Or just commands, no body — the form fires `applyCommands` directly
without posting a comment:

```
/assign @mizu
/due tomorrow
```

## Parsing rules

- Commands appear on their own lines at the **start** of the body —
  contiguously, before any prose.
- Lines inside a fenced code block (```` ``` ````) are NOT parsed —
  whatever you wrap in code stays verbatim.
- An unrecognised slash form (e.g. `/foo bar`) breaks the parse and
  is left in the body.
- Leading blank lines before the first command are skipped.
- Blank lines between commands are also fine.

## Errors and skips

Commands are best-effort. If a referenced label, project, or agent
doesn't exist, the server logs the skip and toasts a one-line
warning — but the issue / comment still goes through.

A toast like:

> 1 command skipped: /label (label not found)

means the body posted, but the `bug` label wasn't on the workspace.

## Agent integration

Agents can either let the server text-parse the body OR (preferred)
pass a pre-parsed `applyCommands` array on `issue.create`:

```ts
forge_issues.create({
  title: "Investigate 500s on /api/mcp/rpc",
  description: "...",
  applyCommands: [
    { kind: "priority", level: "urgent" },
    { kind: "label", name: "platform" },
    { kind: "watch" },
  ],
})
```

Or via a comment:

```ts
forge_issue.applyCommands({
  issueId,
  commands: [{ kind: "watch" }, { kind: "due", date: tomorrow }],
})
```

Explicit `applyCommands` is more reliable than text-parsing — there's
no surprise from a label name with weird whitespace or a `/` in a
filename.

## Where to next

- [Issues](/guide/issues.html) — the primary write surface.
- [Watching](/guide/watching.html) — the `/watch` target.
- [Keyboard](/guide/keyboard.html) — chord reference.
