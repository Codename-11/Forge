"use client";
import { cn } from "@/lib/utils";

/**
 * Shared orchestration UI primitives for the Goal + Plan cockpit pages.
 *
 * Kept in `orchestration-ui/` (NOT `orchestration/`, which the Mission
 * Control agent owns for the DAG view) so the two surfaces don't
 * collide at merge. These are small, dependency-free, and consume the
 * Goal/ExecutionPlan schema contract shipped by the backend agent.
 *
 * Tokens only — never hardcode colors. Amber/danger thresholds map to
 * `--warning` / `--danger` from globals.css.
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

/**
 * Horizontal budget bar. `spent` / `cap` in USD. Amber at >=80%, danger
 * at >=100%. When `cap` is null/undefined we render an "uncapped" pill
 * showing just the spend (no bar — there's no denominator).
 */
export function BudgetMeter({
  spent,
  cap,
  wallTimeMinutes,
  elapsedMinutes,
  compact = false,
  className,
}: {
  spent: number;
  cap?: number | null;
  /** `maxWallTimeMinutes` — when set, show a wall-time chip alongside. */
  wallTimeMinutes?: number | null;
  /** Minutes since `startedAt`. Only meaningful with `wallTimeMinutes`. */
  elapsedMinutes?: number | null;
  compact?: boolean;
  className?: string;
}) {
  const hasCap = typeof cap === "number" && cap > 0;
  const pct = hasCap ? Math.min((spent / cap) * 100, 100) : 0;
  const over = hasCap && spent >= cap;
  const warn = hasCap && pct >= 80 && !over;

  const barTone = over
    ? "bg-danger"
    : warn
      ? "bg-warning"
      : "bg-ember";

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center justify-between gap-2 text-meta">
        <span className="uppercase tracking-wide text-muted-foreground">
          Budget
        </span>
        <span
          className={cn(
            "font-mono tabular-nums",
            over
              ? "text-danger"
              : warn
                ? "text-warning"
                : "text-muted-foreground",
          )}
        >
          {fmtUsd(spent)}
          {hasCap ? ` / ${fmtUsd(cap)}` : " · uncapped"}
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
            className={cn("h-full transition-all duration-500 ease-out", barTone)}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
      {typeof wallTimeMinutes === "number" && wallTimeMinutes > 0 ? (
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
