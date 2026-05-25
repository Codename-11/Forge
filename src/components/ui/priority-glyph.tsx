/**
 * PriorityGlyph — `!!!`/`!!`/`!`/`·`/`—` with per-priority tone (design
 * `forge-primitives` PriorityGlyph). URGENT pops danger-red, HIGH warning,
 * the rest muted. Shared so the issues list, hover preview, and dispatch
 * matrix render priority identically.
 */

export type PriorityValue = "URGENT" | "HIGH" | "MEDIUM" | "LOW" | "NONE";

const GLYPH: Record<PriorityValue, string> = {
  URGENT: "!!!",
  HIGH: "!!",
  MEDIUM: "!",
  LOW: "·",
  NONE: "—",
};

const TONE: Record<PriorityValue, string> = {
  URGENT: "text-danger",
  HIGH: "text-warning",
  MEDIUM: "text-foreground",
  LOW: "text-muted-foreground",
  NONE: "text-muted-foreground",
};

const LABEL: Record<PriorityValue, string> = {
  URGENT: "Urgent",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
  NONE: "No priority",
};

function norm(p: string | null | undefined): PriorityValue {
  const up = (p ?? "NONE").toUpperCase();
  return (["URGENT", "HIGH", "MEDIUM", "LOW", "NONE"] as const).includes(
    up as PriorityValue,
  )
    ? (up as PriorityValue)
    : "NONE";
}

export function PriorityGlyph({
  priority,
  className = "",
}: {
  priority: string | null | undefined;
  className?: string;
}) {
  const p = norm(priority);
  return (
    <span
      className={`text-id tabular-nums ${TONE[p]} ${className}`}
      title={LABEL[p]}
      style={{ minWidth: 14, display: "inline-block", textAlign: "center" }}
    >
      {GLYPH[p]}
    </span>
  );
}
