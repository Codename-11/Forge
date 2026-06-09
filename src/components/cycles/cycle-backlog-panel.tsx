"use client";
import { Inbox, PanelRightClose, PanelRightOpen } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { Button, EmptyState, Skeleton } from "@/components/ui";
import { useWorkspace } from "@/hooks/use-workspace";

/**
 * Backlog side-panel for sprint planning. Lists issues with no internal
 * `cycleId` assignment. Each row is draggable — drop onto any column of
 * CyclePlanningBoard to `cycle.plan` it.
 */
export function CycleBacklogPanel({
  open = true,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const ws = useWorkspace();
  const { data, isLoading } = trpc.issue.list.useQuery({
    cycleId: null,
    includeDone: false,
    limit: 100,
  });
  const items = data?.items ?? [];

  if (!open) {
    return (
      <aside className="hidden h-full w-11 shrink-0 border-l border-border bg-card/30 lg:flex">
        <button
          type="button"
          onClick={() => onOpenChange?.(true)}
          className="focus-ring flex h-full w-full flex-col items-center gap-2 px-2 py-3 text-muted-foreground hover:bg-subtle/50 hover:text-foreground"
          title="Open backlog"
          aria-label="Open backlog"
        >
          <PanelRightOpen className="h-4 w-4" />
          <span className="font-mono text-[0.6875rem] tabular-nums">
            {items.length}
          </span>
          <span className="[writing-mode:vertical-rl] text-meta">Backlog</span>
        </button>
      </aside>
    );
  }

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-30 bg-foreground/20 backdrop-blur-sm lg:hidden"
        aria-label="Close backlog"
        onClick={() => onOpenChange?.(false)}
      />
      <aside
        data-cycle-backlog-panel
        className={cn(
          "fixed inset-y-0 right-0 z-40 flex w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden border-l border-border bg-card shadow-xl",
          "lg:relative lg:inset-auto lg:z-auto lg:h-full lg:w-80 lg:shrink-0 lg:rounded-lg lg:border lg:border-dashed lg:bg-card/40 lg:shadow-none",
          MOTION.slideInRight,
        )}
      >
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <Inbox className="h-3 w-3 text-muted-foreground" />
          <span className="text-sm font-medium">Backlog</span>
          <span className="font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
            {items.length}
          </span>
          <span className="ml-auto text-meta text-muted-foreground">drag {"->"} plan</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onOpenChange?.(false)}
            title="Collapse backlog"
            aria-label="Collapse backlog"
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {isLoading && (
            <div className="space-y-1.5 p-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          )}
          {!isLoading && items.length === 0 && (
            <EmptyState
              variant="card"
              title="Backlog empty."
              description="Create issues or move some out of a sprint."
            />
          )}
          <ul className="space-y-1">
            {items.map((i) => (
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
                    <span className="text-id text-muted-foreground">
                      {formatIssueId(ws.key, i.number)}
                    </span>
                    {i.project && (
                      <span className="ml-auto text-id text-muted-foreground">
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
    </>
  );
}
