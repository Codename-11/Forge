"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Inbox, Settings2 } from "lucide-react";
import { CycleStatus } from "@prisma/client";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { CycleSummaryCard } from "@/components/cycles/cycle-summary-card";
import { CyclePlanningBoard } from "@/components/cycles/cycle-planning-board";
import { CycleBacklogPanel } from "@/components/cycles/cycle-backlog-panel";
import { EditCycleDialog } from "@/components/cycles/edit-cycle-dialog";
import { RolloverCycleDialog } from "@/components/cycles/rollover-cycle-dialog";
import { PinButton } from "@/components/pins/pin-button";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";

/**
 * Sprint detail — same surface as /cycles but pinned to a specific internal
 * cycle row. Past sprints render in read-mostly mode (the board is still draggable,
 * but the prominent rollover CTA only appears on the final day).
 */
export default function CycleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [rolloverOpen, setRolloverOpen] = useState(false);

  const { data: cycle, error, isLoading } = trpc.cycle.get.useQuery({ id });
  const { data: allCycles } = trpc.cycle.list.useQuery({});
  const otherActiveCycleName =
    allCycles?.find((c) => c.status === CycleStatus.ACTIVE && c.id !== id)?.name ?? null;

  const plan = trpc.cycle.plan.useMutation({
    onSuccess: () => {
      utils.issue.list.invalidate();
      utils.cycle.get.invalidate({ id });
      toast.success("Planned into sprint.");
    },
    onError: (e) => toast.error(e.message),
  });

  // Phase 1C — record this visit so it surfaces in the command palette's
  // Recents rail. Server-side debounced 5s.
  const trackM = trpc.recentItem.track.useMutation();
  useEffect(() => {
    if (cycle?.id) {
      trackM.mutate({ targetType: "CYCLE", targetId: cycle.id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycle?.id]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          variant="page"
          title="Sprint not found"
          description={error.message}
          action={
            <Button variant="outline" size="sm" onClick={() => router.push(`/w/${ws.slug}/cycles`)}>
              Back to sprints
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
          <>
            <PinButton targetType="CYCLE" targetId={cycle.id} workspaceId={ws.id} />
            <Button variant="outline" size="sm" onClick={() => setManageOpen(true)}>
              <Settings2 className="h-3.5 w-3.5" />
              Manage
            </Button>
            <Button
              variant={backlogOpen ? "subtle" : "outline"}
              size="sm"
              onClick={() => setBacklogOpen((open) => !open)}
              aria-pressed={backlogOpen}
            >
              <Inbox className="h-3.5 w-3.5" />
              Backlog
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={cycle.status !== CycleStatus.ACTIVE}
              title={
                cycle.status !== CycleStatus.ACTIVE
                  ? "Rollover is only available for the active sprint"
                  : "Move incomplete issues into the next sprint"
              }
              onClick={() => setRolloverOpen(true)}
            >
              Rollover incomplete
            </Button>
            <Button variant="ghost" size="sm" onClick={() => router.push(`/w/${ws.slug}/cycles`)}>
              All sprints
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="shrink-0 px-4 pt-3">
          <CycleSummaryCard
            cycle={cycle}
            issues={cycle.issues}
            onRollover={() => setRolloverOpen(true)}
          />
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1">
            <CyclePlanningBoard
              cycleId={cycle.id}
              onPlanCurrentSprint={() => {
                setBacklogOpen(true);
                toast.message("Backlog opened. Drag issues into any sprint column.");
              }}
              onDropFromBacklog={(issueId) =>
                plan.mutate({ cycleId: cycle.id, issueIds: [issueId] })
              }
            />
          </div>
          <CycleBacklogPanel
            open={backlogOpen}
            onOpenChange={setBacklogOpen}
            onPlanIssue={(issueId) => plan.mutate({ cycleId: cycle.id, issueIds: [issueId] })}
          />
        </div>
      </div>
      <EditCycleDialog
        open={manageOpen}
        cycle={cycle}
        onClose={() => setManageOpen(false)}
        onUpdated={() => {
          utils.cycle.list.invalidate();
          utils.cycle.get.invalidate({ id: cycle.id });
        }}
        onDeleted={() => router.push(`/w/${ws.slug}/cycles`)}
        activeCycleName={otherActiveCycleName}
      />
      <RolloverCycleDialog
        open={rolloverOpen}
        cycle={cycle}
        onClose={() => setRolloverOpen(false)}
        onRolled={() => router.push(`/w/${ws.slug}/cycles`)}
      />
    </>
  );
}
