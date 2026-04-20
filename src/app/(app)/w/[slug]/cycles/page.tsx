"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, CalendarRange, Plus } from "lucide-react";
import { CycleStatus } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/settings/empty-state";
import { CycleSummaryCard } from "@/components/cycles/cycle-summary-card";
import { CyclePlanningBoard } from "@/components/cycles/cycle-planning-board";
import { CycleBacklogPanel } from "@/components/cycles/cycle-backlog-panel";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";

export default function CyclesPage() {
  const ws = useWorkspace();
  const router = useRouter();
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
          <div className="p-8 text-sm text-muted-foreground">Loading cycles…</div>
        ) : ordered.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <EmptyState
              as="div"
              icon={CalendarRange}
              title="Your first cycle"
              hint="A cycle is a time-boxed iteration. Work lands in cycles and rolls over to the next one if unfinished."
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

      <CreateCycleDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          utils.cycle.list.invalidate();
          setCreateOpen(false);
        }}
      />
    </>
  );
}

function CreateCycleDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [lengthDays, setLengthDays] = useState("");

  const create = trpc.cycle.create.useMutation({
    onSuccess: () => {
      toast.success("Cycle created.");
      setName("");
      setStartsAt("");
      setLengthDays("");
      onCreated();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onClose={onClose} className="max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) {
            toast.error("Name required.");
            return;
          }
          create.mutate({
            name: name.trim(),
            startsAt: startsAt ? new Date(startsAt) : undefined,
            lengthDays: lengthDays ? Number(lengthDays) : undefined,
          });
        }}
        className="space-y-3 p-5"
      >
        <div className="text-sm font-semibold">New cycle</div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sprint 12 · Q2 Launch · …"
            autoFocus
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Starts</label>
            <Input
              type="date"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Length (days)</label>
            <Input
              type="number"
              min={1}
              max={365}
              value={lengthDays}
              onChange={(e) => setLengthDays(e.target.value)}
              placeholder="7"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="ember" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
