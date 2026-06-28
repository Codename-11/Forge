"use client";
import { useEffect, useState } from "react";
import { CycleStatus } from "@prisma/client";
import { toast } from "sonner";
import { QuickForm } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { trpc } from "@/lib/trpc";

/**
 * Shared "New sprint" dialog. Internally this still calls the cycle router;
 * product language stays Sprint while the data model remains Cycle.
 * Extracted so the sprints page and context-aware quick-create (`⇧C` on `/cycles`) can reach it without
 * duplicating the create-form fields or mutation wiring.
 *
 * Uses the <QuickForm> primitive — inherits ⏎/⎋ keyboard contract, draft
 * persistence (24h TTL via `draftKey`), and inline error banner.
 */
export function NewCycleDialog({
  open,
  onClose,
  onCreated,
  defaultLengthDays,
  activeCycleName,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
  defaultLengthDays?: number;
  activeCycleName?: string | null;
}) {
  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [lengthDays, setLengthDays] = useState("");
  const [status, setStatus] = useState<CycleStatus>(CycleStatus.PLANNED);
  const utils = trpc.useUtils();

  useEffect(() => {
    if (activeCycleName && status === CycleStatus.ACTIVE) {
      setStatus(CycleStatus.PLANNED);
    }
  }, [activeCycleName, status]);

  const create = trpc.cycle.create.useMutation({
    onSuccess: () => {
      toast.success("Sprint created.");
      setName("");
      setStartsAt("");
      setLengthDays("");
      setStatus(CycleStatus.PLANNED);
      utils.cycle.list.invalidate();
      onCreated?.();
    },
  });

  return (
    <QuickForm
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="New sprint"
      description={
        defaultLengthDays
          ? `Defaults to ${defaultLengthDays} days when length is blank.`
          : undefined
      }
      primaryLabel={create.isPending ? "Creating…" : "Create"}
      loading={create.isPending}
      draftKey="cycle.create"
      onSubmit={async () => {
        if (!name.trim()) {
          return { error: "Name required." };
        }
        if (status === CycleStatus.ACTIVE && activeCycleName) {
          return {
            error: `Sprint "${activeCycleName}" is already active. Complete it before starting another sprint.`,
          };
        }
        try {
          await create.mutateAsync({
            name: name.trim(),
            startsAt: startsAt ? new Date(startsAt) : undefined,
            lengthDays: lengthDays ? Number(lengthDays) : undefined,
            status,
          });
        } catch (e) {
          return { error: e instanceof Error ? e.message : "Failed to create sprint." };
        }
      }}
    >
      <QuickForm.Field label="Name">
        <Input
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Sprint 12 · Q2 Launch · …"
          autoFocus
        />
      </QuickForm.Field>
      <div className="grid grid-cols-2 gap-2">
        <QuickForm.Field label="Starts">
          <Input
            name="startsAt"
            type="date"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </QuickForm.Field>
        <QuickForm.Field label="Length (days)">
          <Input
            name="lengthDays"
            type="number"
            min={1}
            max={365}
            value={lengthDays}
            onChange={(e) => setLengthDays(e.target.value)}
            placeholder={defaultLengthDays ? String(defaultLengthDays) : undefined}
          />
        </QuickForm.Field>
      </div>
      <QuickForm.Field
        label="Status"
        hint={
          activeCycleName
            ? `Active is unavailable while "${activeCycleName}" is active.`
            : undefined
        }
      >
        <Combobox
          value={status}
          onChange={(v) => setStatus((v ?? CycleStatus.PLANNED) as CycleStatus)}
          options={[
            { value: CycleStatus.PLANNED, label: "Planned" },
            // Active is unavailable (omitted) while another sprint is active.
            ...(activeCycleName
              ? []
              : [{ value: CycleStatus.ACTIVE, label: "Active" }]),
            { value: CycleStatus.COMPLETED, label: "Completed" },
            { value: CycleStatus.CANCELED, label: "Canceled" },
          ]}
          ariaLabel="Status"
          matchTriggerWidth
          className="h-9 w-full"
        />
      </QuickForm.Field>
    </QuickForm>
  );
}
