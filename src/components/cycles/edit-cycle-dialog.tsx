"use client";
import { useEffect, useState } from "react";
import { Archive, Save } from "lucide-react";
import { CycleStatus } from "@prisma/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QuickForm, SidePanel } from "@/components/ui/modal";
import { trpc } from "@/lib/trpc";

type EditableCycle = {
  id: string;
  name: string;
  startsAt: Date | string;
  endsAt: Date | string;
  status: CycleStatus;
};

function dateInputValue(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10);
}

export function EditCycleDialog({
  open,
  cycle,
  onClose,
  onUpdated,
}: {
  open: boolean;
  cycle: EditableCycle | null;
  onClose: () => void;
  onUpdated?: () => void;
}) {
  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [status, setStatus] = useState<CycleStatus>(CycleStatus.PLANNED);
  const [error, setError] = useState<string | null>(null);
  const utils = trpc.useUtils();

  useEffect(() => {
    if (!open || !cycle) return;
    setName(cycle.name);
    setStartsAt(dateInputValue(cycle.startsAt));
    setEndsAt(dateInputValue(cycle.endsAt));
    setStatus(cycle.status);
    setError(null);
  }, [cycle, open]);

  const update = trpc.cycle.update.useMutation({
    onSuccess: () => {
      toast.success("Sprint updated.");
      utils.cycle.list.invalidate();
      if (cycle?.id) utils.cycle.get.invalidate({ id: cycle.id });
      onUpdated?.();
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  const archive = trpc.cycle.archive.useMutation({
    onSuccess: () => {
      toast.success("Sprint marked complete.");
      utils.cycle.list.invalidate();
      if (cycle?.id) utils.cycle.get.invalidate({ id: cycle.id });
      onUpdated?.();
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  async function handleSave() {
    if (!cycle) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name required.");
      return;
    }
    const start = startsAt ? new Date(startsAt) : null;
    const end = endsAt ? new Date(endsAt) : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setError("Start and end dates are required.");
      return;
    }
    if (end.getTime() <= start.getTime()) {
      setError("End date must be after start date.");
      return;
    }

    setError(null);
    await update.mutateAsync({
      id: cycle.id,
      name: trimmed,
      startsAt: start,
      endsAt: end,
      status,
    });
  }

  return (
    <SidePanel
      open={open && !!cycle}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Manage sprint"
      description={cycle?.name}
      footer={
        <div className="flex w-full items-center gap-2">
          {cycle?.status !== CycleStatus.COMPLETED && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => cycle && archive.mutate({ id: cycle.id })}
              disabled={archive.isPending || update.isPending}
              title="Mark this sprint complete"
            >
              <Archive className="h-3.5 w-3.5" />
              Complete
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={archive.isPending || update.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="ember"
              size="sm"
              onClick={handleSave}
              disabled={archive.isPending || update.isPending}
            >
              <Save className="h-3.5 w-3.5" />
              {update.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {error && (
          <div className="rounded-md border border-ember/30 bg-ember/10 px-2.5 py-2 text-xs text-foreground">
            {error}
          </div>
        )}
        <QuickForm.Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </QuickForm.Field>
        <div className="grid grid-cols-2 gap-2">
          <QuickForm.Field label="Starts" required>
            <Input
              type="date"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </QuickForm.Field>
          <QuickForm.Field label="Ends" required>
            <Input
              type="date"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </QuickForm.Field>
        </div>
        <QuickForm.Field label="Status">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as CycleStatus)}
            className="focus-ring h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value={CycleStatus.PLANNED}>Planned</option>
            <option value={CycleStatus.ACTIVE}>Active</option>
            <option value={CycleStatus.COMPLETED}>Completed</option>
            <option value={CycleStatus.CANCELED}>Canceled</option>
          </select>
        </QuickForm.Field>
        <div className="rounded-md border border-border bg-background/40 px-3 py-2 text-meta text-muted-foreground">
          Status changes keep the sprint row and issue assignments intact.
        </div>
      </div>
    </SidePanel>
  );
}
