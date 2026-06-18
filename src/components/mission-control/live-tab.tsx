"use client";
import { useMemo } from "react";
import Link from "next/link";
import { Activity, ExternalLink } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { STALE_RUN_MS } from "@/lib/agent-stale";
import { RunRow } from "./run-row";

/**
 * Live tab. Pinned runs first (in a faint header section), then all
 * other ACTIVE runs in lastEventAt-desc order. Empty state explains
 * how runs open.
 */

export function LiveTab({
  pinnedIds,
  onTogglePin,
  activeRunId,
  setActiveRunId,
  commandCenterHref,
}: {
  pinnedIds: string[];
  onTogglePin: (runId: string) => void;
  activeRunId: string | null;
  setActiveRunId: (id: string | null) => void;
  commandCenterHref: string;
}) {
  const { data: runs, isLoading } = trpc.agentRun.activeAll.useQuery(
    { limit: 25 },
    { staleTime: 3_000 },
  );

  const { awaiting, stalled, pinned, rest } = useMemo(() => {
    const all = runs ?? [];
    const pinnedSet = new Set(pinnedIds);
    // Blocked-on-approval runs float to the very top — they're idle until a
    // human approves/rejects, so they're the most actionable thing here.
    const awaitingRows = all.filter((r) => r.awaitingApprovalAt != null);
    const awaitingSet = new Set(awaitingRows.map((r) => r.id));
    const stalledRows = all.filter(
      (r) =>
        !awaitingSet.has(r.id) &&
        Date.now() - new Date(r.lastEventAt).getTime() > STALE_RUN_MS,
    );
    const stalledSet = new Set(stalledRows.map((r) => r.id));
    const excluded = (id: string) => awaitingSet.has(id) || stalledSet.has(id);
    return {
      awaiting: awaitingRows,
      stalled: stalledRows,
      pinned: all.filter((r) => pinnedSet.has(r.id) && !excluded(r.id)),
      rest: all.filter((r) => !pinnedSet.has(r.id) && !excluded(r.id)),
    };
  }, [runs, pinnedIds]);

  if (isLoading && (runs ?? []).length === 0) {
    return (
      <div className="px-3 py-4 text-meta text-muted-foreground">Loading…</div>
    );
  }

  if ((runs ?? []).length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <Activity className="h-5 w-5 text-muted-foreground" />
        <div className="text-meta text-foreground/80">No active runs.</div>
        <div className="text-meta text-muted-foreground">
          A run opens when an agent acks a dispatch or posts a status.
        </div>
      </div>
    );
  }

  const groups = [
    { label: "Needs approval", rows: awaiting },
    { label: "Needs attention", rows: stalled },
    { label: "Pinned", rows: pinned },
    {
      label:
        stalled.length > 0 || pinned.length > 0 || awaiting.length > 0
          ? "Active"
          : "Running",
      rows: rest,
    },
  ];
  const maxPreviewRows = 8;
  let remainingRows = maxPreviewRows;
  let visibleCount = 0;
  const visibleGroups = groups
    .map((group) => {
      if (remainingRows <= 0 || group.rows.length === 0) {
        return { ...group, rows: [] };
      }
      const rows = group.rows.slice(0, remainingRows);
      remainingRows -= rows.length;
      visibleCount += rows.length;
      return { ...group, rows };
    })
    .filter((group) => group.rows.length > 0);
  const hiddenCount = Math.max(0, (runs ?? []).length - visibleCount);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 py-2">
        {visibleGroups.map((group) => (
          <div key={group.label} className="space-y-1.5">
            <SectionLabel>{group.label}</SectionLabel>
            {group.rows.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                pinned={pinnedIds.includes(run.id)}
                onTogglePin={() => onTogglePin(run.id)}
                active={activeRunId === run.id}
                onActivate={() => setActiveRunId(run.id)}
              />
            ))}
          </div>
        ))}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border/70 px-3 py-2 text-meta">
        <span className="min-w-0 truncate text-muted-foreground">
          Previewing {visibleCount} of {(runs ?? []).length}
          {hiddenCount > 0 ? ` · ${hiddenCount} more` : ""}
        </span>
        <Link
          href={commandCenterHref}
          className="focus-ring inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[0.6875rem] text-foreground/80 hover:border-ember/40 hover:text-foreground"
        >
          Command Center
          <ExternalLink className="h-3 w-3" />
        </Link>
      </footer>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 pt-1 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}
