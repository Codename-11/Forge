# What's New

The dashboard's **What's New** rail surfaces the most recent entries
from Forge's repository changelog. It's the "what changed in Forge
recently" tile — minimal, terse, and always one click away from the
full page.

## Where the data comes from

The single source of truth is `CHANGELOG.md` at the root of the
Forge repo, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The
file is read at request time by the `system.changelog` tRPC proc and
cached in process memory keyed off the file's mtime — so a
container reads the file once per boot and re-reads only when it
changes on disk.

There's no admin UI for editing the changelog; it's part of the
codebase, reviewed in pull requests like any other source file.

## What's shown on the dashboard

- The most recent entry's heading + up to four bullets.
- A short list of the next few entries' headings (no bullets) so
  the rail signals "there's more here".
- A **View all** link to `/w/{slug}/whats-new` for the complete
  history rendered with the same warm-paper styling as the rest of
  Forge.

Each bullet is tagged with its kind: **added**, **changed**,
**fixed**, or **removed**. Unknown subsections (anything outside
those four headings) are ignored by the parser.

## Authoring conventions

- One line per item. The dashboard rail strips simple emphasis
  (`**bold**`, `` `code` ``) for the compact display; the full page
  keeps the original text.
- Keep entries terse — link to the relevant DEVLOG section or a
  PR if a longer story is needed.
- Group every entry under one of `### Added`, `### Changed`,
  `### Fixed`, `### Removed`.

## Scaffolding new entries

Run `pnpm changelog` to draft a fresh `[Unreleased]` block from
recent activity. The script reads `CHANGELOG.md` for the most
recent dated heading, then inspects:

- `git log --no-merges --since=<that-date>` — categorised by
  conventional-commits prefix (`feat:` → Added, `fix:` → Fixed,
  `refactor:` / `polish:` / etc → Changed, `feat!:` / `BREAKING`
  → Removed).
- `DEVLOG.md` headings dated after the same anchor — emitted as a
  `Source DEVLOG entries` block so reviewers can cross-reference.

Output goes to **stdout only** — the script never writes to
`CHANGELOG.md` directly. Review the draft, edit the bullets to
match the user-facing voice (terser than commit subjects), then
paste into the file.

## Where to next

- [Today widget](/guide/today-widget.html) — the dashboard tile that
  sits above What's New.
- [DEVLOG](/guide/architecture.html) — the engineering session log
  for deeper context behind each release.
