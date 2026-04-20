"use client";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";

/**
 * Backlog side-panel for cycle planning. Lists issues with no cycle
 * assignment. Each row is draggable — drop onto any column of
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
    <aside className="flex h-full w-72 shrink-0 flex-col border-l border-border bg-card/40">
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
          <div className="p-2 text-[11px] text-muted-foreground">Loading…</div>
        )}
        {!isLoading && (data?.items.length ?? 0) === 0 && (
          <div className="p-3 text-center text-[11px] text-muted-foreground">
            Backlog empty. Create issues or move some out of a cycle.
          </div>
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
                )}
                title="Drag to a column to plan into this cycle"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {formatIssueId(ws.key, i.number)}
                  </span>
                  {i.project && (
                    <span
                      className="ml-auto font-mono text-[10px] text-muted-foreground"
                    >
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
