"use client";
import Link from "next/link";
import { useMemo } from "react";
import { Calendar, Clock3, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId } from "@/lib/utils";

/**
 * Today widget — a focused "what's happening this week" tile that sits
 * between the GreetingBar and Quick Notes on the dashboard.
 *
 * Three logical regions in one card:
 *   1. Active sprint countdown (clickable → /cycles/{id}). Shows name +
 *      "ends in Xd" with a tiny progress bar. Hidden when no active
 *      sprint exists.
 *   2. Due soon — up to 5 issues with `dueDate` inside the next 7 days
 *      (overdue-but-open included). Each row click → issue detail.
 *   3. Week peek — Mon..Sun strip with per-day dots when issues are due
 *      that day. Click a day → /issues with a saved-view-style filter
 *      (kept simple here — links to /issues with no filter; future iter
 *      can deep-link by date).
 *
 * Empty states live inline:
 *   - All three regions empty → "Nothing scheduled — fluid week" tile.
 *   - Sprint exists, no due-soon → countdown + week peek (no due block).
 *
 * Density-aware text utilities (`text-meta`, `text-id`) are used for
 * primary content so the Appearance setting cascades correctly.
 */
export function TodayWidget({
  slug,
  workspaceKey,
}: {
  slug: string;
  workspaceKey: string;
}) {
  const { data, isLoading } = trpc.dashboard.today.useQuery();

  if (isLoading || !data) {
    return (
      <section className="rounded-lg border border-border bg-card/40 p-4">
        <div className="h-20 animate-pulse rounded bg-subtle/40" />
      </section>
    );
  }

  const hasSprint = !!data.activeCycle;
  const hasDueSoon = data.dueSoon.length > 0;
  const weekHasAnyDot = data.weekPeek.some((d) => d.count > 0);
  const allEmpty = !hasSprint && !hasDueSoon && !weekHasAnyDot;

  if (allEmpty) {
    return (
      <section className="rounded-lg border border-dashed border-border bg-card/30 p-5 text-center">
        <div className="mx-auto grid h-9 w-9 place-items-center rounded-full bg-subtle text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" />
        </div>
        <div className="mt-2 text-sm font-medium">Nothing scheduled</div>
        <p className="mx-auto mt-0.5 max-w-sm text-meta text-muted-foreground">
          No active sprint, no due dates this week. Fluid week ahead.
        </p>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card/40">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Calendar className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">Today</span>
        <span className="text-meta text-muted-foreground/70">
          this week at a glance
        </span>
      </header>

      <div className="divide-y divide-border">
        {hasSprint && (
          <SprintCountdown
            cycle={data.activeCycle!}
            slug={slug}
          />
        )}

        {hasDueSoon && (
          <DueSoonList
            items={data.dueSoon}
            slug={slug}
            workspaceKey={workspaceKey}
          />
        )}

        <WeekPeek weekPeek={data.weekPeek} slug={slug} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sprint countdown
// ---------------------------------------------------------------------------

function SprintCountdown({
  cycle,
  slug,
}: {
  cycle: { id: string; name: string; endsAt: Date | string };
  slug: string;
}) {
  const endsAt = useMemo(() => new Date(cycle.endsAt), [cycle.endsAt]);
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffMs = endsAt.getTime() - now.getTime();
  const daysLeft = Math.max(0, Math.ceil(diffMs / msPerDay));
  const overdue = diffMs < 0;
  const label = overdue
    ? `ended ${Math.abs(Math.floor(diffMs / msPerDay))}d ago`
    : daysLeft === 0
      ? "ends today"
      : daysLeft === 1
        ? "ends tomorrow"
        : `ends in ${daysLeft}d`;

  return (
    <Link
      href={`/w/${slug}/cycles/${cycle.id}`}
      className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-subtle/40"
      title="Open sprint detail"
    >
      <span
        className={cn(
          "grid h-7 w-7 place-items-center rounded-full",
          overdue ? "bg-warning/15 text-warning" : "bg-ember/10 text-ember",
        )}
      >
        <Clock3 className="h-3.5 w-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">
          <span className="font-medium">{cycle.name}</span>
          <span className="ml-2 text-muted-foreground">— {label}</span>
        </div>
      </div>
      <span className="text-meta text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        Open →
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Due-soon list
// ---------------------------------------------------------------------------

const PRIORITY_GLYPH: Record<string, string> = {
  URGENT: "!!!",
  HIGH: "!!",
  MEDIUM: "!",
  LOW: "·",
  NONE: "—",
};

type DueSoonItem = {
  id: string;
  number: number;
  title: string;
  priority: string;
  dueDate: Date | string | null;
  status: { id: string; name: string; category: string; color: string };
  project: { id: string; key: string; name: string; color: string | null; icon: string | null } | null;
};

function DueSoonList({
  items,
  slug,
  workspaceKey,
}: {
  items: DueSoonItem[];
  slug: string;
  workspaceKey: string;
}) {
  return (
    <div className="px-4 py-2.5">
      <div className="mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
        Due soon
      </div>
      <ul className="flex flex-col">
        {items.map((issue) => (
          <li key={issue.id}>
            <Link
              href={`/w/${slug}/issues/${issue.id}`}
              className="group flex items-center gap-2 rounded-md py-1 hover:bg-subtle/50"
            >
              <span className="w-5 shrink-0 text-center font-mono text-[0.6875rem] text-muted-foreground">
                {PRIORITY_GLYPH[issue.priority] ?? "—"}
              </span>
              <span className="text-id shrink-0 text-muted-foreground">
                {formatIssueId(workspaceKey, issue.number)}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs">
                {issue.title}
              </span>
              <DueChip dueDate={issue.dueDate!} />
              <Badge
                className="ml-1 shrink-0"
                color={issue.status.color}
              >
                {issue.status.name}
              </Badge>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DueChip({ dueDate }: { dueDate: Date | string }) {
  const date = useMemo(() => new Date(dueDate), [dueDate]);
  const now = new Date();
  const diffDays = Math.round(
    (date.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
  );
  const overdue = diffDays < 0;
  const today = diffDays === 0;
  let label: string;
  if (overdue) label = `${Math.abs(diffDays)}d overdue`;
  else if (today) label = "today";
  else if (diffDays === 1) label = "tomorrow";
  else label = `${diffDays}d`;
  return (
    <span
      className={cn(
        "text-meta shrink-0 tabular-nums",
        overdue ? "text-warning" : today ? "text-ember" : "text-muted-foreground",
      )}
      title={date.toLocaleDateString()}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Week peek
// ---------------------------------------------------------------------------

const DOW_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

function WeekPeek({
  weekPeek,
  slug,
}: {
  weekPeek: { date: string; count: number }[];
  slug: string;
}) {
  // The server returned UTC date keys; the *visual* "today" should be
  // anchored to local time, so resolve a local YYYY-MM-DD now.
  const todayKey = useMemo(() => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }, []);

  return (
    <div className="px-4 py-2.5">
      <div className="mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
        This week
      </div>
      <ul className="grid grid-cols-7 gap-1">
        {weekPeek.map((d, i) => {
          const isToday = d.date === todayKey;
          const hasDot = d.count > 0;
          // Deep-link to `/issues?dueOn=YYYY-MM-DD` — the issue list
          // page reads the param and threads it into `issue.list`, then
          // surfaces a dismissible "Due on …" chip in the filter bar.
          return (
            <li key={d.date}>
              <Link
                href={`/w/${slug}/issues?dueOn=${d.date}`}
                className={cn(
                  "focus-ring group flex flex-col items-center gap-1 rounded-md border px-1 py-1.5 text-meta transition-colors",
                  isToday
                    ? "border-ember/50 bg-ember/10 text-foreground"
                    : "border-border/60 hover:border-ember/30 hover:bg-subtle/40",
                )}
                title={`${d.date}${hasDot ? ` — ${d.count} due` : ""}`}
              >
                <span className="text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                  {DOW_LABELS[i]}
                </span>
                <span className="font-mono text-[0.6875rem] tabular-nums">
                  {d.date.slice(8, 10)}
                </span>
                <span
                  className={cn(
                    "h-1 w-1 rounded-full",
                    hasDot ? "bg-ember" : "bg-transparent",
                  )}
                  aria-hidden
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
