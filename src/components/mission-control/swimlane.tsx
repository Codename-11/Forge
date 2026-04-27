"use client";
import { useMemo } from "react";
import { cn } from "@/lib/utils";

export type SwimlaneRun = {
  id: string;
  status: "ACTIVE" | "COMPLETED" | "ABANDONED" | "STALLED";
  startedAt: Date | string;
  finishedAt: Date | string | null;
  lastEventAt: Date | string;
  agent: { id: string; name: string; profileKey: string };
  issue: { number: number; workspace: { key: string; slug: string } } | null;
};

interface SwimlaneProps {
  runs: SwimlaneRun[];
  windowMinutes: number;
}

const LANE_HEIGHT = 18;
const LANE_GAP = 4;
const LABEL_COLUMN_WIDTH = 56;

const STATUS_COLOR: Record<SwimlaneRun["status"], string> = {
  ACTIVE: "bg-ember/80",
  COMPLETED: "bg-emerald-500/70",
  ABANDONED: "bg-stone-400/60",
  STALLED: "bg-amber-500/70",
};

/**
 * Horizontal swimlane: one lane per agent, x-axis is `windowMinutes`
 * wide ending at "now". Each AgentRun is a colored bar on its agent's
 * lane, colored by terminal status. ACTIVE bars pulse at the trailing
 * edge so the eye lands on what's currently running.
 */
export function Swimlane({ runs, windowMinutes }: SwimlaneProps) {
  const now = Date.now();
  const start = now - windowMinutes * 60_000;

  const agents = useMemo(() => {
    const seen = new Map<string, SwimlaneRun["agent"]>();
    for (const r of runs) seen.set(r.agent.id, r.agent);
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [runs]);

  const runsByAgent = useMemo(() => {
    const map = new Map<string, SwimlaneRun[]>();
    for (const r of runs) {
      if (!map.has(r.agent.id)) map.set(r.agent.id, []);
      map.get(r.agent.id)!.push(r);
    }
    return map;
  }, [runs]);

  if (agents.length === 0) {
    return (
      <div className="rounded-md border border-border/60 bg-card/30 px-2 py-3 text-center text-meta text-muted-foreground">
        No agent activity in the last {windowMinutes}m.
      </div>
    );
  }

  // Tick marks every ~10 minutes.
  const tickMinutes = Math.max(5, Math.round(windowMinutes / 6));
  const ticks: number[] = [];
  for (let m = 0; m <= windowMinutes; m += tickMinutes) ticks.push(m);

  const totalHeight = agents.length * (LANE_HEIGHT + LANE_GAP);

  return (
    <div className="rounded-md border border-border bg-card/40 p-2">
      {/* Tick row */}
      <div
        className="relative mb-1 flex items-center text-[0.5625rem] text-muted-foreground"
        style={{ paddingLeft: LABEL_COLUMN_WIDTH }}
      >
        <div className="relative h-3 w-full">
          {ticks.map((m) => {
            const left = ((windowMinutes - m) / windowMinutes) * 100;
            return (
              <span
                key={m}
                className="absolute -translate-x-1/2 font-mono"
                style={{ left: `${left}%` }}
                title={`${m}m ago`}
              >
                {m === 0 ? "now" : `-${m}m`}
              </span>
            );
          })}
        </div>
      </div>
      <div
        className="relative"
        style={{ height: totalHeight }}
      >
        {agents.map((a, idx) => {
          const top = idx * (LANE_HEIGHT + LANE_GAP);
          const lanes = runsByAgent.get(a.id) ?? [];
          return (
            <div
              key={a.id}
              className="absolute left-0 right-0"
              style={{ top, height: LANE_HEIGHT }}
            >
              <div
                className="absolute left-0 top-0 flex h-full items-center font-mono text-[0.625rem] text-foreground/80"
                style={{ width: LABEL_COLUMN_WIDTH }}
                title={a.name}
              >
                <span className="truncate">{a.profileKey}</span>
              </div>
              <div
                className="absolute right-0 top-0 h-full overflow-hidden rounded bg-subtle/30"
                style={{ left: LABEL_COLUMN_WIDTH }}
              >
                {lanes.map((r) => {
                  const startMs = new Date(r.startedAt).getTime();
                  const endMs = r.finishedAt
                    ? new Date(r.finishedAt).getTime()
                    : Math.min(now, new Date(r.lastEventAt).getTime() + 30_000);
                  const x1 = Math.max(0, (Math.max(startMs, start) - start) / (windowMinutes * 60_000));
                  const x2 = Math.max(x1, Math.min(1, (endMs - start) / (windowMinutes * 60_000)));
                  const widthPct = Math.max(0.5, (x2 - x1) * 100);
                  const issueKey = r.issue
                    ? `${r.issue.workspace.key}-${r.issue.number}`
                    : null;
                  const isActive = r.status === "ACTIVE";
                  return (
                    <div
                      key={r.id}
                      className={cn(
                        "absolute top-1 h-3 rounded",
                        STATUS_COLOR[r.status],
                        isActive && "animate-pulse",
                      )}
                      style={{ left: `${x1 * 100}%`, width: `${widthPct}%` }}
                      title={`${a.name} · ${issueKey ?? "?"} · ${r.status.toLowerCase()}`}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {/* Legend */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.5625rem] text-muted-foreground">
        <LegendDot color="bg-ember/80" label="active" />
        <LegendDot color="bg-emerald-500/70" label="done" />
        <LegendDot color="bg-amber-500/70" label="stalled" />
        <LegendDot color="bg-stone-400/60" label="abandoned" />
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("h-2 w-2 rounded", color)} />
      <span>{label}</span>
    </span>
  );
}
