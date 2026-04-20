"use client";
import { use } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { CycleSummaryCard } from "@/components/cycles/cycle-summary-card";
import { CyclePlanningBoard } from "@/components/cycles/cycle-planning-board";
import { CycleBacklogPanel } from "@/components/cycles/cycle-backlog-panel";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";

/**
 * Cycle detail — same surface as /cycles but pinned to a specific cycle.
 * Past cycles render in read-mostly mode (the board is still draggable,
 * but the prominent rollover CTA only appears on the final day).
 */
export default function CycleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const ws = useWorkspace();
  const utils = trpc.useUtils();

  const { data: cycle, error, isLoading } = trpc.cycle.get.useQuery({ id });

  const plan = trpc.cycle.plan.useMutation({
    onSuccess: () => {
      utils.issue.list.invalidate();
      utils.cycle.get.invalidate({ id });
      toast.success("Planned into cycle.");
    },
    onError: (e) => toast.error(e.message),
  });

  const rollover = trpc.cycle.rollover.useMutation({
    onSuccess: (res) => {
      utils.cycle.list.invalidate();
      utils.cycle.get.invalidate();
      utils.issue.list.invalidate();
      toast.success(`Rolled over ${res.rolled} issue(s).`);
      router.push(`/w/${ws.slug}/cycles`);
    },
    onError: (e) => toast.error(e.message),
  });

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          variant="page"
          title="Cycle not found"
          description={error.message}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/w/${ws.slug}/cycles`)}
            >
              Back to cycles
            </Button>
          }
        />
      </div>
    );
  }
  if (isLoading || !cycle)
    return (
      <div className="p-4">
        <SkeletonList rows={6} />
      </div>
    );

  return (
    <>
      <Topbar
        title={cycle.name}
        subtitle={cycle.status}
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`/w/${ws.slug}/cycles`)}
          >
            All cycles
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="shrink-0 px-4 pt-3">
          <CycleSummaryCard
            cycle={cycle}
            issues={cycle.issues}
            onRollover={() => rollover.mutate({ fromCycleId: cycle.id })}
            rolloverPending={rollover.isPending}
          />
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1">
            <CyclePlanningBoard
              cycleId={cycle.id}
              onDropFromBacklog={(issueId) =>
                plan.mutate({ cycleId: cycle.id, issueIds: [issueId] })
              }
            />
          </div>
          <CycleBacklogPanel />
        </div>
      </div>
    </>
  );
}
