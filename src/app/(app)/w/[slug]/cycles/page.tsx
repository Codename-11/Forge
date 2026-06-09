"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, CalendarRange, Inbox, Plus, Settings2 } from "lucide-react";
import { CycleStatus } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { CycleSummaryCard } from "@/components/cycles/cycle-summary-card";
import { CyclePlanningBoard } from "@/components/cycles/cycle-planning-board";
import { CycleBacklogPanel } from "@/components/cycles/cycle-backlog-panel";
import { EditCycleDialog } from "@/components/cycles/edit-cycle-dialog";
import { NewCycleDialog } from "@/components/cycles/new-cycle-dialog";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";

export default function CyclesPage() {
  const ws = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const utils = trpc.useUtils();

  const { data: allCycles, isLoading: cyclesLoading } = trpc.cycle.list.useQuery({});

  // Order by startsAt desc matches the router; we want ascending traversal.
  const ordered = useMemo(
    () =>
      [...(allCycles ?? [])].sort(
        (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      ),
    [allCycles],
  );

  // Pick the active sprint by default; internally this is still a cycle row.
  const defaultIndex = useMemo(() => {
    const activeIdx = ordered.findIndex((c) => c.status === CycleStatus.ACTIVE);
    if (activeIdx !== -1) return activeIdx;
    return Math.max(0, ordered.length - 1);
  }, [ordered]);

  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const activeIdx = selectedIdx ?? defaultIndex;
  const cycle = ordered[activeIdx] ?? null;
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const { data: detail } = trpc.cycle.get.useQuery({ id: cycle?.id ?? "" }, { enabled: !!cycle });

  const plan = trpc.cycle.plan.useMutation({
    onSuccess: () => {
      utils.issue.list.invalidate();
      utils.cycle.get.invalidate({ id: cycle?.id });
      toast.success("Planned into sprint.");
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

  useEffect(() => {
    if (selectedIdx !== null && selectedIdx >= ordered.length) {
      setSelectedIdx(null);
    }
  }, [ordered.length, selectedIdx]);

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
        title="Sprints"
        subtitle={
          ordered.length === 0
            ? undefined
            : `${ordered.length} total · ${ws.cycleLengthDays}d default`
        }
        actions={
          <>
            {/* Segmented sprint pager: [‹ | Sprint name | ›] with the
                current sprint name shown between the chevrons. */}
            {cycle && (
              <div className="flex items-center rounded-md border border-border">
                <button
                  type="button"
                  disabled={activeIdx <= 0}
                  onClick={() => setSelectedIdx(Math.max(0, activeIdx - 1))}
                  aria-label="Previous sprint"
                  title="Previous sprint"
                  className="focus-ring flex h-7 w-7 items-center justify-center rounded-l-md text-muted-foreground hover:bg-subtle hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <select
                  value={cycle.id}
                  onChange={(e) => {
                    const next = ordered.findIndex((c) => c.id === e.target.value);
                    if (next !== -1) setSelectedIdx(next);
                  }}
                  aria-label="Select sprint"
                  className="focus-ring h-7 max-w-[16rem] border-x border-border bg-transparent px-2 text-xs font-medium tabular-nums text-foreground"
                >
                  {ordered.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {c.status}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={activeIdx >= ordered.length - 1}
                  onClick={() => setSelectedIdx(Math.min(ordered.length - 1, activeIdx + 1))}
                  aria-label="Next sprint"
                  title="Next sprint"
                  className="focus-ring flex h-7 w-7 items-center justify-center rounded-r-md text-muted-foreground hover:bg-subtle hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {cycle && (
              <Button variant="outline" size="sm" onClick={() => setManageOpen(true)}>
                <Settings2 className="h-3.5 w-3.5" />
                Manage
              </Button>
            )}
            {cycle && (
              <Button
                variant={backlogOpen ? "subtle" : "outline"}
                size="sm"
                onClick={() => setBacklogOpen((open) => !open)}
                aria-pressed={backlogOpen}
              >
                <Inbox className="h-3.5 w-3.5" />
                Backlog
              </Button>
            )}
            {/* Always-available rollover. Reuses the same mutation the
                summary card fires. The server enforces the active-sprint
                gate, so we disable + retitle when it isn't applicable
                rather than hiding the button. */}
            {cycle && (
              <Button
                variant="outline"
                size="sm"
                disabled={cycle.status !== CycleStatus.ACTIVE || rollover.isPending}
                title={
                  cycle.status !== CycleStatus.ACTIVE
                    ? "Rollover is only available for the active sprint"
                    : "Move incomplete issues into the next sprint"
                }
                onClick={() => rollover.mutate({ fromCycleId: cycle.id })}
              >
                {rollover.isPending ? "Rolling over…" : "Rollover incomplete"}
              </Button>
            )}
            <Button variant="ember" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              New sprint
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
              title="No sprints yet"
              description="Sprints are time-boxed iterations — usually a week or two — for moving a focused batch of issues. Create one to start planning."
              action={
                <Button variant="ember" size="sm" onClick={() => setCreateOpen(true)}>
                  New sprint
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
                  onPlanCurrentSprint={() => {
                    setBacklogOpen(true);
                    toast.message("Backlog opened. Drag issues into any sprint column.");
                  }}
                  onDropFromBacklog={(issueId) =>
                    plan.mutate({ cycleId: cycle.id, issueIds: [issueId] })
                  }
                />
              </div>
              <CycleBacklogPanel open={backlogOpen} onOpenChange={setBacklogOpen} />
            </div>
          </>
        ) : null}
      </div>

      <EditCycleDialog
        open={manageOpen}
        cycle={cycle}
        onClose={() => setManageOpen(false)}
        onUpdated={() => {
          utils.cycle.list.invalidate();
          if (cycle?.id) utils.cycle.get.invalidate({ id: cycle.id });
        }}
      />
      <NewCycleDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => setSelectedIdx(null)}
      />
    </>
  );
}
