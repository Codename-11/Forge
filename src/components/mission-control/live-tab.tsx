"use client";
import { useMemo } from "react";
import { Activity } from "lucide-react";
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
}: {
  pinnedIds: string[];
  onTogglePin: (runId: string) => void;
  activeRunId: string | null;
  setActiveRunId: (id: string | null) => void;
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

  return (
    <div className="space-y-1.5 overflow-y-auto px-2 py-2">
      {awaiting.length > 0 && (
        <>
          <SectionLabel>Needs approval</SectionLabel>
          {awaiting.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              pinned={pinnedIds.includes(run.id)}
              onTogglePin={() => onTogglePin(run.id)}
              active={activeRunId === run.id}
              onActivate={() => setActiveRunId(run.id)}
            />
          ))}
        </>
      )}
      {stalled.length > 0 && (
        <>
          <SectionLabel>Needs attention</SectionLabel>
          {stalled.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              pinned={pinnedIds.includes(run.id)}
              onTogglePin={() => onTogglePin(run.id)}
              active={activeRunId === run.id}
              onActivate={() => setActiveRunId(run.id)}
            />
          ))}
        </>
      )}
      {pinned.length > 0 && (
        <>
          <SectionLabel>Pinned</SectionLabel>
          {pinned.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              pinned={true}
              onTogglePin={() => onTogglePin(run.id)}
              active={activeRunId === run.id}
              onActivate={() => setActiveRunId(run.id)}
            />
          ))}
        </>
      )}
      {rest.length > 0 &&
        (stalled.length > 0 || pinned.length > 0 || awaiting.length > 0 ? (
          <SectionLabel>Active</SectionLabel>
        ) : (
          <SectionLabel>Running</SectionLabel>
        ))}
      {rest.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          pinned={false}
          onTogglePin={() => onTogglePin(run.id)}
          active={activeRunId === run.id}
          onActivate={() => setActiveRunId(run.id)}
        />
      ))}
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
