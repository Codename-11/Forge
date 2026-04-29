"use client";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Visual overlay shown while a file is dragged over a drop target. Sits
 * absolutely inside a `relative` parent, ignores pointer events so the
 * underlying drop handlers still receive the dragleave/drop. Warm-earthy
 * accent ring + hint copy. Intentionally subtle — not a full takeover.
 */
export function DropOverlay({
  active,
  label = "Drop to attach",
  className,
}: {
  active: boolean;
  label?: string;
  className?: string;
}) {
  if (!active) return null;
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-ember/40 bg-ember/10",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1.5 rounded-md border border-ember/30 bg-card/80 px-2 py-1 text-meta font-medium text-foreground shadow-sm">
        <Upload className="h-3 w-3 text-ember" />
        {label}
      </span>
    </div>
  );
}
