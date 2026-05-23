"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Bot, Check, X as XIcon, Hourglass } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ActivityHeatmap } from "./activity-heatmap";
import { TimelineScrubber, type ScrubberEvent } from "./timeline-scrubber";
import { Swimlane, type SwimlaneRun } from "./swimlane";

/**
 * History tab. Three sections stacked top-to-bottom:
 *   1. Activity heatmap — last 90 days of AgentRunEvents.
 *   2. Timeline scrubber — last 60min of activity, drag a window.
 *   3. Recent terminal runs — last hour of COMPLETED/STALLED/ABANDONED.
 *
 * The heatmap is the macro view; the scrubber is the recent-activity
 * tape; the terminal list is the "what just shipped" log.
 */

function relativeTime(input: Date | string): string {
  const t = typeof input === "string" ? new Date(input) : input;
  const ms = Date.now() - t.getTime();
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function fmtCost(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function HistoryTab({ slug: _slug }: { slug: string }) {
  const [activityView, setActivityView] = useState<"heatmap" | "swimlane">("heatmap");

  // Heatmap autosizing. Measure the card's inner width and lay out a
  // GitHub-style grid that fills it *exactly*: keep the column pitch near
  // ~13px (≈11px cell + 2px gap) so the cell height is unchanged, pick the
  // week count that best fits the width, then derive a fractional cell
  // size so the columns span the full width with no right-edge gap and no
  // overflow. `days` is fetched to match the visible range so the grid
  // fills with real data instead of capping at a fixed 90.
  const CELL_GAP = 2;
  const LABEL_RESERVE = 32; // day-of-week label column + the gap before the grid
  const TARGET_PITCH = 13; // px per column at the reference 11px cell
  const heatmapBoxRef = useRef<HTMLDivElement | null>(null);
  const [heatmapWidth, setHeatmapWidth] = useState(0);
  useEffect(() => {
    if (activityView !== "heatmap") return;
    const node = heatmapBoxRef.current;
    if (!node) return;
    const measure = (w: number) => setHeatmapWidth(w);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) measure(e.contentRect.width);
    });
    ro.observe(node);
    // clientWidth includes the p-2 padding; subtract it to match contentRect.
    measure(Math.max(0, node.clientWidth - 16));
    return () => ro.disconnect();
  }, [activityView]);

  const usableWidth = useMemo(
    () => Math.max(0, heatmapWidth - LABEL_RESERVE),
    [heatmapWidth],
  );
  const computedWeeks = useMemo(() => {
    if (usableWidth < 1) return 16;
    const weeks = Math.round((usableWidth + CELL_GAP) / TARGET_PITCH);
    return Math.max(10, Math.min(53, weeks)); // 10 weeks … ~1 year
  }, [usableWidth]);
  const heatmapCell = useMemo(() => {
    if (usableWidth < 1) return 11;
    const raw = (usableWidth - (computedWeeks - 1) * CELL_GAP) / computedWeeks;
    return Math.max(9, Math.min(15, raw));
  }, [usableWidth, computedWeeks]);

  const { data: heatmap } = trpc.agentRun.heatmap.useQuery(
    { days: Math.min(365, computedWeeks * 7) },
    { staleTime: 60_000 },
  );

  const { data: swimlaneRuns } = trpc.agentRun.runsInRange.useQuery(
    { fromMinutesAgo: 60, limit: 200 },
    { enabled: activityView === "swimlane", staleTime: 5_000 },
  );
  const { data: terminal } = trpc.agentRun.recentTerminal.useQuery(
    { windowMinutes: 60, limit: 30 },
    { staleTime: 5_000 },
  );
  const { data: costStats } = trpc.agentRun.costByAgent.useQuery(
    { sinceDays: 30 },
    { staleTime: 60_000 },
  );

  // Scrubber pulls events from the last hour. Re-anchored every minute
  // so the data stays current without drift.
  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 60 * 60_000);
    return { from, to };
  }, []);
  const { data: rangeEvents } = trpc.agentRun.eventsInRange.useQuery(
    { from: range.from, to: range.to, limit: 200 },
    { staleTime: 5_000 },
  );

  const scrubberEvents: ScrubberEvent[] = useMemo(() => {
    return (rangeEvents ?? []).map((e) => {
      const issueKey = e.run?.issue
        ? `${e.run.issue.workspace.key}-${e.run.issue.number}`
        : null;
      return {
        id: e.id,
        ts: e.createdAt,
        kind: e.kind,
        agentName: e.run?.agent?.name ?? "agent",
        issueKey,
      };
    });
  }, [rangeEvents]);

  const spend = costStats?.totals;
  return (
    <div className="space-y-3 overflow-y-auto px-2 py-2">
      {spend && spend.runs > 0 && (
        <section>
          <SectionHeader>Spend · last 30d</SectionHeader>
          <div className="grid grid-cols-3 gap-1.5">
            <SpendStat label="Cost" value={fmtCost(spend.costUsd)} />
            <SpendStat label="Runs" value={`${spend.runs}`} />
            <SpendStat
              label="Tokens"
              value={fmtTokens(spend.tokensIn + spend.tokensOut)}
              title={`${fmtTokens(spend.tokensIn)} in · ${fmtTokens(spend.tokensOut)} out · ${fmtTokens(spend.tokensCached)} cached`}
            />
          </div>
        </section>
      )}
      <section>
        <div className="flex items-center justify-between">
          <SectionHeader>
            Activity · {activityView === "heatmap" ? `last ${computedWeeks * 7} days` : "last 60m"}
          </SectionHeader>
          <div className="mb-1.5 flex rounded-md border border-border bg-card/40 p-0.5 text-[0.5625rem]">
            <button
              type="button"
              onClick={() => setActivityView("heatmap")}
              className={cn(
                "rounded px-1.5 py-0.5",
                activityView === "heatmap"
                  ? "bg-subtle text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              heatmap
            </button>
            <button
              type="button"
              onClick={() => setActivityView("swimlane")}
              className={cn(
                "rounded px-1.5 py-0.5",
                activityView === "swimlane"
                  ? "bg-subtle text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              swimlane
            </button>
          </div>
        </div>
        {activityView === "heatmap" ? (
          <div
            ref={heatmapBoxRef}
            className="rounded-md border border-border bg-card/40 p-2"
          >
            <ActivityHeatmap
              data={heatmap ?? []}
              weeks={computedWeeks}
              cellSize={heatmapCell}
              cellGap={CELL_GAP}
            />
          </div>
        ) : (
          <Swimlane
            runs={(swimlaneRuns ?? []) as SwimlaneRun[]}
            windowMinutes={60}
          />
        )}
      </section>

      <section>
        <SectionHeader>Last hour</SectionHeader>
        <TimelineScrubber events={scrubberEvents} height={64} />
      </section>

      <section>
        <SectionHeader>Recently finished</SectionHeader>
        <div className="space-y-1">
          {(terminal ?? []).length === 0 && (
            <div className="rounded-md border border-border/60 bg-card/30 px-2 py-2 text-meta text-muted-foreground">
              Nothing finished in the last hour.
            </div>
          )}
          {(terminal ?? []).map((r) => {
            const issueKey = r.issue
              ? `${r.issue.workspace.key}-${r.issue.number}`
              : "—";
            const issueHref = r.issue
              ? `/w/${r.issue.workspace.slug}/issues/${r.issue.id}`
              : null;
            const Icon =
              r.status === "COMPLETED" ? Check : r.status === "STALLED" ? Hourglass : XIcon;
            const tint =
              r.status === "COMPLETED"
                ? "text-emerald-600"
                : r.status === "STALLED"
                  ? "text-amber-500"
                  : "text-muted-foreground";
            return (
              <div
                key={r.id}
                className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-[0.75rem]"
              >
                <Icon className={cn("h-3 w-3 shrink-0", tint)} />
                <Bot className="h-3 w-3 shrink-0 text-foreground/70" />
                <span className="truncate font-medium text-foreground">{r.agent.name}</span>
                <span className="text-muted-foreground">·</span>
                {issueHref ? (
                  <Link
                    href={issueHref}
                    className="font-mono text-[0.6875rem] text-foreground/80 hover:text-ember"
                  >
                    {issueKey}
                  </Link>
                ) : (
                  <span className="font-mono text-[0.6875rem] text-foreground/60">{issueKey}</span>
                )}
                <span className="ml-auto text-meta text-muted-foreground">
                  {r.finishedAt ? relativeTime(r.finishedAt) : ""}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 px-1 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

function SpendStat({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div
      className="rounded-md border border-border bg-card/40 px-2 py-1.5"
      title={title}
    >
      <div className="text-[0.5625rem] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-sm tabular-nums text-foreground">{value}</div>
    </div>
  );
}
