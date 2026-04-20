"use client";
import { useState } from "react";
import { toast } from "sonner";
import { QuickForm } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

/**
 * Shared "New cycle" dialog. Extracted so the cycles page and the
 * context-aware quick-create (`⇧C` on `/cycles`) can reach it without
 * duplicating the create-form fields or mutation wiring.
 *
 * Uses the <QuickForm> primitive — inherits ⏎/⎋ keyboard contract, draft
 * persistence (24h TTL via `draftKey`), and inline error banner.
 */
export function NewCycleDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [lengthDays, setLengthDays] = useState("");
  const utils = trpc.useUtils();

  const create = trpc.cycle.create.useMutation({
    onSuccess: () => {
      toast.success("Cycle created.");
      setName("");
      setStartsAt("");
      setLengthDays("");
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
      title="New cycle"
      primaryLabel={create.isPending ? "Creating…" : "Create"}
      loading={create.isPending}
      draftKey="cycle.create"
      onSubmit={async () => {
        if (!name.trim()) {
          return { error: "Name required." };
        }
        try {
          await create.mutateAsync({
            name: name.trim(),
            startsAt: startsAt ? new Date(startsAt) : undefined,
            lengthDays: lengthDays ? Number(lengthDays) : undefined,
          });
        } catch (e) {
          return { error: e instanceof Error ? e.message : "Failed to create cycle." };
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
            placeholder="7"
          />
        </QuickForm.Field>
      </div>
    </QuickForm>
  );
}
