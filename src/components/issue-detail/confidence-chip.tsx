"use client";
import { cn } from "@/lib/utils";

/**
 * `ConfidenceChip` — small inline pill rendered next to an agent
 * comment's timestamp, reflecting the agent's *self-reported* confidence
 * in the response. The signal is opt-in: only AGENT-authored comments
 * with a non-null `confidence` ever render the chip; human comments
 * never do, even if the field happens to be set.
 *
 * Tone:
 *   - LOW     — warm amber; calls the operator's eye to "double-check
 *               this one before acting".
 *   - MEDIUM  — muted neutral; reads as ambient context.
 *   - HIGH    — soft success; signals "agent is confident, fine to
 *               proceed without re-deriving".
 *
 * The tooltip surfaces the optional `reason` field when present so the
 * operator can scrub a sentence-long explanation without expanding any
 * additional UI.
 */

export type ConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

export function ConfidenceChip({
  level,
  reason,
  className,
}: {
  level: ConfidenceLevel;
  reason?: string | null;
  className?: string;
}) {
  const label =
    level === "LOW" ? "low confidence" : level === "HIGH" ? "high" : "medium";
  const tooltip = [
    "Agent self-reported confidence in this comment.",
    reason ? reason : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      title={tooltip}
      className={cn(
        "inline-flex items-center rounded-sm px-1 py-px font-mono text-[0.5625rem] uppercase tracking-wider",
        level === "LOW" &&
          "border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        level === "MEDIUM" &&
          "border border-border bg-subtle/60 text-muted-foreground",
        level === "HIGH" &&
          "border border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        className,
      )}
      aria-label={`Agent confidence: ${label}`}
    >
      {label}
    </span>
  );
}
