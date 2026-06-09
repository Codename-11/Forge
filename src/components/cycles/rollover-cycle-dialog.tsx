"use client";
import { useEffect, useState } from "react";
import { ArrowRightCircle } from "lucide-react";
import { CycleStatus } from "@prisma/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SidePanel } from "@/components/ui/modal";
import { trpc } from "@/lib/trpc";

type RolloverCycle = {
  id: string;
  name: string;
  status: CycleStatus;
};

export function RolloverCycleDialog({
  open,
  cycle,
  onClose,
  onRolled,
}: {
  open: boolean;
  cycle: RolloverCycle | null;
  onClose: () => void;
  onRolled?: () => void;
}) {
  const utils = trpc.useUtils();
  const [completeSource, setCompleteSource] = useState(true);
  const [activateTarget, setActivateTarget] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCompleteSource(true);
    setActivateTarget(false);
    setError(null);
  }, [open, cycle?.id]);

  useEffect(() => {
    if (activateTarget) setCompleteSource(true);
  }, [activateTarget]);

  const rollover = trpc.cycle.rollover.useMutation({
    onSuccess: (res) => {
      void utils.cycle.list.invalidate();
      void utils.cycle.get.invalidate();
      void utils.issue.list.invalidate();
      const parts = [`${res.rolled} issue${res.rolled === 1 ? "" : "s"} moved`];
      if (res.sourceCompleted) parts.push("source completed");
      if (res.targetActivated) parts.push("next sprint started");
      toast.success(parts.join(" · "));
      onRolled?.();
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  async function handleRollover() {
    if (!cycle) return;
    setError(null);
    await rollover.mutateAsync({
      fromCycleId: cycle.id,
      completeSource,
      activateTarget,
    });
  }

  return (
    <SidePanel
      open={open && !!cycle}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Rollover incomplete work"
      description={cycle?.name}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={rollover.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="ember"
            size="sm"
            onClick={handleRollover}
            disabled={rollover.isPending || !cycle}
          >
            <ArrowRightCircle className="h-3.5 w-3.5" />
            {rollover.isPending ? "Rolling over..." : "Rollover"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {error && (
          <div className="rounded-md border border-ember/30 bg-ember/10 px-2.5 py-2 text-xs text-foreground">
            {error}
          </div>
        )}
        <div className="rounded-md border border-border bg-background/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          Incomplete issues move to the next planned sprint. If there is no later planned sprint,
          Forge creates one using the workspace sprint settings.
        </div>

        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background/40 p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-ember"
            checked={completeSource}
            disabled={activateTarget}
            onChange={(e) => setCompleteSource(e.target.checked)}
          />
          <span className="space-y-0.5">
            <span className="block font-medium text-foreground">Complete current sprint</span>
            <span className="block text-xs text-muted-foreground">
              Mark the source sprint completed after moving unfinished work.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background/40 p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-ember"
            checked={activateTarget}
            onChange={(e) => setActivateTarget(e.target.checked)}
          />
          <span className="space-y-0.5">
            <span className="block font-medium text-foreground">Start the next sprint</span>
            <span className="block text-xs text-muted-foreground">
              Activate the target sprint now. This also completes the current sprint.
            </span>
          </span>
        </label>

        {cycle?.status !== CycleStatus.ACTIVE && (
          <div className="text-meta rounded-md border border-border bg-card/40 px-3 py-2 text-muted-foreground">
            This sprint is not active, so rollover will move unfinished work without changing the
            current active sprint unless you start the target.
          </div>
        )}
      </div>
    </SidePanel>
  );
}
