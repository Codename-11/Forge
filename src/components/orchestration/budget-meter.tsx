"use client";
import { cn } from "@/lib/utils";

/**
 * Canonical budget burn meter for the orchestration surfaces (Mission
 * Control Plans tab, plan cockpit, goal detail). Consolidated from two
 * parallel implementations — this one supports BOTH call shapes:
 *
 *   1. Cost/time single-bar (Mission Control row):
 *        <BudgetMeter variant="cost" value={spent} max={cap} />
 *        <BudgetMeter variant="time" value={mins} max={capMins} />
 *
 *   2. Combined cost + wall-time (goal/plan cockpit aside):
 *        <BudgetMeter spent={usd} cap={capUsd}
 *          wallTimeMinutes={capMins} elapsedMinutes={mins} />
 *
 * Fill color escalates with burn: ember under 80%, amber at 80%+,
 * danger at 100%+. The fill width animates via a CSS transition so a
 * realtime budget bump glides rather than jumps. When no cap is set we
 * render an "uncapped" track (spend shown, no fill ratio).
 *
 * Reduced motion: the width transition is a one-shot CSS ease (not a
 * keyframe loop), acceptable under reduced-motion.
 *
 * Tokens only — never hardcode colors. Amber/danger map to `--warning`
 * / `--danger` from globals.css.
 */

function fmtUsd(n: number): string {
  // Sub-dollar costs read better with cents; larger ones round to cents
  // too but the leading $ keeps it scannable in a header.
  if (n < 0.01 && n > 0) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function fmtMinutes(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function BudgetMeter(props: {
  /** ── shape 1 (Mission Control single-bar) ── */
  variant?: "cost" | "time";
  /** spent USD (cost) or elapsed minutes (time) */
  value?: number;
  /** cap, or null/undefined for uncapped */
  max?: number | null;
  /** override the leading label */
  label?: string;

  /** ── shape 2 (goal/plan cockpit combined) ── */
  spent?: number;
  cap?: number | null;
  /** `maxWallTimeMinutes` — when set, show a wall-time chip alongside. */
  wallTimeMinutes?: number | null;
  /** Minutes since `startedAt`. Only meaningful with `wallTimeMinutes`. */
  elapsedMinutes?: number | null;

  compact?: boolean;
  className?: string;
}) {
  const {
    variant = "cost",
    value,
    max,
    label,
    spent,
    cap,
    wallTimeMinutes,
    elapsedMinutes,
    compact = false,
    className,
  } = props;

  // Combined shape is in use when `spent` is passed (vs `value`).
  const combined = spent !== undefined;
  const primaryValue = combined ? (spent as number) : value ?? 0;
  const primaryCap = combined ? cap : max;

  const hasCap = typeof primaryCap === "number" && primaryCap > 0;
  const ratio = hasCap ? primaryValue / (primaryCap as number) : 0;
  const pct = Math.min(ratio * 100, 100);

  const over = hasCap && ratio >= 1;
  const warn = hasCap && ratio >= 0.8 && !over;
  const fillClass = over ? "bg-danger" : warn ? "bg-warning" : "bg-ember";
  const textTone = over
    ? "text-danger"
    : warn
      ? "text-warning"
      : "text-muted-foreground";

  // Single-bar time variant formats the primary value as minutes.
  const fmtPrimary =
    !combined && variant === "time" ? fmtMinutes : fmtUsd;
  const leadLabel =
    label ?? (!combined && variant === "time" ? "Time" : "Budget");

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-baseline justify-between gap-2 text-meta">
        <span className="uppercase tracking-wide text-muted-foreground">
          {leadLabel}
        </span>
        <span className={cn("font-mono tabular-nums", textTone)}>
          {fmtPrimary(primaryValue)}
          {hasCap ? ` / ${fmtPrimary(primaryCap as number)}` : " · uncapped"}
        </span>
      </div>
      {hasCap ? (
        <div
          className={cn(
            "flex w-full overflow-hidden rounded-full bg-subtle",
            compact ? "h-1" : "h-1.5",
          )}
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          title={`${Math.round(pct)}% of budget used`}
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500 ease-out",
              fillClass,
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
      {combined &&
      typeof wallTimeMinutes === "number" &&
      wallTimeMinutes > 0 ? (
        <div className="flex items-center justify-between gap-2 text-meta text-muted-foreground">
          <span className="uppercase tracking-wide">Wall time</span>
          <span className="font-mono tabular-nums">
            {typeof elapsedMinutes === "number"
              ? `${fmtMinutes(elapsedMinutes)} / ${fmtMinutes(wallTimeMinutes)}`
              : `cap ${fmtMinutes(wallTimeMinutes)}`}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export { fmtUsd, fmtMinutes };
