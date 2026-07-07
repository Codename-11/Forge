/**
 * Slash command parser for issue / comment composers.
 *
 * Commands appear on their OWN line, top-level only — anything inside a
 * fenced code block (``` … ```) is preserved verbatim. As of the
 * @-mention + / coexistence work (2026-05-21) commands no longer have to
 * be a contiguous leading block: a recognised command line is extracted
 * wherever it sits in the body (e.g. a `/assign @victor` line UNDER a
 * paragraph of prose still applies). This lets operators write prose
 * with an @mention and then issue a slash command in the same comment.
 *
 * Conservatism guarantees so prose `/` is never eaten:
 *   - Only WHOLE lines are considered. A `/` in the middle of a line
 *     ("and/or", "https://…") is never a command — the line must START
 *     with `/` (after optional leading whitespace).
 *   - The line's keyword must be a RECOGNISED command AND its argument
 *     must parse. `/foo bar`, `/assign` (no handle), `/due wat` all stay
 *     verbatim in the body.
 *   - Anything inside a fenced code block is left untouched.
 *
 * The parser strips matched command lines from the body and returns both
 * the cleaned body AND the structured commands so the server can apply
 * them in one shot.
 *
 * Recognized commands (case-insensitive on keyword; arg semantics
 * documented per command):
 *
 *   /assign @handle           — set assignedAgent by profileKey. `mode` is
 *                               UI-only (set via the assign badge's mode
 *                               picker, not typed) — an unset `mode` falls
 *                               back to the surface's resolved default.
 *   /due <when>               — set dueDate; "today" / "tomorrow" /
 *                               "in 3 days" / "in 1 week" / "next Monday"
 *                               / "2026-05-15" / "May 15"
 *   /label <name>             — attach Label by name (skip if missing)
 *   /priority <level>         — urgent | high | medium | low | none
 *                               (also "!!!" / "!!" / "!" / "·")
 *   /project <KEY>            — set projectId by Project.key
 *   /watch                    — add caller as IssueWatcher
 *   /unwatch                  — remove caller
 *
 * Recognised command lines are pulled out wherever they sit (outside
 * fenced code); every other line is preserved verbatim, in order. This
 * keeps the body "what would I have typed without the command lines"
 * predictable.
 */
import type { EngagementMode } from "@prisma/client";

export type SlashCommand =
  | { kind: "assign"; handle: string; mode?: EngagementMode }
  | { kind: "due"; date: Date }
  | { kind: "label"; name: string }
  | {
      kind: "priority";
      level: "urgent" | "high" | "medium" | "low" | "none";
    }
  | { kind: "project"; key: string }
  | { kind: "watch" }
  | { kind: "unwatch" };

export interface ParseResult {
  /** Body with leading slash commands stripped. */
  strippedBody: string;
  /** Recognized commands in document order. */
  commands: SlashCommand[];
}

const PRIORITY_TOKENS: Record<string, SlashCommand & { kind: "priority" }> = {
  urgent: { kind: "priority", level: "urgent" },
  "!!!": { kind: "priority", level: "urgent" },
  high: { kind: "priority", level: "high" },
  "!!": { kind: "priority", level: "high" },
  medium: { kind: "priority", level: "medium" },
  med: { kind: "priority", level: "medium" },
  "!": { kind: "priority", level: "medium" },
  low: { kind: "priority", level: "low" },
  "·": { kind: "priority", level: "low" },
  none: { kind: "priority", level: "none" },
};

/**
 * Coerce a relative-or-absolute date string into a Date. Returns null
 * for anything we can't recognise. Inline because we don't want a
 * chrono-node dep for the small set of forms operators actually use.
 */
export function parseDateExpression(raw: string, now = new Date()): Date | null {
  const expr = raw.trim().toLowerCase();
  if (!expr) return null;

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  if (expr === "today") return new Date(startOfToday);
  if (expr === "tomorrow") {
    const d = new Date(startOfToday);
    d.setDate(d.getDate() + 1);
    return d;
  }

  // "in N day(s)" / "in N week(s)"
  const inMatch = expr.match(/^in\s+(\d+)\s*(day|days|week|weeks)$/);
  if (inMatch) {
    const n = parseInt(inMatch[1], 10);
    const unit = inMatch[2];
    const d = new Date(startOfToday);
    if (unit.startsWith("week")) d.setDate(d.getDate() + n * 7);
    else d.setDate(d.getDate() + n);
    return d;
  }

  // "next Monday"
  const nextMatch = expr.match(/^next\s+(sun|mon|tue|wed|thu|fri|sat)/);
  if (nextMatch) {
    const targets = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const target = targets.indexOf(nextMatch[1]);
    if (target >= 0) {
      const d = new Date(startOfToday);
      const cur = d.getDay();
      let delta = target - cur;
      if (delta <= 0) delta += 7; // strictly future
      d.setDate(d.getDate() + delta);
      return d;
    }
  }

  // ISO yyyy-mm-dd
  const isoMatch = expr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10);
    const d = parseInt(isoMatch[3], 10);
    const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
    if (!isNaN(dt.getTime())) return dt;
  }

  // "May 15" / "May 15 2026"
  const monthMatch = expr.match(
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,?\s+(\d{4}))?$/,
  );
  if (monthMatch) {
    const months: Record<string, number> = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      sept: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };
    const m = months[monthMatch[1]];
    const day = parseInt(monthMatch[2], 10);
    const year = monthMatch[3]
      ? parseInt(monthMatch[3], 10)
      : (() => {
          // No year supplied — pick the next occurrence (this year if
          // the date is still in the future, else next year).
          const candidate = new Date(now.getFullYear(), m, day);
          if (candidate.getTime() < startOfToday.getTime()) {
            return now.getFullYear() + 1;
          }
          return now.getFullYear();
        })();
    const dt = new Date(year, m, day, 0, 0, 0, 0);
    if (!isNaN(dt.getTime())) return dt;
  }

  return null;
}

/**
 * Try to parse a single slash-command line into a structured command.
 * Returns null on no-match (or unrecognised arg).
 */
export function parseLine(raw: string, now: Date): SlashCommand | null {
  const m = raw.trim().match(/^\/(\w+)\s*(.*)$/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const arg = m[2].trim();

  switch (cmd) {
    case "assign": {
      // Strip leading @ if present
      const handle = arg.replace(/^@/, "").trim();
      if (!handle) return null;
      return { kind: "assign", handle };
    }
    case "due": {
      const date = parseDateExpression(arg, now);
      if (!date) return null;
      return { kind: "due", date };
    }
    case "label": {
      if (!arg) return null;
      return { kind: "label", name: arg };
    }
    case "priority":
    case "p": {
      const tok = PRIORITY_TOKENS[arg.toLowerCase()];
      if (!tok) return null;
      return tok;
    }
    case "project": {
      // Normalize to upper-case (project keys are always upper-case).
      const key = arg.toUpperCase();
      if (!key.match(/^[A-Z0-9]{2,8}$/)) return null;
      return { kind: "project", key };
    }
    case "watch":
      return { kind: "watch" };
    case "unwatch":
      return { kind: "unwatch" };
    default:
      return null;
  }
}

/**
 * Find a trailing slash command at the END of an inline, single-line
 * input — e.g. the title field "Fix login bug /priority high". Returns
 * the parsed command plus the index where the `/` token begins (so the
 * caller can splice it out of the title), or null if the tail isn't a
 * recognised command.
 *
 * Used by QuickCreate to "commit" a typed command into a chip. Only the
 * LAST slash-token is considered, and the whole tail from that slash to
 * end-of-string must parse — so multi-word args ("/due in 3 days",
 * "/label needs review") are captured intact. A `/` mid-token
 * ("https://…", "and/or") is never a match because the slash must be
 * preceded by start-of-string or whitespace.
 */
export function matchTrailingCommand(
  text: string,
  now: Date = new Date(),
): { command: SlashCommand; start: number } | null {
  let slash = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === "/" && (i === 0 || /\s/.test(text[i - 1]))) {
      slash = i;
      break;
    }
  }
  if (slash === -1) return null;
  const command = parseLine(text.slice(slash), now);
  if (!command) return null;
  return { command, start: slash };
}

/**
 * Parse the body for slash commands, preserving anything in fenced code
 * blocks. A recognised command line is extracted wherever it sits;
 * lines that look like commands but don't match a known form, and any
 * non-command prose, are LEFT IN PLACE (not silently consumed). Order is
 * preserved on both sides.
 */
export function parseSlashCommands(
  body: string,
  now: Date = new Date(),
): ParseResult {
  const commands: SlashCommand[] = [];
  const lines = body.split(/\r?\n/);
  const keptLines: string[] = [];
  // Track fenced code blocks (``` … ```). A `/` inside a fence is part
  // of code and is never a command — keep the line verbatim and don't
  // toggle on indented or language-tagged fences sloppily: any line
  // whose trimmed text starts with ``` flips the state.
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      keptLines.push(line);
      continue;
    }
    if (inFence) {
      keptLines.push(line);
      continue;
    }
    // A command line must START with `/` (after optional whitespace) AND
    // parse to a recognised command. Everything else — prose, blank
    // lines, unknown `/foo`, mid-line slashes — is kept verbatim.
    if (trimmed.startsWith("/")) {
      const cmd = parseLine(trimmed, now);
      if (cmd) {
        commands.push(cmd);
        continue; // drop the command line from the body
      }
    }
    keptLines.push(line);
  }

  if (commands.length === 0) {
    return { strippedBody: body, commands };
  }

  // Reassemble the kept lines, then collapse the blank-line damage left
  // behind by removed command lines: trim leading/trailing blank lines
  // and squash any run of 3+ newlines (created when a command line sat
  // between two paragraphs) down to a single blank line.
  const stripped = keptLines
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/, "");
  return { strippedBody: stripped, commands };
}

/**
 * Static help text for the inline composer hint. Keep short — the goal
 * is "discoverability without scrolling," not a manual.
 */
export const SLASH_COMMAND_HINT =
  "/ commands on their own line — /assign @handle, /due tomorrow, /label bug, /priority high, /project KEY, /watch";

/**
 * The seven recognised command keywords + a one-line example for each.
 * Powers the autocomplete dropdown in QuickCreate.
 */
export const SLASH_COMMAND_HELP: ReadonlyArray<{
  keyword: string;
  example: string;
}> = [
  { keyword: "/assign", example: "/assign @victor" },
  { keyword: "/due", example: "/due tomorrow" },
  { keyword: "/label", example: "/label bug" },
  { keyword: "/priority", example: "/priority high" },
  { keyword: "/project", example: "/project AXI" },
  { keyword: "/watch", example: "/watch" },
  { keyword: "/unwatch", example: "/unwatch" },
];
