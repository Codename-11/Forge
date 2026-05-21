"use client";
import { cn } from "@/lib/utils";

/**
 * Horizontal budget burn meter. Two variants:
 *   - cost: spent / max in USD
 *   - time: elapsed / max in minutes
 *
 * Fill color escalates with burn: ember under 80%, amber at 80%+,
 * danger at 100%+. The fill width animates via a CSS transition so a
 * realtime budget bump glides rather than jumps. When no cap is set we
 * render an "uncapped" track (spend shown, no fill ratio).
 *
 * Reduced motion: the width transition is a plain CSS transition (not a
 * keyframe loop), so it's a one-shot ease — acceptable under
 * reduced-motion, and we keep it short via MOTION-style timing.
 */
export function BudgetMeter({
  variant = "cost",
  value,
  max,
  label,
  className,
}: {
  variant?: "cost" | "time";
  /** spent USD (cost) or elapsed minutes (time) */
  value: number;
  /** cap, or null/undefined for uncapped */
  max?: number | null;
  /** override the leading label */
  label?: string;
  className?: string;
}) {
  const hasCap = typeof max === "number" && max > 0;
  const ratio = hasCap ? Math.min(value / (max as number), 1.5) : 0;
  const pct = Math.min(ratio * 100, 100);

  const tone =
    ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : "ember";
  const fillClass =
    tone === "danger"
      ? "bg-danger"
      : tone === "warning"
        ? "bg-warning"
        : "bg-ember";

  const fmt =
    variant === "cost"
      ? (n: number) => `$${n.toFixed(2)}`
      : (n: number) => `${Math.round(n)}m`;

  const headline = hasCap
    ? `${fmt(value)} / ${fmt(max as number)}`
    : fmt(value);

  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[0.625rem] uppercase tracking-wider text-muted-foreground">
          {label ?? (variant === "cost" ? "Budget" : "Time")}
        </span>
        <span
          className={cn(
            "font-mono text-[0.625rem]",
            ratio >= 1
              ? "text-danger"
              : ratio >= 0.8
                ? "text-warning"
                : "text-muted-foreground",
          )}
        >
          {headline}
          {!hasCap && (
            <span className="ml-1 text-muted-foreground/60">uncapped</span>
          )}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-subtle">
        {hasCap && (
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500 ease-out",
              fillClass,
            )}
            style={{ width: `${pct}%` }}
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        )}
      </div>
    </div>
  );
}
