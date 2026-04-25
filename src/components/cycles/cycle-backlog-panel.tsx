"use client";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { EmptyState, Skeleton } from "@/components/ui";
import { useWorkspace } from "@/hooks/use-workspace";

/**
 * Backlog side-panel for sprint planning. Lists issues with no internal
 * `cycleId` assignment. Each row is draggable — drop onto any column of
 * CyclePlanningBoard to `cycle.plan` it.
 */
export function CycleBacklogPanel() {
  const ws = useWorkspace();
  const { data, isLoading } = trpc.issue.list.useQuery({
    cycleId: null,
    includeDone: false,
    limit: 100,
  });

  return (
    <aside
      data-cycle-backlog-panel
      className="hidden h-full w-72 shrink-0 flex-col border-l border-border bg-card/40 lg:flex"
    >
      <header className="flex h-9 items-center gap-2 border-b border-border px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Backlog
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {data?.items.length ?? 0}
        </span>
      </header>
      <div className="flex-1 overflow-y-auto p-2">
        {isLoading && (
          <div className="space-y-1.5 p-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}
        {!isLoading && (data?.items.length ?? 0) === 0 && (
          <EmptyState
            variant="card"
            title="Backlog empty."
            description="Create issues or move some out of a sprint."
          />
        )}
        <ul className="space-y-1">
          {data?.items.map((i) => (
            <li key={i.id}>
              <div
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData(
                    "application/x-forge-drag",
                    JSON.stringify({ kind: "backlog", issueId: i.id }),
                  );
                }}
                className={cn(
                  "group cursor-grab rounded-md border border-border bg-background p-2 text-left hover:border-ember/40 active:cursor-grabbing",
                  MOTION.fast,
                )}
                title="Drag to a column to plan into this sprint"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {formatIssueId(ws.key, i.number)}
                  </span>
                  {i.project && (
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {i.project.key}
                    </span>
                  )}
                </div>
                <div className="mt-1 truncate text-xs">{i.title}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
