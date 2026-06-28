/**
 * Shared issue-display helpers used across the dashboard cards and the
 * issue surfaces. Kept framework-free (pure functions + constants) so it
 * imports cleanly into both client components and server formatting.
 */

/** Priority → terminal-style glyph. Mirrors the legacy dashboard map. */
export const PRIORITY_GLYPH: Record<string, string> = {
  URGENT: "!!!",
  HIGH: "!!",
  MEDIUM: "!",
  LOW: "·",
  NONE: "—",
};

/** Priority → sortable rank (desc = most urgent first). */
export const PRIORITY_RANK: Record<string, number> = {
  URGENT: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  NONE: 0,
};

/** Relative, human due-date label ("due today", "3d overdue", "Sep 4"). */
export function formatDueDate(d: Date | string, tz: string | null): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const diffDays = Math.round((date.getTime() - Date.now()) / 86_400_000);
  if (diffDays === 0) return "due today";
  if (diffDays === 1) return "due tomorrow";
  if (diffDays === -1) return "due yesterday";
  if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`;
  if (diffDays <= 7) return `in ${diffDays}d`;
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      timeZone: tz ?? undefined,
    }).format(date);
  } catch {
    return date.toLocaleDateString();
  }
}

/** Compact SLA-target label: `45m`, `4h`, `1d`, `1.5d`. */
export function formatSlaShort(min: number): string {
  if (min < 60) return `${min}m`;
  if (min < 1440) {
    const h = min / 60;
    return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
  }
  const d = min / 1440;
  return Number.isInteger(d) ? `${d}d` : `${d.toFixed(1)}d`;
}

/**
 * First meaningful line of a description, lightly de-marked-down, for a
 * one-line card snippet. Strips a leading heading / list / quote marker
 * and caps length so a giant paragraph can't blow out the layout before
 * CSS line-clamp kicks in.
 */
export function firstLine(s: string, max = 160): string {
  const line =
    s
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.replace(/^[#>\-*\s]+/, "").slice(0, max);
}
