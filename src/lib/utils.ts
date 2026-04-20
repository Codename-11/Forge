import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function initials(name?: string | null) {
  if (!name) return "·";
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

export function formatIssueId(workspaceKey: string, number: number) {
  return `${workspaceKey}-${number}`;
}

export function relativeTime(date: Date | string) {
  const d = typeof date === "string" ? new Date(date) : date;
  const delta = (Date.now() - d.getTime()) / 1000;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 2_592_000) return `${Math.floor(delta / 86_400)}d`;
  return d.toLocaleDateString();
}

export type TimePrefs = {
  timezone?: string | null;
  locale?: string | null;
  timeFormat?: string | null;
};

export function formatDate(
  date: Date | string,
  prefs?: TimePrefs,
  opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  },
) {
  const d = typeof date === "string" ? new Date(date) : date;
  const timeZone = prefs?.timezone || undefined;
  const locale = prefs?.locale || undefined;
  const hourCycle =
    prefs?.timeFormat === "24h" ? "h23" : prefs?.timeFormat === "12h" ? "h12" : undefined;
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone, hourCycle }).format(d);
  } catch {
    return d.toLocaleString();
  }
}
