"use client";
import { useMemo } from "react";
import { Activity } from "lucide-react";
import { trpc } from "@/lib/trpc";
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

  const { pinned, rest } = useMemo(() => {
    const all = runs ?? [];
    const pinnedSet = new Set(pinnedIds);
    return {
      pinned: all.filter((r) => pinnedSet.has(r.id)),
      rest: all.filter((r) => !pinnedSet.has(r.id)),
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
          <SectionLabel>Active</SectionLabel>
        </>
      )}
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
    <div className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}
