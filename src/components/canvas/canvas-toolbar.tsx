"use client";
import { useEffect, useMemo, useRef } from "react";
import {
  MousePointer2,
  Hand,
  Square,
  Circle,
  ArrowRight,
  Minus,
  Type,
  Pen,
  Eraser,
  Combine,
  Ungroup,
  Spline,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type ToolKind =
  | "select"
  | "pan"
  | "connect"
  | "box"
  | "ellipse"
  | "arrow"
  | "line"
  | "text"
  | "freehand"
  | "eraser";

export type StyleState = {
  stroke: string;
  fill: string;
  strokeWidth: number;
};

export const DEFAULT_STYLE_STATE: StyleState = {
  stroke: "hsl(var(--foreground))",
  fill: "transparent",
  strokeWidth: 1.5,
};

const TOOLBAR_STORAGE_PREFIX = "forge.canvas.toolbar.style.";

const TOOLS: Array<{
  kind: ToolKind;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { kind: "select", label: "Select (V)", Icon: MousePointer2 },
  { kind: "pan", label: "Pan (H)", Icon: Hand },
  { kind: "connect", label: "Connect (C)", Icon: Spline },
  { kind: "box", label: "Box (R)", Icon: Square },
  { kind: "ellipse", label: "Ellipse (O)", Icon: Circle },
  { kind: "arrow", label: "Arrow (A)", Icon: ArrowRight },
  { kind: "line", label: "Line (L)", Icon: Minus },
  { kind: "text", label: "Text (T)", Icon: Type },
  { kind: "freehand", label: "Pen (P)", Icon: Pen },
  { kind: "eraser", label: "Eraser (E)", Icon: Eraser },
];

// Warm-earthy stroke presets. First swatch follows the foreground token so
// the default ink follows light/dark theme without hex values bleeding in.
const STROKE_SWATCHES: Array<{ key: string; value: string; label: string }> = [
  { key: "foreground", value: "hsl(var(--foreground))", label: "Ink" },
  { key: "muted", value: "hsl(var(--muted-foreground))", label: "Muted" },
  { key: "ember", value: "hsl(var(--ember))", label: "Ember" },
  { key: "success", value: "hsl(var(--success))", label: "Sage" },
  { key: "warning", value: "hsl(var(--warning))", label: "Ochre" },
  { key: "danger", value: "hsl(var(--danger))", label: "Rust" },
];

const STROKE_WIDTHS = [1, 2, 4];

type CanvasToolbarProps = {
  activeTool: ToolKind;
  onSelectTool: (t: ToolKind) => void;
  style: StyleState;
  onChangeStyle: (patch: Partial<StyleState>) => void;
  onGroup: () => void;
  onUngroup: () => void;
  canGroup: boolean;
  canUngroup: boolean;
  /** Persistence scope — slug or canvas id; namespaces localStorage. */
  persistKey?: string;
};

/**
 * Floating bottom-center toolbar. Lives at the page level (NOT in the
 * transformed surface) so pan/zoom doesn't move it. Persists the chosen
 * style + last tool per `persistKey` in localStorage.
 */
export function CanvasToolbar({
  activeTool,
  onSelectTool,
  style,
  onChangeStyle,
  onGroup,
  onUngroup,
  canGroup,
  canUngroup,
  persistKey,
}: CanvasToolbarProps) {
  const storageKey = useMemo(
    () => (persistKey ? `${TOOLBAR_STORAGE_PREFIX}${persistKey}` : null),
    [persistKey],
  );

  // Restore once on mount — pushing style upward avoids a double-write loop.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!storageKey || hydratedRef.current) return;
    hydratedRef.current = true;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<StyleState>;
      const next: Partial<StyleState> = {};
      if (typeof parsed.stroke === "string") next.stroke = parsed.stroke;
      if (typeof parsed.fill === "string") next.fill = parsed.fill;
      if (typeof parsed.strokeWidth === "number") next.strokeWidth = parsed.strokeWidth;
      if (Object.keys(next).length > 0) onChangeStyle(next);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(style));
    } catch {
      /* ignore quota */
    }
  }, [storageKey, style]);

  return (
    <div
      className={cn(
        "pointer-events-auto fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card/80 px-2 py-1.5 shadow-lg backdrop-blur-md",
      )}
      onMouseDown={(e) => e.stopPropagation()}
      data-canvas-toolbar
    >
      {TOOLS.map(({ kind, label, Icon }) => {
        const active = activeTool === kind;
        return (
          <button
            key={kind}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={active}
            onClick={() => onSelectTool(kind)}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors",
              active
                ? "bg-ember/15 text-ember ring-1 ring-ember/40"
                : "hover:bg-subtle hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}

      <div className="mx-1 h-6 w-px bg-border" />

      <div className="flex items-center gap-1" role="group" aria-label="Stroke color">
        {STROKE_SWATCHES.map((sw) => {
          const active = style.stroke === sw.value;
          return (
            <button
              key={sw.key}
              type="button"
              title={sw.label}
              aria-label={`Stroke ${sw.label}`}
              aria-pressed={active}
              onClick={() => onChangeStyle({ stroke: sw.value })}
              className={cn(
                "h-5 w-5 rounded-full border transition-all",
                active ? "border-foreground ring-1 ring-ember scale-110" : "border-border hover:scale-110",
              )}
              style={{ backgroundColor: sw.value }}
            />
          );
        })}
      </div>

      <div className="mx-1 h-6 w-px bg-border" />

      <div className="flex items-center gap-1" role="group" aria-label="Stroke width">
        {STROKE_WIDTHS.map((w) => {
          const active = style.strokeWidth === w;
          return (
            <button
              key={w}
              type="button"
              title={`Stroke ${w}px`}
              aria-pressed={active}
              onClick={() => onChangeStyle({ strokeWidth: w })}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                active ? "bg-subtle text-foreground" : "text-muted-foreground hover:bg-subtle hover:text-foreground",
              )}
            >
              <span
                className="block rounded-full bg-current"
                style={{ width: Math.max(4, w * 2), height: Math.max(2, w) }}
              />
            </button>
          );
        })}
      </div>

      <div className="mx-1 h-6 w-px bg-border" />

      <button
        type="button"
        title="Group selected (Cmd/Ctrl+G)"
        aria-label="Group selected"
        disabled={!canGroup}
        onClick={onGroup}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
          canGroup
            ? "text-muted-foreground hover:bg-subtle hover:text-foreground"
            : "text-muted-foreground/40",
        )}
      >
        <Combine className="h-4 w-4" />
      </button>
      <button
        type="button"
        title="Ungroup selected (Cmd/Ctrl+Shift+G)"
        aria-label="Ungroup selected"
        disabled={!canUngroup}
        onClick={onUngroup}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
          canUngroup
            ? "text-muted-foreground hover:bg-subtle hover:text-foreground"
            : "text-muted-foreground/40",
        )}
      >
        <Ungroup className="h-4 w-4" />
      </button>
    </div>
  );
}
