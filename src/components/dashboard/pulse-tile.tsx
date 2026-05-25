"use client";
import Link from "next/link";
import { Activity } from "lucide-react";
import { trpc } from "@/lib/trpc";

/**
 * "Pulse" — at-a-glance workspace health for the dashboard: four bordered
 * stat tiles (Open / In progress / Done this week / Sprint) plus a sprint
 * progress bar (startsAt → endsAt).
 *
 * Data sources mirror the Inbox's PulseRollup so the two surfaces agree:
 *   - Open / In progress      → trpc.issue.list (active, includeDone:false)
 *   - Done this week          → trpc.issue.list (includeDone:true), filtered
 *                               to DONE updated within the last 7 days
 *   - Sprint name + date span → trpc.cycle.current (the ACTIVE cycle)
 *
 * The progress bar's fill is time-elapsed across the sprint window
 * (startsAt → endsAt), clamped to [0,1] — the live equivalent of the
 * design mock's `completion`.
 *
 * Always renders (it's a customizable widget in the dashboard stack, not
 * an alert), with a sensible empty/loading shape.
 */
export function PulseTile({ slug }: { slug: string }) {
  const active = trpc.issue.list.useQuery({ includeDone: false, limit: 200 });
  const done = trpc.issue.list.useQuery({ includeDone: true, limit: 200 });
  const sprint = trpc.cycle.current.useQuery();

  const openCount = active.data?.items.length ?? 0;
  const inProgress =
    active.data?.items.filter((i) => i.status.category === "IN_PROGRESS")
      .length ?? 0;
  const weekAgo = Date.now() - 7 * 86_400_000;
  const doneThisWeek =
    done.data?.items.filter(
      (i) =>
        i.status.category === "DONE" &&
        new Date(i.updatedAt).getTime() >= weekAgo,
    ).length ?? 0;

  const cycle = sprint.data ?? null;
  const sprintName = cycle?.name ?? "None";

  // Time-elapsed progress across the sprint window.
  let progress: number | null = null;
  let startsAt: Date | null = null;
  let endsAt: Date | null = null;
  if (cycle?.startsAt && cycle?.endsAt) {
    startsAt = new Date(cycle.startsAt);
    endsAt = new Date(cycle.endsAt);
    const span = endsAt.getTime() - startsAt.getTime();
    if (span > 0) {
      progress = Math.min(
        1,
        Math.max(0, (Date.now() - startsAt.getTime()) / span),
      );
    }
  }

  const loading = active.isLoading || done.isLoading || sprint.isLoading;

  const tiles = [
    { label: "Open", value: openCount, hint: "active issues", href: `/w/${slug}/issues` },
    { label: "In progress", value: inProgress, hint: "agents + humans", href: `/w/${slug}/issues` },
    { label: "Done / wk", value: doneThisWeek, hint: "last 7 days", href: `/w/${slug}/issues?status=done` },
    { label: "Sprint", value: sprintName, hint: cycle ? "active" : "none", href: `/w/${slug}/cycles`, mono: false },
  ];

  return (
    <section className="rounded-lg border border-border bg-card/40 p-4">
      <header className="mb-3 flex items-center gap-2">
        <Activity className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Pulse</h3>
        <span className="ml-auto text-meta text-muted-foreground">
          last 7 days
        </span>
      </header>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map((t) => (
          <Link
            key={t.label}
            href={t.href}
            className="focus-ring rounded-md border border-border bg-background px-2 py-2 transition-colors hover:border-ember/40"
          >
            <div className="text-[0.625rem] uppercase tracking-wider text-muted-foreground">
              {t.label}
            </div>
            <div
              className={
                "mt-0.5 text-xl font-semibold tracking-tight" +
                (t.mono === false ? "" : " tabular-nums") +
                (loading ? " animate-pulse text-muted-foreground/40" : "")
              }
            >
              {loading ? "—" : t.value}
            </div>
            <div className="text-meta text-muted-foreground">{t.hint}</div>
          </Link>
        ))}
      </div>
      {/* Sprint progress bar — startsAt → endsAt */}
      {cycle && progress !== null && startsAt && endsAt ? (
        <div className="mt-3">
          <div className="flex items-center justify-between text-meta text-muted-foreground">
            <span>{sprintName}</span>
            <span>
              {fmtDate(startsAt)} → {fmtDate(endsAt)}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle">
            <div
              className="h-full rounded-full bg-ember transition-all"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function fmtDate(d: Date): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}
