#!/usr/bin/env tsx
/**
 * CHANGELOG.md scaffolder.
 *
 * Reads `DEVLOG.md` + `git log` since the most recent dated version in
 * `CHANGELOG.md` and prints a draft Keep-a-Changelog entry to stdout.
 * The user copy-pastes into `CHANGELOG.md` after review — this script
 * never writes to the changelog itself, so the human-curated nature
 * of release notes stays intact.
 *
 * Categorization is conventional-commits-ish:
 *   feat:                 → Added
 *   feat!: / BREAKING     → Removed/Changed (with note)
 *   fix:                  → Fixed
 *   refactor: / polish:   → Changed
 *   anything else         → Changed
 *
 * Run with: `pnpm changelog`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface CommitRow {
  sha: string;
  subject: string;
}

interface Categorized {
  added: CommitRow[];
  changed: CommitRow[];
  fixed: CommitRow[];
  removed: CommitRow[];
}

const REPO_ROOT = resolve(__dirname, "..", "..");
const CHANGELOG_PATH = resolve(REPO_ROOT, "CHANGELOG.md");
const DEVLOG_PATH = resolve(REPO_ROOT, "DEVLOG.md");

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Find the most recent dated version heading in CHANGELOG.md. Returns
 * null when the file has no dated entries yet (e.g. only [Unreleased]).
 */
function findLastChangelogDate(changelog: string): string | null {
  // Pattern: `## [YYYY-MM-DD]` or `## [YYYY-MM-DD] — …`. Skips
  // `## [Unreleased]`.
  const re = /^##\s+\[(\d{4}-\d{2}-\d{2})\]/gm;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(changelog)) !== null) {
    if (!last || m[1] > last) last = m[1];
  }
  return last;
}

/**
 * Pull every `## YYYY-MM-DD …` heading from DEVLOG.md whose date is
 * STRICTLY GREATER than `since` (or all of them if `since` is null).
 * Returns headings in document order — DEVLOG entries are typically
 * prepended at the top, so callers see newest-first.
 */
function findDevlogHeadings(devlog: string, since: string | null): string[] {
  const out: string[] = [];
  const re = /^##\s+(\d{4}-\d{2}-\d{2})\b.*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(devlog)) !== null) {
    if (!since || m[1] > since) {
      out.push(m[0].trim());
    }
  }
  return out;
}

/**
 * Read `git log --oneline <since>..HEAD` and parse each row into
 * { sha, subject }. The "since" reference here is a date — we resolve
 * it to the first commit whose author-date is past midnight UTC of the
 * given day. `git log --since=<date>` does that for us natively.
 */
function readCommitsSince(since: string | null): CommitRow[] {
  // Use execFileSync (no shell) so the `%h`/`%s` format placeholders
  // don't get expanded by zsh/bash before git sees them.
  const args = ["log", "--no-merges", "--pretty=format:%h\t%s"];
  if (since) {
    // Anchor to midnight UTC of the changelog entry's date. We accept
    // a small overlap on the boundary day rather than risk dropping a
    // late-evening commit by adding +1 day.
    args.push(`--since=${since}T00:00:00`);
  }
  const out = execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const rows: CommitRow[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    rows.push({
      sha: line.slice(0, tab).trim(),
      subject: line.slice(tab + 1).trim(),
    });
  }
  return rows;
}

/**
 * Sort each commit into one of the four Keep-a-Changelog buckets.
 * Conventional-commits-ish — `feat!:` and `BREAKING` go to Removed
 * with a note (since "removed" is the rarer label that benefits from
 * an explicit attention-grab); `feat:` is Added, `fix:` is Fixed,
 * everything else (refactor / polish / chore / docs / build / etc) is
 * Changed.
 */
function categorize(rows: CommitRow[]): Categorized {
  const out: Categorized = { added: [], changed: [], fixed: [], removed: [] };
  for (const row of rows) {
    const s = row.subject;
    // `feat!:` or "BREAKING" anywhere in the subject → Removed (rare,
    // worth a callout).
    if (/^[a-z]+(\([^)]+\))?!:/.test(s) || /\bBREAKING\b/.test(s)) {
      out.removed.push(row);
      continue;
    }
    if (/^feat(\([^)]+\))?:/.test(s)) {
      out.added.push(row);
      continue;
    }
    if (/^fix(\([^)]+\))?:/.test(s)) {
      out.fixed.push(row);
      continue;
    }
    // refactor: / polish: / chore: / docs: / build: / test: / perf:
    // — all bucket as Changed.
    out.changed.push(row);
  }
  return out;
}

function fmtCommit(row: CommitRow): string {
  return `- (commit \`${row.sha}\`) ${row.subject}`;
}

function emitDraft(args: {
  date: string;
  since: string | null;
  cats: Categorized;
  devlogHeadings: string[];
}): string {
  const lines: string[] = [];
  lines.push(`## [Unreleased] — ${args.date}`);
  lines.push("");

  if (args.cats.added.length) {
    lines.push("### Added");
    lines.push("");
    for (const r of args.cats.added) lines.push(fmtCommit(r));
    lines.push("");
  }
  if (args.cats.changed.length) {
    lines.push("### Changed");
    lines.push("");
    for (const r of args.cats.changed) lines.push(fmtCommit(r));
    lines.push("");
  }
  if (args.cats.fixed.length) {
    lines.push("### Fixed");
    lines.push("");
    for (const r of args.cats.fixed) lines.push(fmtCommit(r));
    lines.push("");
  }
  if (args.cats.removed.length) {
    lines.push("### Removed");
    lines.push("");
    lines.push("> Breaking change(s). Review carefully before publishing.");
    lines.push("");
    for (const r of args.cats.removed) lines.push(fmtCommit(r));
    lines.push("");
  }

  if (args.devlogHeadings.length) {
    lines.push("### Source DEVLOG entries");
    lines.push("");
    for (const h of args.devlogHeadings) lines.push(`- ${h}`);
    lines.push("");
  }

  if (
    !args.cats.added.length &&
    !args.cats.changed.length &&
    !args.cats.fixed.length &&
    !args.cats.removed.length &&
    !args.devlogHeadings.length
  ) {
    lines.push(
      `_No commits or DEVLOG entries since ${args.since ?? "the beginning of the repo"}._`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

function main(): void {
  const changelog = readFileSync(CHANGELOG_PATH, "utf8");
  const devlog = readFileSync(DEVLOG_PATH, "utf8");
  const since = findLastChangelogDate(changelog);
  const commits = readCommitsSince(since);
  const cats = categorize(commits);
  const headings = findDevlogHeadings(devlog, since);

  const banner = since
    ? `# Draft CHANGELOG block — commits + DEVLOG since ${since}\n# Copy-paste into CHANGELOG.md after review.\n`
    : `# Draft CHANGELOG block — full repo history (no prior dated entry found).\n# Copy-paste into CHANGELOG.md after review.\n`;

  process.stdout.write(banner);
  process.stdout.write("\n");
  process.stdout.write(
    emitDraft({ date: todayISO(), since, cats, devlogHeadings: headings }),
  );
}

main();
