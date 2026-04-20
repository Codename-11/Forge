"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Map as MapIcon } from "lucide-react";
import { InitiativeStatus } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/settings/empty-state";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";

type Grain = "week" | "month";

/**
 * Lightweight roadmap. Horizontal timeline with initiative rows and
 * project bars spanning `startDate` → `targetDate`. Cycle boundaries
 * render as dotted vertical markers. CSS grid, no external chart lib.
 */
export default function RoadmapPage() {
  const ws = useWorkspace();
  const { data: initiatives, isLoading: iLoading } =
    trpc.initiative.list.useQuery({});
  const { data: projects } = trpc.project.list.useQuery({
    archived: false,
    limit: 200,
  });
  const { data: cycles } = trpc.cycle.list.useQuery({});

  const [grain, setGrain] = useState<Grain>("week");

  const active = useMemo(
    () =>
      (initiatives ?? []).filter(
        (i) => i.status !== InitiativeStatus.COMPLETED,
      ),
    [initiatives],
  );

  // Determine timeline bounds. Default: today → +12 weeks / +6 months.
  const today = useMemo(() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }, []);

  const { rangeStart, rangeEnd, totalDays, ticks } = useMemo(() => {
    const projs = projects?.items ?? [];
    const anchors: Date[] = [];
    for (const p of projs) {
      if (p.startDate) anchors.push(new Date(p.startDate));
      if (p.targetDate) anchors.push(new Date(p.targetDate));
    }
    for (const i of active) {
      if (i.targetDate) anchors.push(new Date(i.targetDate));
    }
    for (const c of cycles ?? []) {
      anchors.push(new Date(c.startsAt));
      anchors.push(new Date(c.endsAt));
    }
    const earliest =
      anchors.length > 0
        ? new Date(Math.min(...anchors.map((d) => d.getTime())))
        : today;
    const latest =
      anchors.length > 0
        ? new Date(Math.max(...anchors.map((d) => d.getTime())))
        : new Date(today.getTime() + 90 * 86_400_000);

    // Align range to nicer boundaries.
    const start = new Date(Math.min(earliest.getTime(), today.getTime()));
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(
      grain === "week" ? start.getUTCDate() - start.getUTCDay() : 1,
    );

    const end = new Date(
      Math.max(latest.getTime(), today.getTime() + 60 * 86_400_000),
    );
    end.setUTCHours(0, 0, 0, 0);
    if (grain === "week") {
      end.setUTCDate(end.getUTCDate() + (7 - (end.getUTCDay() || 7)));
    } else {
      end.setUTCMonth(end.getUTCMonth() + 1, 1);
    }

    const totalDays = Math.max(
      14,
      Math.round((end.getTime() - start.getTime()) / 86_400_000),
    );

    // Tick marks per grain unit.
    const ticks: { date: Date; label: string }[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      ticks.push({
        date: new Date(cursor),
        label:
          grain === "week"
            ? `${cursor.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
            : cursor.toLocaleDateString(undefined, {
                month: "short",
                year: "2-digit",
              }),
      });
      if (grain === "week") cursor.setUTCDate(cursor.getUTCDate() + 7);
      else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return { rangeStart: start, rangeEnd: end, totalDays, ticks };
  }, [projects, active, cycles, grain, today]);

  function dayOffset(d: Date): number {
    return Math.max(
      0,
      Math.round((d.getTime() - rangeStart.getTime()) / 86_400_000),
    );
  }
  function pct(days: number): number {
    return (days / totalDays) * 100;
  }

  // Group projects by initiativeId (undefined → "Unaffiliated").
  const projectsByInitiative = useMemo(() => {
    const map = new Map<string | null, NonNullable<typeof projects>["items"]>();
    for (const p of projects?.items ?? []) {
      const key = p.initiativeId ?? null;
      const arr = map.get(key) ?? [];
      arr.push(p);
      map.set(key, arr);
    }
    return map;
  }, [projects]);

  if (iLoading) {
    return (
      <>
        <Topbar title="Roadmap" />
        <div className="p-6 text-sm text-muted-foreground">Loading…</div>
      </>
    );
  }

  const totalProjects = projects?.items.length ?? 0;
  if (active.length === 0 && totalProjects === 0) {
    return (
      <>
        <Topbar title="Roadmap" />
        <div className="flex flex-1 items-center justify-center p-8">
          <EmptyState
            as="div"
            icon={MapIcon}
            title="Roadmap is empty"
            hint="Create initiatives and projects with start / target dates to see them plotted here."
          />
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title="Roadmap"
        subtitle={`${ticks[0]?.label ?? ""} → ${ticks[ticks.length - 1]?.label ?? ""}`}
        actions={
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <Button
              variant={grain === "week" ? "subtle" : "ghost"}
              size="sm"
              onClick={() => setGrain("week")}
              className="h-6 px-2 text-[11px]"
            >
              Week
            </Button>
            <Button
              variant={grain === "month" ? "subtle" : "ghost"}
              size="sm"
              onClick={() => setGrain("month")}
              className="h-6 px-2 text-[11px]"
            >
              Month
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="min-w-[960px] rounded-lg border border-border bg-card/40">
          {/* Tick header */}
          <div className="relative h-8 border-b border-border">
            {ticks.map((t, i) => {
              const left = pct(dayOffset(t.date));
              return (
                <div
                  key={i}
                  className="absolute top-0 flex h-full items-center text-[10px] text-muted-foreground"
                  style={{ left: `${left}%` }}
                >
                  <span className="ml-1">{t.label}</span>
                </div>
              );
            })}
            {/* Today line */}
            {today >= rangeStart && today <= rangeEnd && (
              <div
                className="absolute top-0 h-full border-l border-ember"
                style={{ left: `${pct(dayOffset(today))}%` }}
                aria-label="today"
              />
            )}
          </div>

          {/* Cycle markers */}
          <div className="relative h-2 border-b border-border bg-card/20">
            {(cycles ?? []).map((c) => {
              const left = pct(dayOffset(new Date(c.startsAt)));
              const end = pct(dayOffset(new Date(c.endsAt)));
              return (
                <div
                  key={c.id}
                  className="absolute top-0 h-full bg-ember/10"
                  style={{
                    left: `${left}%`,
                    width: `${Math.max(0.2, end - left)}%`,
                  }}
                  title={`${c.name} (${c.status})`}
                />
              );
            })}
          </div>

          {/* Rows */}
          <ul>
            {active.map((ini) => (
              <li key={ini.id} className="border-b border-border last:border-0">
                <RoadmapRow
                  initiative={ini}
                  projects={projectsByInitiative.get(ini.id) ?? []}
                  rangeStart={rangeStart}
                  totalDays={totalDays}
                  pct={pct}
                  dayOffset={dayOffset}
                  href={`/w/${ws.slug}/initiatives/${ini.slug}`}
                />
              </li>
            ))}
            {(projectsByInitiative.get(null)?.length ?? 0) > 0 && (
              <li>
                <RoadmapRow
                  initiative={{
                    id: "_none",
                    name: "Unaffiliated projects",
                    color: null,
                  }}
                  projects={projectsByInitiative.get(null) ?? []}
                  rangeStart={rangeStart}
                  totalDays={totalDays}
                  pct={pct}
                  dayOffset={dayOffset}
                />
              </li>
            )}
          </ul>

          {/* Cycle boundary grid (dotted verticals) */}
          <div className="pointer-events-none relative h-0">
            {(cycles ?? []).flatMap((c) => {
              const markers: { when: Date; key: string }[] = [
                { when: new Date(c.startsAt), key: `${c.id}-s` },
                { when: new Date(c.endsAt), key: `${c.id}-e` },
              ];
              return markers.map((m) => (
                <div
                  key={m.key}
                  className="absolute -top-[9999px]"
                  style={{ left: `${pct(dayOffset(m.when))}%` }}
                />
              ));
            })}
          </div>
        </div>
      </div>
    </>
  );
}

function RoadmapRow({
  initiative,
  projects,
  rangeStart,
  totalDays,
  pct,
  dayOffset,
  href,
}: {
  initiative: { id: string; name: string; color: string | null };
  projects: Array<{
    id: string;
    name: string;
    key: string;
    color: string | null;
    startDate: Date | string | null;
    targetDate: Date | string | null;
  }>;
  rangeStart: Date;
  totalDays: number;
  pct: (days: number) => number;
  dayOffset: (d: Date) => number;
  href?: string;
}) {
  const ws = useWorkspace();
  return (
    <div className="grid grid-cols-[180px_1fr] items-start gap-2 px-3 py-3">
      <div className="min-w-0">
        {href ? (
          <Link href={href} className="flex items-center gap-2 hover:text-ember">
            <span
              className="inline-block h-3 w-3 shrink-0 rounded-sm"
              style={{ backgroundColor: initiative.color ?? "#78716c" }}
            />
            <span className="truncate text-xs font-medium">
              {initiative.name}
            </span>
          </Link>
        ) : (
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 shrink-0 rounded-sm"
              style={{ backgroundColor: initiative.color ?? "#78716c" }}
            />
            <span className="truncate text-xs font-medium text-muted-foreground">
              {initiative.name}
            </span>
          </div>
        )}
      </div>
      <div className="relative min-h-[32px]">
        {projects.length === 0 && (
          <div className="py-1 text-[10px] italic text-muted-foreground/70">
            No dated projects
          </div>
        )}
        {projects.map((p, i) => {
          const start = p.startDate ? new Date(p.startDate) : null;
          const end = p.targetDate ? new Date(p.targetDate) : null;
          if (!start && !end) {
            return (
              <div
                key={p.id}
                className="mb-1 text-[10px] text-muted-foreground/70"
              >
                {p.key} · no dates
              </div>
            );
          }
          const actualStart = start ?? rangeStart;
          const actualEnd = end ?? actualStart;
          const left = pct(dayOffset(actualStart));
          const width = Math.max(
            1,
            pct(dayOffset(actualEnd)) - left + (end ? 0 : 1),
          );
          const bar = Math.min(width, 100 - left);
          return (
            <Link
              key={p.id}
              href={`/w/${ws.slug}/projects/${p.id}`}
              className={cn(
                "mb-1.5 flex h-5 items-center overflow-hidden rounded-full text-[10px] font-medium transition-colors hover:opacity-90",
              )}
              style={{
                marginLeft: `${left}%`,
                width: `${bar}%`,
                backgroundColor: p.color ?? initiative.color ?? "#78716c",
                color: "#fff",
                marginTop: i === 0 ? 0 : undefined,
              }}
              title={`${p.key} · ${p.name}`}
            >
              <span className="truncate px-2">{p.name}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
