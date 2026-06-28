"use client";
import { useEffect, useState } from "react";
import { QuickForm } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import {
  ColorSwatchPicker,
  DEFAULT_LABEL_COLORS,
} from "@/components/ui/color-swatch-picker";
import { trpc } from "@/lib/trpc";

export type CreatedLabel = { id: string; name: string; color: string };

/**
 * Inline "create label" dialog — used from label pickers so you don't have to
 * leave for Settings → Labels first. Built on the shared `QuickForm` +
 * `ColorSwatchPicker` primitives (no native elements). Admin-gated at the
 * call-site (label.create is admin-only); this component assumes the caller
 * already decided it's allowed.
 */
export function CreateLabelModal({
  open,
  onOpenChange,
  initialName = "",
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName?: string;
  onCreated?: (label: CreatedLabel) => void;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(DEFAULT_LABEL_COLORS[0]);
  const create = trpc.label.create.useMutation();

  // Re-seed from the originating query each time the modal opens.
  useEffect(() => {
    if (open) {
      setName(initialName);
      setColor(DEFAULT_LABEL_COLORS[0]);
    }
  }, [open, initialName]);

  return (
    <QuickForm
      open={open}
      onOpenChange={onOpenChange}
      title="New label"
      description="Create a label and add it to this issue."
      primaryLabel="Create"
      loading={create.isPending}
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) return { error: "Name is required." };
        // mutateAsync throws on error → QuickForm shows it inline and stays
        // open; on success QuickForm closes itself.
        const label = await create.mutateAsync({ name: trimmed, color });
        await utils.label.list.invalidate();
        onCreated?.(label);
      }}
    >
      <QuickForm.Field label="Name" required htmlFor="new-label-name">
        <input
          id="new-label-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          maxLength={40}
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. needs-review"
          className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground"
        />
      </QuickForm.Field>
      <QuickForm.Field label="Color">
        <ColorSwatchPicker value={color} onChange={setColor} />
      </QuickForm.Field>
      <div>
        <Badge color={color}>{name.trim() || "preview"}</Badge>
      </div>
    </QuickForm>
  );
}
