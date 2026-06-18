import { Fragment } from "react";
import { cn } from "@/lib/utils";

/**
 * DagStepStrip — the compact "DAG ribbon" used on plan cards and the plan
 * cockpit header: numbered step chips joined by hairline connectors, tinted by
 * status, with the RUNNING chip carrying the ember active-node glow. Mirrors
 * the Forge Screens Board planning prototype.
 *
 * Callers compute a `tones` array (one per step). Two helpers cover the common
 * cases: `toneForStepStatus` when real per-step statuses are available (plan
 * cockpit), `countBasedTones` when only a done-count + plan status is known
 * (list rows). When `total` is 0 the strip renders a "no steps yet" hint so an
 * un-decomposed plan never reads as finished.
 */

export type DagStepTone = "done" | "running" | "blocked" | "review" | "pending";

const TONE_CLASS: Record<DagStepTone, string> = {
  done: "bg-success/15 text-success",
  running: "bg-ember/15 text-ember",
  blocked: "bg-warning/15 text-warning",
  review: "bg-ember/10 text-ember",
  pending: "bg-subtle text-muted-foreground",
};

export function toneForStepStatus(status: string): DagStepTone {
  switch (status) {
    case "DONE":
      return "done";
    case "RUNNING":
      return "running";
    case "BLOCKED":
      return "blocked";
    case "REVIEW":
      return "review";
    default:
      return "pending"; // TODO, READY, CANCELED
  }
}

/** Build per-chip tones from a done-count + plan status (list rows). */
export function countBasedTones(
  total: number,
  done: number,
  planStatus: string,
): DagStepTone[] {
  return Array.from({ length: total }, (_, idx) => {
    if (idx < done) return "done";
    if (idx === done && planStatus === "RUNNING") return "running";
    if (idx === done && planStatus === "BLOCKED") return "blocked";
    return "pending";
  });
}

export function DagStepStrip({
  tones,
  done,
  total,
  max = 14,
  showLabel = true,
  className,
}: {
  tones: DagStepTone[];
  done: number;
  total: number;
  max?: number;
  showLabel?: boolean;
  className?: string;
}) {
  const shown = tones.slice(0, max);
  const overflow = tones.length - shown.length;

  return (
    <div className={cn("flex items-center gap-1", className)}>
      {shown.map((tone, idx) => {
        const isDone = tone === "done";
        return (
          <Fragment key={idx}>
            <span
              className={cn(
                "inline-flex h-5 min-w-5 items-center justify-center rounded-md px-1.5 text-[10px] font-medium tabular-nums",
                TONE_CLASS[tone],
                tone === "running" && "forge-active-node",
              )}
              title={`Step ${idx + 1}`}
            >
              {isDone ? "✓" : idx + 1}
            </span>
            {idx < shown.length - 1 ? (
              <span
                aria-hidden
                className={cn(
                  "inline-block h-px w-3",
                  isDone ? "bg-success/40" : "bg-border",
                )}
              />
            ) : null}
          </Fragment>
        );
      })}
      {overflow > 0 ? (
        <span className="ml-1 text-meta tabular-nums text-muted-foreground">
          +{overflow}
        </span>
      ) : null}
      {showLabel ? (
        total > 0 ? (
          <span className="ml-2 text-meta tabular-nums text-muted-foreground">
            {done}/{total} steps
          </span>
        ) : (
          <span className="ml-2 text-meta text-muted-foreground">
            no steps yet
          </span>
        )
      ) : null}
    </div>
  );
}
