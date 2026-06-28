"use client";
import { useEffect, useState } from "react";
import { Archive, Save, Trash2 } from "lucide-react";
import { CycleStatus } from "@prisma/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Confirm, QuickForm, SidePanel } from "@/components/ui/modal";
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
  onDeleted,
  activeCycleName,
}: {
  open: boolean;
  cycle: EditableCycle | null;
  onClose: () => void;
  onUpdated?: () => void;
  onDeleted?: () => void;
  activeCycleName?: string | null;
}) {
  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [status, setStatus] = useState<CycleStatus>(CycleStatus.PLANNED);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
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

  const del = trpc.cycle.delete.useMutation({
    onSuccess: (res) => {
      toast.success(
        res.clearedIssueCount > 0
          ? `Sprint deleted. ${res.clearedIssueCount} issue(s) returned to backlog.`
          : "Sprint deleted.",
      );
      utils.cycle.list.invalidate();
      utils.issue.list.invalidate();
      if (cycle?.id) utils.cycle.get.invalidate({ id: cycle.id });
      setDeleteOpen(false);
      onDeleted?.();
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
    if (status === CycleStatus.ACTIVE && activeCycleName && cycle.status !== CycleStatus.ACTIVE) {
      setError(
        `Sprint "${activeCycleName}" is already active. Complete it before starting another sprint.`,
      );
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

  const activeConflict = activeCycleName && cycle?.status !== CycleStatus.ACTIVE;

  return (
    <>
      <SidePanel
        open={open && !!cycle}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        title="Manage sprint"
        description={cycle?.name}
        footer={
          <div className="flex w-full items-center gap-2">
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              disabled={archive.isPending || update.isPending || del.isPending}
              title="Delete this sprint"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
            {cycle?.status !== CycleStatus.COMPLETED && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => cycle && archive.mutate({ id: cycle.id })}
                disabled={archive.isPending || update.isPending || del.isPending}
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
                disabled={archive.isPending || update.isPending || del.isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="ember"
                size="sm"
                onClick={handleSave}
                disabled={archive.isPending || update.isPending || del.isPending}
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
              <DatePicker
                value={startsAt}
                onChange={(v) => setStartsAt(v)}
                placeholder="Start date"
                ariaLabel="Starts"
              />
            </QuickForm.Field>
            <QuickForm.Field label="Ends" required>
              <DatePicker
                value={endsAt}
                onChange={(v) => setEndsAt(v)}
                placeholder="End date"
                ariaLabel="Ends"
              />
            </QuickForm.Field>
          </div>
          <QuickForm.Field
            label="Status"
            hint={
              activeConflict
                ? `Active is unavailable while "${activeCycleName}" is active.`
                : undefined
            }
          >
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as CycleStatus)}
              className="focus-ring h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              <option value={CycleStatus.PLANNED}>Planned</option>
              <option value={CycleStatus.ACTIVE} disabled={!!activeConflict}>
                Active
              </option>
              <option value={CycleStatus.COMPLETED}>Completed</option>
              <option value={CycleStatus.CANCELED}>Canceled</option>
            </select>
          </QuickForm.Field>
          <div className="text-meta rounded-md border border-border bg-background/40 px-3 py-2 text-muted-foreground">
            Status changes keep the sprint row and issue assignments intact.
          </div>
        </div>
      </SidePanel>
      <Confirm
        open={deleteOpen && !!cycle}
        onOpenChange={setDeleteOpen}
        title="Delete sprint?"
        description="Issues assigned to this sprint will return to backlog. This cannot be undone."
        primaryLabel={del.isPending ? "Deleting..." : "Delete sprint"}
        variant="destructive"
        typeToConfirm={cycle?.name}
        loading={del.isPending}
        onConfirm={async () => {
          if (!cycle) return;
          await del.mutateAsync({ id: cycle.id });
        }}
      />
    </>
  );
}
