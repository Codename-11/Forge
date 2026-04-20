"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

/**
 * Shared "New cycle" dialog. Extracted so the cycles page and the
 * context-aware quick-create (`⇧C` on `/cycles`) can reach it without
 * duplicating the create-form fields or mutation wiring.
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
      onClose();
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
