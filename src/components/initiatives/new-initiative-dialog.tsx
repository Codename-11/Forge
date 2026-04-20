"use client";
import { useState } from "react";
import { toast } from "sonner";
import { QuickForm } from "@/components/ui/modal";
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
 *
 * Uses the <QuickForm> primitive — inherits ⏎/⎋ keyboard contract, draft
 * persistence (24h TTL via `draftKey`), and inline error banner.
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
    },
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
    <QuickForm
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="New initiative"
      primaryLabel={create.isPending ? "Creating…" : "Create"}
      loading={create.isPending}
      draftKey="initiative.create"
      onSubmit={async () => {
        if (!name.trim()) {
          return { error: "Name required." };
        }
        try {
          await create.mutateAsync({
            name: name.trim(),
            slug: slug.trim() || undefined,
            description: description.trim() || undefined,
            targetDate: targetDate ? new Date(targetDate) : undefined,
            color,
          });
        } catch (e) {
          return { error: e instanceof Error ? e.message : "Failed to create initiative." };
        }
      }}
    >
      <div className="grid grid-cols-[1fr_200px] gap-2">
        <QuickForm.Field label="Name">
          <Input
            name="name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            autoFocus
          />
        </QuickForm.Field>
        <QuickForm.Field label="Slug">
          <Input
            name="slug"
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
        </QuickForm.Field>
      </div>
      <QuickForm.Field label="Description">
        <textarea
          name="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm"
        />
      </QuickForm.Field>
      <div className="grid grid-cols-2 gap-2">
        <QuickForm.Field label="Target date">
          <Input
            name="targetDate"
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </QuickForm.Field>
        <QuickForm.Field label="Color">
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
        </QuickForm.Field>
      </div>
    </QuickForm>
  );
}
