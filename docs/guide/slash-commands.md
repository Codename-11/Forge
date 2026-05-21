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

## Autocomplete

Both the QuickCreate input (issue / sub-issue modes) and the comment
composer surface a small dropdown when the cursor sits on a
top-of-body line that starts with `/`. The dropdown lists the seven
command keywords + a one-line example for each.

Keys:

| Key | Effect |
|---|---|
| <kbd>↓</kbd> / <kbd>↑</kbd> | Move the active selection |
| <kbd>Enter</kbd> / <kbd>Tab</kbd> | Insert the active command's stub (e.g. `/assign `) |
| <kbd>Esc</kbd> | Dismiss without inserting |
| Click | Inserts as if Enter were pressed |

So typing `/a` then <kbd>Tab</kbd> expands to `/assign ` with the
caret right after the trailing space — ready for the argument. The
dropdown only opens when the line is in the contiguous top-of-body
slash block; once you've typed prose below, it stops auto-opening
on later slashes.

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

## Comment templates

The issue-detail comment composer also surfaces four **quick-comment
templates** in the autocomplete dropdown, on top of the seven commands
above. Templates expand to a templated comment body in-place (and, in
two cases, fire a follow-up mutation):

| Template | Expands to | Side-effect |
|---|---|---|
| `/status [<next-step>]` | `**Status:** Working on <next-step>` | — |
| `/blocked <reason>` | `**Blocked:** <reason>` | Opens an action request titled "Unblock needed" |
| `/approve` | `**Approved** ✓` | — |
| `/handoff @<agent> [<context>]` | Prepends `/assign @<agent>`, then `**Handing off to @<agent>:** <context>` | Reassigns to the named agent (via the existing `/assign` path) |

Templates are composer-only; QuickCreate sticks to the seven field-setting
commands. See [Issues → Quick-comment slash templates](/guide/issues.html#quick-comment-slash-templates)
for the full UX walk-through.

## Where to next

- [Issues](/guide/issues.html) — the primary write surface.
- [Watching](/guide/watching.html) — the `/watch` target.
- [Keyboard](/guide/keyboard.html) — chord reference.
