/**
 * WorkItemKindGlyph — a small icon + tone per work-item kind, in the spirit
 * of `PriorityGlyph` / `StatusDot` / `EngagementModeGlyph`. One source of
 * truth (the ICON / TONE / KIND_LABEL maps below) reused wherever a kind is
 * shown: the issue type picker, list rows, the sub-issues panel, and the
 * relations DAG.
 *
 * Kinds (see CLAUDE.md "Primitives"):
 *   EPIC — a parent issue whose children are its scope (ember, layers icon)
 *   ISSUE — the default unit of work
 *   TASK — a sub-task / child checklist item (surfaced as "Sub-task")
 *
 * Tones come from the warm-earthy tokens (no hardcoded colors).
 */
import { Layers, CircleDot, CheckSquare } from "lucide-react";
import type { WorkItemKind } from "@prisma/client";

export type WorkItemKindValue = "EPIC" | "ISSUE" | "TASK";

const ICON: Record<WorkItemKindValue, typeof Layers> = {
  EPIC: Layers,
  ISSUE: CircleDot,
  TASK: CheckSquare,
};

const TONE: Record<WorkItemKindValue, string> = {
  EPIC: "text-ember",
  ISSUE: "text-muted-foreground",
  TASK: "text-muted-foreground",
};

export const KIND_LABEL: Record<WorkItemKindValue, string> = {
  EPIC: "Epic",
  ISSUE: "Issue",
  TASK: "Sub-task",
};

export const KIND_SUBTITLE: Record<WorkItemKindValue, string> = {
  EPIC: "A parent that groups child issues",
  ISSUE: "The standard unit of work",
  TASK: "A sub-task under a parent issue",
};

/** Canonical ordering for pickers / segmented controls. */
export const KIND_ORDER: WorkItemKindValue[] = ["EPIC", "ISSUE", "TASK"];

export function normKind(k: string | null | undefined): WorkItemKindValue {
  const up = (k ?? "ISSUE").toUpperCase();
  return (KIND_ORDER as string[]).includes(up)
    ? (up as WorkItemKindValue)
    : "ISSUE";
}

export function WorkItemKindGlyph({
  kind,
  size = 12,
  className = "",
}: {
  kind: WorkItemKind | string | null | undefined;
  size?: number;
  className?: string;
}) {
  const k = normKind(kind);
  const Icon = ICON[k];
  return (
    <Icon
      size={size}
      aria-hidden
      className={`${TONE[k]} ${className}`}
      style={{ flexShrink: 0 }}
    />
  );
}

/**
 * KindChip — glyph + label pill. Epics get a faint ember tint so they
 * read as the structural parent; issue/sub-task stay quiet.
 */
export function KindChip({
  kind,
  className = "",
  title,
}: {
  kind: WorkItemKind | string | null | undefined;
  className?: string;
  title?: string;
}) {
  const k = normKind(kind);
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 " +
        (k === "EPIC"
          ? "border-ember/30 bg-ember/10"
          : "border-border bg-card/40") +
        " " +
        className
      }
      title={title ?? `${KIND_LABEL[k]} — ${KIND_SUBTITLE[k]}`}
    >
      <WorkItemKindGlyph kind={k} size={11} />
      <span
        className={
          "text-[0.625rem] uppercase tracking-wider " +
          (k === "EPIC" ? "text-ember" : "text-muted-foreground")
        }
      >
        {KIND_LABEL[k]}
      </span>
    </span>
  );
}
