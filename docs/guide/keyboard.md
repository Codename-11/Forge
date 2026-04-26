# Keyboard

Forge is keyboard-native. Almost every action you take in the UI has a
chord that gets you there faster than the mouse. This page is the
reference. The same table is available in-app behind <kbd>?</kbd>.

## How chords work

A chord is a sequence of keys pressed in order. `g` then `s` is two key
presses, not held simultaneously — press <kbd>g</kbd>, release, press
<kbd>s</kbd>. You have ~1 second between presses; longer than that and the
chord resets.

`⌘` is **Cmd** on macOS and **Ctrl** on other platforms. `⇧` is Shift.
Single-key chords are case-insensitive in display but uppercase here for
the convention.

Chords respect typing context. When focus is in a text input or textarea,
shortcuts that would conflict with typing (single letters, especially
`g`-prefixed nav) don't fire. <kbd>⌘K</kbd> always fires; it's safe across
contexts.

## Reference

### Navigate

| Chord | Action |
|---|---|
| <kbd>g</kbd> <kbd>i</kbd> | Inbox |
| <kbd>g</kbd> <kbd>b</kbd> | Browse |
| <kbd>g</kbd> <kbd>s</kbd> | Issues |
| <kbd>g</kbd> <kbd>p</kbd> | Projects |
| <kbd>g</kbd> <kbd>c</kbd> | Sprints |
| <kbd>g</kbd> <kbd>n</kbd> | Initiatives |
| <kbd>g</kbd> <kbd>r</kbd> | Roadmap |
| <kbd>g</kbd> <kbd>u</kbd> | Standup |
| <kbd>g</kbd> <kbd>t</kbd> | Time |
| <kbd>g</kbd> <kbd>a</kbd> | Analytics |
| <kbd>g</kbd> <kbd>o</kbd> | Agents (ops) |
| <kbd>g</kbd> <kbd>e</kbd> | Agents (admin) |
| <kbd>g</kbd> <kbd>l</kbd> | Plugins |
| <kbd>g</kbd> <kbd>,</kbd> | Settings |
| <kbd>g</kbd> <kbd>w</kbd> | Switch workspace |

::: tip
The mnemonic for `g` is "go." Most secondary letters match the first
letter of the destination — `s` for issues (the iSsues list), `p` for
projects, `c` for sprints (cycles, internally), `n` for initiatives
(iNitiatives), `r` for roadmap. A few are arbitrary; commit them to
muscle memory once and they stick.
:::

### Shell

| Chord | Action |
|---|---|
| <kbd>⌘K</kbd> | Command palette |
| <kbd>/</kbd> | Search |
| <kbd>?</kbd> | Help overlay |
| <kbd>⌘\\</kbd> | Toggle sidebar |
| <kbd>esc</kbd> | Close current dialog/drawer |

The command palette (<kbd>⌘K</kbd>) is the universal entry point. It can
open any page, run any action, jump to any issue or project by key, and
trigger most workspace-level commands. If you forget a chord, open the
palette and type — the matching command shows its chord next to it.

### Create

| Chord | Action |
|---|---|
| <kbd>⇧C</kbd> | Quick-create issue |

The quick-create dialog covers the common-case fields: title, description,
status, priority, project, kind. For sub-issues, attachments, relations,
or agent assignment at create time, navigate to `/w/<slug>/issues/new`
(or use the palette: type "New issue page").

### Work

| Chord | Action |
|---|---|
| <kbd>c</kbd> | Open active sprint |
| <kbd>⇧A</kbd> | Assign agent (in issue detail) |

<kbd>c</kbd> is a global chord. From any page, it opens the currently
active sprint. If multiple sprints are active (uncommon), it opens the
most recently started.

<kbd>⇧A</kbd> is contextual — it only fires inside an issue detail view.
It opens the agent picker (filtered by capabilities and presence) so you
can hand the issue to a specific agent without leaving the page.

### Pins

| Chord | Action |
|---|---|
| <kbd>p</kbd> | Toggle pin (in issue detail) |

Pin an issue to surface it on your inbox. Pins are per-user. Pin
arbitrary issues you're tracking even if you're not assigned.

### Time

| Chord | Action |
|---|---|
| <kbd>t</kbd> | Toggle time-tracker widget |
| <kbd>⇧T</kbd> | Start/stop timer (in issue detail) |

<kbd>t</kbd> shows or hides the persistent time-tracker widget. The
widget shows your currently running entry (if any) and exposes stop.
<kbd>⇧T</kbd> is contextual to an issue detail — it starts a timer
against that issue, or stops the open timer if there is one.

Time chords only do anything if `Workspace.timeTrackingEnabled` is `true`.
Otherwise they no-op.

## A pragmatic order to learn them in

Don't try to memorize the whole table. Internalize them in waves.

**First.** <kbd>⌘K</kbd>, <kbd>⇧C</kbd>, <kbd>g</kbd> <kbd>s</kbd>,
<kbd>esc</kbd>. With these four you can navigate to issues, create one,
back out, and find anything else by typing.

**Second.** <kbd>g</kbd> <kbd>p</kbd>, <kbd>g</kbd> <kbd>c</kbd>,
<kbd>g</kbd> <kbd>u</kbd>, <kbd>c</kbd>. Projects, sprints, standup,
active sprint. The daily working set.

**Third.** <kbd>⇧A</kbd>, <kbd>p</kbd>, <kbd>t</kbd> / <kbd>⇧T</kbd>.
Issue actions and time tracking, when you start using them.

**Fourth.** Everything else, as needed.

## Typing context

A note worth repeating: **shortcuts respect typing context.** When focus
is in a text input or textarea — title field, description, comment box,
filter input — single-letter chords don't fire. You can type freely
without accidentally navigating away.

The exceptions are:

- <kbd>⌘K</kbd> — always fires.
- <kbd>esc</kbd> — always fires (and the convention is "leave this
  context").
- <kbd>⌘\\</kbd> — always fires.

If you press a chord and nothing happens, check whether you have a text
input focused. <kbd>esc</kbd> first, then the chord.

## Where to next

- [Quickstart](/guide/quickstart.html) — chords in action.
- [Issues](/guide/issues.html) — the common chord targets.
- [Settings](/guide/settings.html) — workspace and user options.
