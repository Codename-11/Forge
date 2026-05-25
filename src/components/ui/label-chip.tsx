import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Bordered label chip. Distinct from the color-washed <Badge>: a neutral
 * bordered pill with a small color dot + the label name. Mirrors the
 * design's canonical LabelChip primitive.
 */
export function LabelChip({
  label,
  className,
}: {
  label: { name: string; color: string };
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-meta",
        className,
      )}
    >
      <span
        aria-hidden
        className="rounded-full"
        style={{ height: 7, width: 7, backgroundColor: label.color }}
      />
      <span className="text-foreground/85">{label.name}</span>
    </span>
  );
}
