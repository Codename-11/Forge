"use client";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, CalendarRange, Filter, Map as MapIcon, Pencil, X } from "lucide-react";
import { CycleStatus, InitiativeStatus } from "@prisma/client";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, MOTION, Skeleton } from "@/components/ui";
import { Input } from "@/components/ui/input";
import { QuickForm, SidePanel } from "@/components/ui/modal";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";

type Grain = "week" | "month";
type DateFilter = "all" | "dated" | "partial" | "missing";
type ProgressFilter = "all" | "no-issues" | "not-started" | "in-progress" | "complete";

type TimelineTick = {
  date: Date;
  label: string;
  x: number;
};

type CycleBand = {
  id: string;
  name: string;
  status: CycleStatus;
  left: number;
  width: number;
};

type RoadmapProject = {
  id: string;
  name: string;
  key: string;
  color: string | null;
  initiativeId?: string | null;
  startDate: Date | string | null;
  targetDate: Date | string | null;
  _count?: { issues: number; doneIssues?: number };
};

const MS_PER_DAY = 86_400_000;
const LABEL_WIDTH = 228;
const MIN_TIMELINE_WIDTH = 920;

function startOfUtcDay(value: Date): Date {
  const d = new Date(value);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function dayDiff(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);
}

function addUtcDays(value: Date, days: number): Date {
  const d = new Date(value);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function formatTick(date: Date, grain: Grain): string {
  return grain === "week"
    ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : date.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

/**
 * Roadmap calendar. Initiative/project labels stay pinned on the left;
 * the dated timeline scrolls horizontally. Projects without dates are
 * shown as explicit unscheduled rows so the view does not look blank.
 */
export default function RoadmapPage() {
  const ws = useWorkspace();
  const { data: initiatives, isLoading: iLoading } = trpc.initiative.list.useQuery({});
  const { data: projects } = trpc.project.list.useQuery({
    archived: false,
    limit: 200,
  });
  const { data: cycles } = trpc.cycle.list.useQuery({});

  const [grain, setGrain] = useState<Grain>("week");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [initiativeFilter, setInitiativeFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [progressFilter, setProgressFilter] = useState<ProgressFilter>("all");
  const [editingProject, setEditingProject] = useState<RoadmapProject | null>(null);

  const active = useMemo(
    () =>
      (initiatives ?? []).filter(
        (i) => i.status !== InitiativeStatus.COMPLETED && i.status !== InitiativeStatus.CANCELED,
      ),
    [initiatives],
  );

  const today = useMemo(() => startOfUtcDay(new Date()), []);
  const projectItems = useMemo(() => projects?.items ?? [], [projects]);
  const projectFiltersActive = dateFilter !== "all" || progressFilter !== "all";
  const filtersActive =
    initiativeFilter !== "all" || dateFilter !== "all" || progressFilter !== "all";

  const filteredProjects = useMemo(() => {
    return projectItems.filter((p) => {
      if (initiativeFilter !== "all" && (p.initiativeId ?? "_none") !== initiativeFilter) {
        return false;
      }

      const hasStart = !!p.startDate;
      const hasTarget = !!p.targetDate;
      if (dateFilter === "dated" && (!hasStart || !hasTarget)) return false;
      if (dateFilter === "partial" && Number(hasStart) + Number(hasTarget) !== 1) return false;
      if (dateFilter === "missing" && (hasStart || hasTarget)) return false;

      const total = p._count?.issues ?? 0;
      const done = p._count?.doneIssues ?? 0;
      if (progressFilter === "no-issues" && total !== 0) return false;
      if (progressFilter === "not-started" && (total === 0 || done !== 0)) return false;
      if (progressFilter === "in-progress" && (total === 0 || done === 0 || done >= total)) {
        return false;
      }
      if (progressFilter === "complete" && (total === 0 || done < total)) return false;

      return true;
    });
  }, [dateFilter, initiativeFilter, progressFilter, projectItems]);

  const visibleInitiatives = useMemo(() => {
    if (initiativeFilter === "_none") return [];
    return active.filter((ini) => initiativeFilter === "all" || ini.id === initiativeFilter);
  }, [active, initiativeFilter]);

  const { rangeStart, rangeEnd, totalDays } = useMemo(() => {
    const anchors: Date[] = [];
    for (const p of filteredProjects) {
      if (p.startDate) anchors.push(new Date(p.startDate));
      if (p.targetDate) anchors.push(new Date(p.targetDate));
    }
    for (const i of visibleInitiatives) {
      if (i.targetDate) anchors.push(new Date(i.targetDate));
    }
    for (const c of cycles ?? []) {
      if (c.status === CycleStatus.CANCELED) continue;
      anchors.push(new Date(c.startsAt));
      anchors.push(new Date(c.endsAt));
    }

    const earliest =
      anchors.length > 0 ? new Date(Math.min(...anchors.map((d) => d.getTime()))) : today;
    const latest =
      anchors.length > 0
        ? new Date(Math.max(...anchors.map((d) => d.getTime())))
        : addUtcDays(today, 90);

    const start = startOfUtcDay(new Date(Math.min(earliest.getTime(), today.getTime())));
    if (grain === "week") {
      start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    } else {
      start.setUTCDate(1);
    }

    const end = startOfUtcDay(
      new Date(Math.max(latest.getTime(), addUtcDays(today, 60).getTime())),
    );
    if (grain === "week") {
      end.setUTCDate(end.getUTCDate() + (7 - (end.getUTCDay() || 7)));
    } else {
      end.setUTCMonth(end.getUTCMonth() + 1, 1);
    }

    return {
      rangeStart: start,
      rangeEnd: end,
      totalDays: Math.max(14, dayDiff(start, end)),
    };
  }, [filteredProjects, visibleInitiatives, cycles, grain, today]);

  const dayWidth = grain === "week" ? 14 : 6;
  const timelineWidth = Math.max(MIN_TIMELINE_WIDTH, totalDays * dayWidth);

  function rawX(date: Date): number {
    return dayDiff(rangeStart, startOfUtcDay(date)) * dayWidth;
  }

  function xFor(date: Date): number {
    return Math.max(0, Math.min(timelineWidth, rawX(date)));
  }

  const ticks: TimelineTick[] = [];
  const tickCursor = new Date(rangeStart);
  while (tickCursor <= rangeEnd) {
    ticks.push({
      date: new Date(tickCursor),
      label: formatTick(tickCursor, grain),
      x: xFor(tickCursor),
    });
    if (grain === "week") tickCursor.setUTCDate(tickCursor.getUTCDate() + 7);
    else tickCursor.setUTCMonth(tickCursor.getUTCMonth() + 1);
  }

  const cycleBands: CycleBand[] = (cycles ?? [])
    .filter((c) => c.status !== CycleStatus.CANCELED)
    .map((c) => {
      const start = rawX(new Date(c.startsAt));
      const end = rawX(new Date(c.endsAt));
      const left = Math.max(0, start);
      const right = Math.min(timelineWidth, end);
      if (right <= 0 || left >= timelineWidth) return null;
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        left,
        width: Math.max(3, right - left),
      };
    })
    .filter((band): band is CycleBand => !!band);

  const todayX = today >= rangeStart && today <= rangeEnd ? xFor(today) : null;

  const projectsByInitiative = useMemo(() => {
    const map = new Map<string | null, RoadmapProject[]>();
    for (const p of filteredProjects) {
      const key = p.initiativeId ?? null;
      const arr = map.get(key) ?? [];
      arr.push(p);
      map.set(key, arr);
    }
    return map;
  }, [filteredProjects]);

  const rows = useMemo(() => {
    const initiativeRows = visibleInitiatives
      .map((ini) => ({
        initiative: {
          id: ini.id,
          name: ini.name,
          color: ini.color,
        },
        href: `/w/${ws.slug}/initiatives/${ini.slug}`,
        projects: projectsByInitiative.get(ini.id) ?? [],
      }))
      .filter((row) => !projectFiltersActive || row.projects.length > 0);
    const looseProjects = projectsByInitiative.get(null) ?? [];
    if (
      looseProjects.length === 0 ||
      (initiativeFilter !== "all" && initiativeFilter !== "_none")
    ) {
      return initiativeRows;
    }
    return [
      ...initiativeRows,
      {
        initiative: {
          id: "_none",
          name: "Unaffiliated projects",
          color: null,
        },
        href: undefined,
        projects: looseProjects,
      },
    ];
  }, [initiativeFilter, projectFiltersActive, projectsByInitiative, visibleInitiatives, ws.slug]);

  if (iLoading) {
    return (
      <>
        <Topbar title="Roadmap" />
        <div className="space-y-3 p-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </>
    );
  }

  const totalProjects = projectItems.length;
  if (active.length === 0 && totalProjects === 0) {
    return (
      <>
        <Topbar title="Roadmap" />
        <div className="flex flex-1 items-center justify-center p-8">
          <EmptyState
            variant="page"
            icon={<MapIcon />}
            title="Roadmap is empty"
            description="Add target dates to projects or initiatives, and they'll plot here as horizontal bars across upcoming weeks."
            action={
              <Link href={`/w/${ws.slug}/projects`}>
                <Button variant="ember" size="sm">
                  Go to projects
                </Button>
              </Link>
            }
          />
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title="Roadmap"
        subtitle={`${ticks[0]?.label ?? ""} -> ${ticks[ticks.length - 1]?.label ?? ""}`}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant={filtersOpen || filtersActive ? "subtle" : "outline"}
              size="sm"
              className="h-7"
              onClick={() => setFiltersOpen((open) => !open)}
              aria-pressed={filtersOpen}
            >
              <Filter className="h-3.5 w-3.5" />
              Filter
            </Button>
            <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
              <Button
                variant={grain === "week" ? "subtle" : "ghost"}
                size="sm"
                onClick={() => setGrain("week")}
                className="h-6 px-2 text-[0.6875rem]"
              >
                Week
              </Button>
              <Button
                variant={grain === "month" ? "subtle" : "ghost"}
                size="sm"
                onClick={() => setGrain("month")}
                className="h-6 px-2 text-[0.6875rem]"
              >
                Month
              </Button>
            </div>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {filtersOpen && (
          <div
            data-testid="roadmap-filters"
            className="mb-3 flex w-max min-w-full flex-wrap items-end gap-2 rounded-lg border border-border bg-card/40 p-3"
          >
            <label className="space-y-1">
              <span className="text-meta block text-muted-foreground">Initiative</span>
              <select
                value={initiativeFilter}
                onChange={(e) => setInitiativeFilter(e.target.value)}
                className="focus-ring h-8 min-w-44 rounded-md border border-input bg-background px-2 text-xs text-foreground"
              >
                <option value="all">All initiatives</option>
                <option value="_none">Unaffiliated projects</option>
                {active.map((ini) => (
                  <option key={ini.id} value={ini.id}>
                    {ini.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-meta block text-muted-foreground">Dates</span>
              <select
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value as DateFilter)}
                className="focus-ring h-8 min-w-36 rounded-md border border-input bg-background px-2 text-xs text-foreground"
              >
                <option value="all">All dates</option>
                <option value="dated">Fully dated</option>
                <option value="partial">Partial dates</option>
                <option value="missing">Missing dates</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-meta block text-muted-foreground">Progress</span>
              <select
                value={progressFilter}
                onChange={(e) => setProgressFilter(e.target.value as ProgressFilter)}
                className="focus-ring h-8 min-w-36 rounded-md border border-input bg-background px-2 text-xs text-foreground"
              >
                <option value="all">All progress</option>
                <option value="no-issues">No issues</option>
                <option value="not-started">Not started</option>
                <option value="in-progress">In progress</option>
                <option value="complete">Complete</option>
              </select>
            </label>
            {filtersActive && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={() => {
                  setInitiativeFilter("all");
                  setDateFilter("all");
                  setProgressFilter("all");
                }}
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </Button>
            )}
            <span className="text-meta ml-auto self-center text-muted-foreground">
              {filteredProjects.length} of {totalProjects} projects
            </span>
          </div>
        )}
        <div className="w-max min-w-full overflow-hidden rounded-lg border border-border bg-card/40">
          <div
            className="sticky top-0 z-20 grid border-b border-border bg-card/95 backdrop-blur"
            style={{ gridTemplateColumns: `${LABEL_WIDTH}px ${timelineWidth}px` }}
          >
            <div className="sticky left-0 z-30 flex h-11 items-center gap-2 border-r border-border bg-card/95 px-3">
              <CalendarRange className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">Initiatives</span>
              <span className="text-meta ml-auto text-muted-foreground">{rows.length}</span>
            </div>
            <div className="relative h-11" style={{ width: timelineWidth }}>
              <TimelineScaffold ticks={ticks} cycleBands={cycleBands} todayX={todayX} showLabels />
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center p-6">
              <EmptyState
                variant="card"
                title="No roadmap items match"
                description="Clear filters or update project dates to bring work back into this view."
              />
            </div>
          ) : (
            <ul>
              {rows.map((row) => (
                <li key={row.initiative.id} className="border-b border-border last:border-0">
                  <RoadmapRow
                    initiative={row.initiative}
                    projects={row.projects}
                    href={row.href}
                    labelWidth={LABEL_WIDTH}
                    timelineWidth={timelineWidth}
                    ticks={ticks}
                    cycleBands={cycleBands}
                    todayX={todayX}
                    xFor={xFor}
                    dayWidth={dayWidth}
                    onEditProject={setEditingProject}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="text-meta mt-3 flex w-max min-w-full flex-wrap items-center gap-3 text-muted-foreground">
          <LegendSwatch style={{ background: "hsl(var(--ember) / 0.18)" }} label="Active sprint" />
          <LegendSwatch style={{ background: "hsl(var(--ember) / 0.06)" }} label="Planned sprint" />
          <LegendSwatch
            style={{
              background: "hsl(var(--muted-foreground) / 0.18)",
              borderLeft: "3px solid hsl(var(--muted-foreground))",
            }}
            label="Project bar"
          />
          <LegendSwatch
            style={{
              background: "hsl(var(--muted-foreground) / 0.12)",
            }}
            label="Progress fill = done so far"
          />
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-3 w-px bg-ember" />
            Today
          </span>
        </div>
      </div>
      <RoadmapDateEditor
        project={editingProject}
        open={!!editingProject}
        onClose={() => setEditingProject(null)}
      />
    </>
  );
}

function TimelineScaffold({
  ticks,
  cycleBands,
  todayX,
  showLabels = false,
}: {
  ticks: TimelineTick[];
  cycleBands: CycleBand[];
  todayX: number | null;
  showLabels?: boolean;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {cycleBands.map((band) => (
        <div
          key={band.id}
          className={cn(
            "absolute inset-y-0",
            band.status === CycleStatus.ACTIVE ? "bg-ember/15" : "bg-ember/5",
          )}
          style={{ left: band.left, width: band.width }}
          title={`${band.name} (${band.status})`}
        />
      ))}
      {ticks.map((tick) => (
        <div key={tick.date.toISOString()} className="absolute inset-y-0" style={{ left: tick.x }}>
          <span className="block h-full w-px bg-border/60" aria-hidden="true" />
          {showLabels && (
            <span className="absolute left-1 top-3 whitespace-nowrap text-[0.6875rem] text-muted-foreground">
              {tick.label}
            </span>
          )}
        </div>
      ))}
      {todayX !== null && (
        <div
          className="absolute inset-y-0 z-10 border-l border-ember"
          style={{ left: todayX }}
          aria-label="Today"
        />
      )}
    </div>
  );
}

function RoadmapRow({
  initiative,
  projects,
  href,
  labelWidth,
  timelineWidth,
  ticks,
  cycleBands,
  todayX,
  xFor,
  dayWidth,
  onEditProject,
}: {
  initiative: { id: string; name: string; color: string | null };
  projects: RoadmapProject[];
  href?: string;
  labelWidth: number;
  timelineWidth: number;
  ticks: TimelineTick[];
  cycleBands: CycleBand[];
  todayX: number | null;
  xFor: (d: Date) => number;
  dayWidth: number;
  onEditProject: (project: RoadmapProject) => void;
}) {
  const ws = useWorkspace();
  const datedCount = projects.filter((p) => p.startDate || p.targetDate).length;
  const rowHeight = Math.max(72, 42 + Math.max(1, projects.length) * 30);

  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: `${labelWidth}px ${timelineWidth}px`,
      }}
    >
      <div className="sticky left-0 z-10 border-r border-border bg-card/95 px-3 py-3">
        {href ? (
          <Link href={href} className="flex items-center gap-2 hover:text-ember">
            <span
              className="inline-block h-3 w-3 shrink-0 rounded-sm"
              style={{ backgroundColor: initiative.color ?? "hsl(var(--muted-foreground))" }}
            />
            <span className="truncate text-xs font-medium">{initiative.name}</span>
          </Link>
        ) : (
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 shrink-0 rounded-sm"
              style={{ backgroundColor: initiative.color ?? "hsl(var(--muted-foreground))" }}
            />
            <span className="truncate text-xs font-medium text-muted-foreground">
              {initiative.name}
            </span>
          </div>
        )}
        <div className="text-meta ml-5 mt-0.5 text-muted-foreground">
          {projects.length} {projects.length === 1 ? "project" : "projects"}
        </div>
        <div className="text-meta ml-5 mt-0.5 text-muted-foreground/70">{datedCount} dated</div>
      </div>

      <div className="relative px-2 py-3" style={{ minHeight: rowHeight }}>
        <TimelineScaffold ticks={ticks} cycleBands={cycleBands} todayX={todayX} />
        <div className="relative">
          {projects.length === 0 && (
            <div className="text-meta flex h-7 items-center italic text-muted-foreground/70">
              No projects
            </div>
          )}
          {projects.map((project) => (
            <ProjectTimelineItem
              key={project.id}
              project={project}
              initiativeColor={initiative.color}
              xFor={xFor}
              timelineWidth={timelineWidth}
              dayWidth={dayWidth}
              href={`/w/${ws.slug}/projects/${project.id}`}
              onEdit={() => onEditProject(project)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ProjectTimelineItem({
  project,
  initiativeColor,
  xFor,
  timelineWidth,
  dayWidth,
  href,
  onEdit,
}: {
  project: RoadmapProject;
  initiativeColor: string | null;
  xFor: (d: Date) => number;
  timelineWidth: number;
  dayWidth: number;
  href: string;
  onEdit: () => void;
}) {
  const accent = project.color ?? initiativeColor ?? "hsl(var(--muted-foreground))";
  const start = project.startDate ? new Date(project.startDate) : null;
  const end = project.targetDate ? new Date(project.targetDate) : null;
  const total = project._count?.issues ?? 0;
  const done = project._count?.doneIssues ?? 0;
  const fillPct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  if (!start && !end) {
    return (
      <div
        className={cn(
          "text-meta mb-1.5 flex h-6 max-w-[360px] items-center gap-1.5 rounded-md border border-dashed border-border bg-background/60 px-2 text-muted-foreground hover:border-ember/40 hover:text-foreground",
          MOTION.fast,
        )}
        title={`${project.key} · ${project.name} has no roadmap dates`}
      >
        <Link href={href} className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-id shrink-0 font-mono tabular-nums">{project.key}</span>
          <span className="truncate">{project.name}</span>
        </Link>
        <button
          type="button"
          className="focus-ring ml-auto shrink-0 rounded-sm px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wider hover:bg-subtle hover:text-foreground"
          onClick={onEdit}
          title="Set roadmap dates"
        >
          Set dates
        </button>
      </div>
    );
  }

  const left = start ? xFor(start) : 0;
  const targetRight = end ? xFor(end) : Math.min(timelineWidth, left + 7 * dayWidth);
  const width = Math.max(48, Math.min(timelineWidth - left, targetRight - left));

  return (
    <div
      className={cn(
        "relative mb-1.5 flex h-6 items-center overflow-hidden rounded-md border text-[0.6875rem] font-medium hover:opacity-90",
        MOTION.fast,
      )}
      style={{
        marginLeft: left,
        width,
        background: `color-mix(in srgb, ${accent} 18%, transparent)`,
        borderColor: `color-mix(in srgb, ${accent} 45%, hsl(var(--border)))`,
        borderLeft: `3px solid ${accent}`,
      }}
      title={
        total > 0
          ? `${project.key} · ${project.name} — ${done}/${total} done`
          : `${project.key} · ${project.name}`
      }
    >
      {fillPct > 0 ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0"
          style={{
            width: `${fillPct}%`,
            background: `color-mix(in srgb, ${accent} 28%, transparent)`,
          }}
        />
      ) : null}
      <Link
        href={href}
        className="relative flex min-w-0 flex-1 items-center gap-1.5 px-2 text-foreground"
      >
        <span className="text-id shrink-0 font-mono tabular-nums text-muted-foreground">
          {project.key}
        </span>
        <span className="truncate">{project.name}</span>
      </Link>
      <button
        type="button"
        className="focus-ring relative mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background/70 hover:text-foreground"
        onClick={onEdit}
        aria-label={`Edit dates for ${project.name}`}
        title="Edit dates"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  );
}

function dateInputValue(value: Date | string | null | undefined): string {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

function parseDateInput(value: string): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

function RoadmapDateEditor({
  project,
  open,
  onClose,
}: {
  project: RoadmapProject | null;
  open: boolean;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [startDate, setStartDate] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !project) return;
    setStartDate(dateInputValue(project.startDate));
    setTargetDate(dateInputValue(project.targetDate));
    setError(null);
  }, [open, project]);

  const update = trpc.project.update.useMutation({
    onSuccess: () => {
      toast.success("Roadmap dates updated.");
      utils.project.list.invalidate();
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  async function handleSave() {
    if (!project) return;
    const start = parseDateInput(startDate);
    const target = parseDateInput(targetDate);
    if (start && target && target.getTime() < start.getTime()) {
      setError("Target date must be on or after the start date.");
      return;
    }
    setError(null);
    await update.mutateAsync({
      id: project.id,
      startDate: start,
      targetDate: target,
    });
  }

  return (
    <SidePanel
      open={open && !!project}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Project roadmap dates"
      description={project ? `${project.key} · ${project.name}` : undefined}
      footer={
        <div className="flex w-full items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setStartDate("");
              setTargetDate("");
            }}
            disabled={update.isPending}
          >
            Clear dates
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={update.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="ember"
              size="sm"
              onClick={handleSave}
              disabled={update.isPending}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              {update.isPending ? "Saving..." : "Save dates"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {error && (
          <div className="rounded-md border border-ember/30 bg-ember/10 px-2.5 py-2 text-xs text-foreground">
            {error}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <QuickForm.Field label="Start date">
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </QuickForm.Field>
          <QuickForm.Field label="Target date">
            <Input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          </QuickForm.Field>
        </div>
        <div className="text-meta rounded-md border border-border bg-background/40 px-3 py-2 text-muted-foreground">
          Projects with both dates render as bars. Projects with partial dates still reserve a short
          planning bar.
        </div>
      </div>
    </SidePanel>
  );
}

function LegendSwatch({ style, label }: { style: CSSProperties; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="h-3 w-4 rounded-sm border border-border/60"
        style={style}
      />
      {label}
    </span>
  );
}
