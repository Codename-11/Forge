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
 * Shared "New project" dialog. Used by the projects page and by the
 * context-aware quick-create (`⇧C` on `/projects`).
 */
export function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(DEFAULT_COLORS[0]);
  const [icon, setIcon] = useState("");
  const utils = trpc.useUtils();

  const create = trpc.project.create.useMutation({
    onSuccess: () => {
      toast.success("Project created.");
      setName("");
      setKey("");
      setDescription("");
      setColor(DEFAULT_COLORS[0]);
      setIcon("");
      utils.project.list.invalidate();
      onCreated?.();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  // Suggest key from the first 1-3 word initials when the user hasn't
  // edited the key field yet.
  function onNameChange(v: string) {
    setName(v);
    if (!key) {
      const suggested = v
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 3)
        .map((w) => w[0]?.toUpperCase() ?? "")
        .join("");
      if (suggested.length >= 2) setKey(suggested.slice(0, 6));
    }
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !key.trim()) {
            toast.error("Name and key are required.");
            return;
          }
          create.mutate({
            name: name.trim(),
            key: key.trim().toUpperCase(),
            description: description.trim() || undefined,
            color,
            icon: icon.trim() || undefined,
          });
        }}
        className="space-y-3 p-5"
      >
        <div className="text-sm font-semibold">New project</div>
        <div className="grid grid-cols-[1fr_120px] gap-2">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => onNameChange(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Key</label>
            <Input
              value={key}
              onChange={(e) =>
                setKey(e.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase())
              }
              placeholder="FRG"
              maxLength={8}
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
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Icon (emoji)</label>
            <Input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={8} />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="ember" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create project"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
