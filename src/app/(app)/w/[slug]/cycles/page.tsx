"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, CalendarRange, Plus } from "lucide-react";
import { CycleStatus } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, Kbd, SkeletonList } from "@/components/ui";
import { CycleSummaryCard } from "@/components/cycles/cycle-summary-card";
import { CyclePlanningBoard } from "@/components/cycles/cycle-planning-board";
import { CycleBacklogPanel } from "@/components/cycles/cycle-backlog-panel";
import { NewCycleDialog } from "@/components/cycles/new-cycle-dialog";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";

export default function CyclesPage() {
  const ws = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const utils = trpc.useUtils();

  const { data: allCycles, isLoading: cyclesLoading } =
    trpc.cycle.list.useQuery({});

  // Order by startsAt desc matches the router; we want ascending traversal.
  const ordered = useMemo(
    () =>
      [...(allCycles ?? [])].sort(
        (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      ),
    [allCycles],
  );

  // Pick the active cycle by default; fall back to the most recent.
  const defaultIndex = useMemo(() => {
    const activeIdx = ordered.findIndex(
      (c) => c.status === CycleStatus.ACTIVE,
    );
    if (activeIdx !== -1) return activeIdx;
    return Math.max(0, ordered.length - 1);
  }, [ordered]);

  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const activeIdx = selectedIdx ?? defaultIndex;
  const cycle = ordered[activeIdx] ?? null;

  const { data: detail } = trpc.cycle.get.useQuery(
    { id: cycle?.id ?? "" },
    { enabled: !!cycle },
  );

  const plan = trpc.cycle.plan.useMutation({
    onSuccess: () => {
      utils.issue.list.invalidate();
      utils.cycle.get.invalidate({ id: cycle?.id });
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
      setSelectedIdx(null);
      router.refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const [createOpen, setCreateOpen] = useState(false);

  // Support `/cycles?new` so the sidebar chord / quick-create can deep-link
  // directly into the create dialog.
  useEffect(() => {
    if (searchParams?.has("new")) {
      setCreateOpen(true);
      const params = new URLSearchParams(searchParams.toString());
      params.delete("new");
      const q = params.toString();
      router.replace(q ? `${pathname}?${q}` : pathname);
    }
  }, [searchParams, pathname, router]);

  return (
    <>
      <Topbar
        title="Cycles"
        subtitle={
          ordered.length === 0
            ? undefined
            : `${ordered.length} total · ${ws.cycleLengthDays}d default`
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={activeIdx <= 0}
              onClick={() => setSelectedIdx(Math.max(0, activeIdx - 1))}
              aria-label="Previous cycle"
              title="Previous cycle"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={activeIdx >= ordered.length - 1}
              onClick={() =>
                setSelectedIdx(Math.min(ordered.length - 1, activeIdx + 1))
              }
              aria-label="Next cycle"
              title="Next cycle"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ember"
              size="sm"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              New cycle
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {cyclesLoading ? (
          <div className="p-4">
            <SkeletonList rows={5} />
          </div>
        ) : ordered.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <EmptyState
              variant="page"
              icon={<CalendarRange />}
              title="Your first cycle"
              description={
                <span>
                  A cycle is a time-boxed iteration. Work lands in cycles
                  and rolls over to the next one if unfinished. Press{" "}
                  <Kbd>⇧C</Kbd> anywhere to quick-create.
                </span>
              }
              action={
                <Button
                  variant="ember"
                  size="sm"
                  onClick={() => setCreateOpen(true)}
                >
                  Start first cycle
                </Button>
              }
            />
          </div>
        ) : cycle ? (
          <>
            <div className="shrink-0 px-4 pt-3">
              <CycleSummaryCard
                cycle={cycle}
                issues={detail?.issues ?? []}
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
          </>
        ) : null}
      </div>

      <NewCycleDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </>
  );
}
