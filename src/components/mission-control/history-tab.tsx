"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Bot, Check, X as XIcon, Hourglass } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ActivityHeatmap } from "./activity-heatmap";
import { TimelineScrubber, type ScrubberEvent } from "./timeline-scrubber";

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

export function HistoryTab({ slug: _slug }: { slug: string }) {
  const { data: heatmap } = trpc.agentRun.heatmap.useQuery(
    { days: 90 },
    { staleTime: 60_000 },
  );
  const { data: terminal } = trpc.agentRun.recentTerminal.useQuery(
    { windowMinutes: 60, limit: 30 },
    { staleTime: 5_000 },
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

  // Heatmap autosizing: measure the card's inner width and derive how
  // many weeks fit at our cell size. The grid stays calibrated to the
  // panel without hardcoded width assumptions, so resizing the panel
  // (or future "expanded" mode) just shows more history.
  const heatmapBoxRef = useRef<HTMLDivElement | null>(null);
  const [heatmapWidth, setHeatmapWidth] = useState(0);
  useEffect(() => {
    const node = heatmapBoxRef.current;
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setHeatmapWidth(e.contentRect.width);
    });
    ro.observe(node);
    setHeatmapWidth(node.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  // Cells are 11px with a 2px gap; reserve ~26px for the day labels in
  // the heatmap component. Min 12 weeks, max 30 (≈7 months).
  const computedWeeks = useMemo(() => {
    if (heatmapWidth < 1) return 16;
    const usable = Math.max(0, heatmapWidth - 28);
    const weeks = Math.floor((usable + 2) / (11 + 2));
    return Math.max(12, Math.min(30, weeks));
  }, [heatmapWidth]);

  return (
    <div className="space-y-3 overflow-y-auto px-2 py-2">
      <section>
        <SectionHeader>Activity · last {computedWeeks * 7} days</SectionHeader>
        <div
          ref={heatmapBoxRef}
          className="rounded-md border border-border bg-card/40 p-2"
        >
          <ActivityHeatmap
            data={heatmap ?? []}
            weeks={computedWeeks}
            cellSize={11}
            cellGap={2}
          />
        </div>
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
