"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams, useParams } from "next/navigation";
import { LineChart } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui";
import { trpc } from "@/lib/trpc";

type TabKey = "issues" | "dispatch";

export default function AnalyticsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = (searchParams?.get("tab") ?? "issues") as TabKey;

  const setTab = (next: TabKey) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === "issues") params.delete("tab");
    else params.set("tab", next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <>
      <Topbar title="Analytics" subtitle="Throughput, flow time, SLA, dispatch" />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mb-5 flex items-center gap-1 border-b border-border text-xs">
          <TabButton active={tab === "issues"} onClick={() => setTab("issues")}>
            Issues
          </TabButton>
          <TabButton active={tab === "dispatch"} onClick={() => setTab("dispatch")}>
            Dispatch
          </TabButton>
        </div>

        {tab === "issues" ? <IssuesTab /> : <DispatchTab />}
      </div>
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 font-medium transition-colors ${
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Issues tab — same content as before the dispatch-analytics split. Kept
// verbatim so existing links / deep-links continue to work.
// ---------------------------------------------------------------------------

function IssuesTab() {
  const { data: summary, isLoading: summaryLoading } = trpc.analytics.summary.useQuery();
  const { data: dist } = trpc.analytics.statusDistribution.useQuery();
  const { data: throughput } = trpc.analytics.throughput.useQuery({
    granularity: "week",
    lookbackDays: 84,
  });
  const { data: cycle } = trpc.analytics.cycleTime.useQuery({ lookbackDays: 90 });
  const { data: breaches } = trpc.analytics.slaBreaches.useQuery();

  const params = useParams<{ slug: string }>();
  const slug = params?.slug;

  const isEmpty =
    !summaryLoading &&
    summary !== undefined &&
    summary.openIssues === 0 &&
    summary.doneIssues === 0 &&
    summary.overdue === 0 &&
    summary.totalProjects === 0;

  if (isEmpty) {
    return (
      <EmptyState
        variant="page"
        icon={<LineChart />}
        title="Not enough data yet"
        description="Analytics fill in once issues are moving — try creating a few or completing a sprint."
        action={
          slug ? (
            <Link href={`/w/${slug}/issues`}>
              <Button variant="ember" size="sm">
                Go to issues
              </Button>
            </Link>
          ) : undefined
        }
      />
    );
  }

  return (
    <>
      <section className="grid grid-cols-4 gap-3">
        <Stat label="Open" value={summary?.openIssues ?? "—"} />
        <Stat label="Done" value={summary?.doneIssues ?? "—"} />
        <Stat label="Overdue" value={summary?.overdue ?? "—"} tone="warn" />
        <Stat label="Projects" value={summary?.totalProjects ?? "—"} />
      </section>

      <section className="mt-6 grid grid-cols-2 gap-4">
        <Card title="Status distribution">
          <ul className="space-y-1.5">
            {(dist ?? []).map((d) => {
              const max = Math.max(1, ...(dist ?? []).map((x) => x.count));
              return (
                <li key={d.statusId} className="flex items-center gap-3 text-xs">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: d.color }} />
                  <span className="w-28 truncate">{d.name}</span>
                  <div className="h-1.5 flex-1 rounded-full bg-subtle">
                    <div
                      className="h-1.5 rounded-full"
                      style={{
                        width: `${(d.count / max) * 100}%`,
                        backgroundColor: d.color,
                      }}
                    />
                  </div>
                  <span className="w-8 text-right font-mono tabular-nums">{d.count}</span>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title="Throughput (weeks completed)">
          <div className="flex h-32 items-end gap-1">
            {(throughput ?? []).map((t) => {
              const max = Math.max(1, ...(throughput ?? []).map((x) => x.completed));
              return (
                <div
                  key={t.bucket}
                  title={`${t.bucket}: ${t.completed}`}
                  className="flex-1 rounded-sm bg-ember/70 hover:bg-ember"
                  style={{ height: `${(t.completed / max) * 100}%` }}
                />
              );
            })}
          </div>
        </Card>

        <Card title="Flow time (hours by priority)">
          <table className="w-full text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="py-1">Priority</th>
                <th>p50</th>
                <th>p90</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {(cycle ?? []).map((r) => (
                <tr key={r.priority} className="border-t border-border">
                  <td className="py-1">{r.priority}</td>
                  <td className="font-mono tabular-nums">{r.p50}h</td>
                  <td className="font-mono tabular-nums">{r.p90}h</td>
                  <td className="font-mono tabular-nums">{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="SLA breaches" tone={breaches && breaches.length > 0 ? "warn" : undefined}>
          {breaches && breaches.length === 0 ? (
            <div className="text-xs text-muted-foreground">No active breaches.</div>
          ) : (
            <ul className="space-y-1 text-xs">
              {(breaches ?? []).slice(0, 8).map((b) => (
                <li key={b.id} className="flex gap-2">
                  <span className="font-mono text-muted-foreground">#{b.number}</span>
                  <span className="truncate">{b.title}</span>
                  <span className="ml-auto font-mono text-danger">
                    +{Math.round(b.breachedBy)}m
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Dispatch tab — per-agent rollup + time-series + mode distribution.
// Charts are hand-rolled SVG so we don't add a chart-library dependency.
// ---------------------------------------------------------------------------

type SortKey = "assignments" | "meanTimeToFirstAction";

function DispatchTab() {
  const { data: summary, isLoading: summaryLoading } = trpc.analytics.dispatch.summary.useQuery({});
  const { data: series } = trpc.analytics.dispatch.timeseries.useQuery({
    bucket: "day",
  });
  const [sortKey, setSortKey] = useState<SortKey>("assignments");

  const params = useParams<{ slug: string }>();
  const slug = params?.slug;

  const sortedAgents = useMemo(() => {
    const rows = summary?.perAgent ?? [];
    return [...rows].sort((a, b) => {
      if (sortKey === "assignments") return b.assignments - a.assignments;
      // meanTimeToFirstAction — nulls last, asc (fastest first).
      const av = a.meanTimeToFirstAction;
      const bv = b.meanTimeToFirstAction;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av - bv;
    });
  }, [summary, sortKey]);

  const isEmpty = !summaryLoading && summary !== undefined && summary.totals.assignments === 0;

  if (isEmpty) {
    return (
      <EmptyState
        variant="page"
        icon={<LineChart />}
        title="Not enough data yet"
        description="Analytics fill in once issues are moving — try creating a few or completing a sprint."
        action={
          slug ? (
            <Link href={`/w/${slug}/issues`}>
              <Button variant="ember" size="sm">
                Go to issues
              </Button>
            </Link>
          ) : undefined
        }
      />
    );
  }

  return (
    <>
      <section className="grid grid-cols-4 gap-3">
        <Stat label="Assignments (30d)" value={summary?.totals.assignments ?? "—"} />
        <Stat label="Mean TTFA" value={formatDuration(summary?.totals.meanTimeToFirstAction)} />
        <Stat label="Mean TTC" value={formatDuration(summary?.totals.meanTimeToCompletion)} />
        <Stat label="Completed (7d)" value={summary?.totals.throughputLast7d ?? "—"} />
      </section>

      <section className="mt-6 grid grid-cols-3 gap-4">
        <Card title="Assignments vs completions (daily)" className="col-span-2">
          <Timeseries data={series ?? []} />
        </Card>
        <Card title="Mode distribution">
          <ModeBar dist={summary?.modeDistribution} />
        </Card>
      </section>

      <section className="mt-4">
        <Card title="Per-agent">
          <table className="w-full text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="py-1">Agent</th>
                <SortableHeader
                  label="Assignments"
                  active={sortKey === "assignments"}
                  onClick={() => setSortKey("assignments")}
                />
                <SortableHeader
                  label="TTFA"
                  active={sortKey === "meanTimeToFirstAction"}
                  onClick={() => setSortKey("meanTimeToFirstAction")}
                />
                <th>TTC</th>
                <th>Done 7d</th>
                <th title="Excluded assignments: no follow-up / still open">Excl.</th>
              </tr>
            </thead>
            <tbody>
              {sortedAgents.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-muted-foreground">
                    No dispatch activity in the last 30 days.
                  </td>
                </tr>
              ) : (
                sortedAgents.map((a) => (
                  <tr key={a.agentId} className="border-t border-border">
                    <td className="py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{a.avatar ?? ""}</span>
                        <div className="flex flex-col">
                          <span className="font-medium">{a.name}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            @{a.profileKey}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="font-mono tabular-nums">{a.assignments}</td>
                    <td className="font-mono tabular-nums">
                      {formatDuration(a.meanTimeToFirstAction)}
                    </td>
                    <td className="font-mono tabular-nums">
                      {formatDuration(a.meanTimeToCompletion)}
                    </td>
                    <td className="font-mono tabular-nums">{a.throughputLast7d}</td>
                    <td
                      className="font-mono tabular-nums text-muted-foreground"
                      title={`${a.assignmentsWithoutAction} with no follow-up · ${a.openAssignments} still open`}
                    >
                      {a.assignmentsWithoutAction + a.openAssignments}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
            Excluded from the means: assignments with no follow-up event (TTFA) and assignments
            whose issue is still open (TTC). The per-agent row surfaces them under the Excl. column.
          </p>
        </Card>
      </section>
    </>
  );
}

function SortableHeader({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <th>
      <button
        onClick={onClick}
        className={`flex items-center gap-1 text-[10px] uppercase tracking-wider ${
          active ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        {label}
        <span className="text-[9px]">{active ? "↓" : ""}</span>
      </button>
    </th>
  );
}

function Timeseries({
  data,
}: {
  data: Array<{ bucket: string; assignments: number; completions: number }>;
}) {
  const width = 480;
  const height = 140;
  const pad = { top: 8, right: 8, bottom: 18, left: 22 };

  if (data.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
        No activity in the window.
      </div>
    );
  }

  const max = Math.max(1, ...data.map((d) => Math.max(d.assignments, d.completions)));
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const stepX = data.length > 1 ? innerW / (data.length - 1) : innerW / 2;

  const toPath = (key: "assignments" | "completions") => {
    return data
      .map((d, i) => {
        const x = pad.left + (data.length > 1 ? i * stepX : innerW / 2);
        const y = pad.top + innerH - (d[key] / max) * innerH;
        return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  };

  return (
    <div className="overflow-hidden">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-36 w-full"
        role="img"
        aria-label="Assignments versus completions over time"
      >
        {/* baseline */}
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={height - pad.bottom}
          y2={height - pad.bottom}
          className="stroke-border"
          strokeWidth={1}
        />
        <text x={pad.left} y={pad.top + 4} className="fill-muted-foreground" fontSize="9">
          {max}
        </text>
        <path d={toPath("assignments")} fill="none" stroke="hsl(var(--ember))" strokeWidth={1.5} />
        <path
          d={toPath("completions")}
          fill="none"
          stroke="hsl(var(--success))"
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
      </svg>
      <div className="mt-1 flex items-center gap-4 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-ember" />
          Assignments
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 border-t border-dashed border-success" />
          Completions
        </span>
      </div>
    </div>
  );
}

function ModeBar({
  dist,
}: {
  dist?: Record<"ROUND_ROBIN" | "PRIORITY_MATCH" | "CAPABILITY_MATCH" | "MANUAL_ONLY", number>;
}) {
  const entries: Array<[keyof NonNullable<typeof dist>, string]> = [
    ["ROUND_ROBIN", "hsl(var(--ember))"],
    ["PRIORITY_MATCH", "hsl(var(--success))"],
    ["CAPABILITY_MATCH", "hsl(var(--warning))"],
    ["MANUAL_ONLY", "hsl(var(--muted-foreground))"],
  ];
  const total = dist ? entries.reduce((acc, [k]) => acc + (dist[k] ?? 0), 0) : 0;
  if (total === 0) {
    return <div className="text-xs text-muted-foreground">No assignments in the window.</div>;
  }
  return (
    <div className="space-y-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-subtle">
        {entries.map(([k, color]) => {
          const n = dist?.[k] ?? 0;
          if (n === 0) return null;
          return (
            <div
              key={k}
              style={{ width: `${(n / total) * 100}%`, backgroundColor: color }}
              title={`${k}: ${n}`}
            />
          );
        })}
      </div>
      <ul className="space-y-1 text-xs">
        {entries.map(([k, color]) => {
          const n = dist?.[k] ?? 0;
          return (
            <li key={k} className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
              <span className="flex-1 font-mono text-[11px]">{k.toLowerCase()}</span>
              <span className="font-mono tabular-nums">{n}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** ms → "1.3d" / "4h" / "17m" / "9s". `null` renders as em-dash. */
function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  const d = h / 24;
  return `${d.toFixed(1)}d`;
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "warn" }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "warn" ? "text-warning" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function Card({
  title,
  tone,
  children,
  className,
}: {
  title: string;
  tone?: "warn";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-border bg-card/40 p-4 ${className ?? ""}`}>
      <div
        className={`mb-3 text-[11px] font-semibold uppercase tracking-wider ${tone === "warn" ? "text-warning" : "text-muted-foreground"}`}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
