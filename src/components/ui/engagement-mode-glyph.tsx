/**
 * EngagementModeGlyph — a small icon + tone per engagement mode, in the
 * spirit of `PriorityGlyph` / `StatusDot`. One source of truth (the GLYPH /
 * TONE / MODE_LABEL / MODE_SUBTITLE maps below) reused on every surface that
 * shows a run/dispatch mode: the assign popover, the agent-run strip, the
 * Mission Control RunRow, and Settings → Dispatch Rules.
 *
 * Modes (see docs/agents/engagement-modes.md):
 *   EXECUTE  — filled / ember (the only mode that may mutate + deploy)
 *   RESEARCH — magnifier / muted
 *   REVIEW   — check-eye / warning
 *   DISCUSS  — speech / muted
 *
 * Tones come from the warm-earthy tokens (no hardcoded colors). The optional
 * <ModeChip> wrapper renders the glyph + label as a small pill for surfaces
 * that want a labelled chip rather than a bare icon.
 */
import { CircleDot, Search, ScanEye, MessageSquare } from "lucide-react";
import type { EngagementMode } from "@prisma/client";

export type EngagementModeValue = "EXECUTE" | "RESEARCH" | "REVIEW" | "DISCUSS";

const ICON: Record<EngagementModeValue, typeof CircleDot> = {
  EXECUTE: CircleDot,
  RESEARCH: Search,
  REVIEW: ScanEye,
  DISCUSS: MessageSquare,
};

const TONE: Record<EngagementModeValue, string> = {
  EXECUTE: "text-ember",
  RESEARCH: "text-muted-foreground",
  REVIEW: "text-warning",
  DISCUSS: "text-muted-foreground",
};

export const MODE_LABEL: Record<EngagementModeValue, string> = {
  EXECUTE: "Execute",
  RESEARCH: "Research",
  REVIEW: "Review",
  DISCUSS: "Discuss",
};

export const MODE_SUBTITLE: Record<EngagementModeValue, string> = {
  EXECUTE: "Take it to done",
  RESEARCH: "Investigate & report",
  REVIEW: "Critique only",
  DISCUSS: "Just weigh in",
};

/** The canonical ordering for segmented controls / pickers. */
export const MODE_ORDER: EngagementModeValue[] = [
  "EXECUTE",
  "RESEARCH",
  "REVIEW",
  "DISCUSS",
];

function norm(m: string | null | undefined): EngagementModeValue {
  const up = (m ?? "EXECUTE").toUpperCase();
  return (MODE_ORDER as string[]).includes(up)
    ? (up as EngagementModeValue)
    : "EXECUTE";
}

export function EngagementModeGlyph({
  mode,
  size = 12,
  className = "",
}: {
  mode: EngagementMode | string | null | undefined;
  size?: number;
  className?: string;
}) {
  const m = norm(mode);
  const Icon = ICON[m];
  return (
    <Icon
      size={size}
      aria-hidden
      className={`${TONE[m]} ${className}`}
      style={{ flexShrink: 0 }}
    />
  );
}

/**
 * ModeChip — glyph + label pill. Used on the agent-run strip and RunRow.
 * Kept intentionally tiny (label is an uppercase eyebrow, hardcoded small per
 * the design rules for true labels).
 */
export function ModeChip({
  mode,
  className = "",
  title,
}: {
  mode: EngagementMode | string | null | undefined;
  className?: string;
  title?: string;
}) {
  const m = norm(mode);
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-md border border-border bg-card/40 px-1.5 py-0.5 " +
        className
      }
      title={title ?? `${MODE_LABEL[m]} — ${MODE_SUBTITLE[m]}`}
    >
      <EngagementModeGlyph mode={m} size={11} />
      <span className="text-[0.625rem] uppercase tracking-wider text-muted-foreground">
        {MODE_LABEL[m]}
      </span>
    </span>
  );
}
