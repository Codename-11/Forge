"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

const DEFAULT_COLORS = [
  "#d97706",
  "#ca8a04",
  "#65a30d",
  "#0ea5e9",
  "#7c3aed",
  "#be185d",
  "#78716c",
];

/**
 * Shared "New initiative" dialog. Same form used on the initiatives page
 * and via the context-aware quick-create trigger (`⇧C` on `/initiatives`).
 */
export function NewInitiativeDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [color, setColor] = useState(DEFAULT_COLORS[0]);
  const utils = trpc.useUtils();

  const create = trpc.initiative.create.useMutation({
    onSuccess: () => {
      toast.success("Initiative created.");
      setName("");
      setSlug("");
      setDescription("");
      setTargetDate("");
      setColor(DEFAULT_COLORS[0]);
      utils.initiative.list.invalidate();
      onCreated?.();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  function onNameChange(v: string) {
    setName(v);
    if (!slug) {
      const suggested = v
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 48);
      setSlug(suggested);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) {
            toast.error("Name required.");
            return;
          }
          create.mutate({
            name: name.trim(),
            slug: slug.trim() || undefined,
            description: description.trim() || undefined,
            targetDate: targetDate ? new Date(targetDate) : undefined,
            color,
          });
        }}
        className="space-y-3 p-5"
      >
        <div className="text-sm font-semibold">New initiative</div>
        <div className="grid grid-cols-[1fr_200px] gap-2">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Slug</label>
            <Input
              value={slug}
              onChange={(e) =>
                setSlug(
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, "-")
                    .replace(/-+/g, "-")
                    .slice(0, 48),
                )
              }
              placeholder="q2-launch"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Target date</label>
            <Input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-8 w-10 cursor-pointer rounded border border-input bg-background"
              />
              <div className="flex flex-wrap gap-1">
                {DEFAULT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className="h-5 w-5 rounded border border-border"
                    style={{ backgroundColor: c }}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
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
