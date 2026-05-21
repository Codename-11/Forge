"use client";
import { useEffect, useMemo, useRef } from "react";
import {
  MousePointer2,
  Hand,
  Square,
  Frame as FrameIcon,
  Circle,
  Diamond,
  ArrowRight,
  Minus,
  Type,
  Pen,
  Eraser,
  Combine,
  Ungroup,
  Spline,
  StickyNote,
  MessageCircle,
  Smile,
  SquarePlus,
  Image as ImageIcon,
  PenLine,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { STAMP_PALETTE, STICKY_PALETTE } from "@/components/canvas/canvas-shapes";

export type ToolKind =
  | "select"
  | "pan"
  | "connect"
  | "frame"
  | "box"
  | "ellipse"
  | "diamond"
  | "arrow"
  | "line"
  | "text"
  | "freehand"
  | "eraser"
  | "sticky"
  | "comment-pin"
  | "stamp"
  | "entity-create";

export type StyleState = {
  stroke: string;
  fill: string;
  strokeWidth: number;
  /** Hand-drawn (rough.js) rendering for new geometric shapes. */
  sketch?: boolean;
  /** Active sticky palette key (one of STICKY_PALETTE[].key). Drives
   * both the toolbar swatch and the `style.fill` field on the next
   * sticky created via the sticky tool. */
  stickyPalette?: string;
  /** Active stamp emoji (one of STAMP_PALETTE). Drives the
   * `style.emoji` field on the next stamp dropped via the stamp tool. */
  stampEmoji?: string;
};

export const DEFAULT_STYLE_STATE: StyleState = {
  stroke: "hsl(var(--foreground))",
  fill: "transparent",
  strokeWidth: 1.5,
  sketch: false,
  stickyPalette: STICKY_PALETTE[0].key,
  stampEmoji: STAMP_PALETTE[0],
};

// Fill swatches mirror the stroke palette but lead with a "none" option
// (transparent) which is the default for outline shapes.
const FILL_SWATCHES: Array<{ key: string; value: string; label: string }> = [
  { key: "none", value: "transparent", label: "No fill" },
  { key: "ember", value: "hsl(var(--ember) / 0.18)", label: "Ember" },
  { key: "success", value: "hsl(var(--success) / 0.18)", label: "Sage" },
  { key: "warning", value: "hsl(var(--warning) / 0.18)", label: "Ochre" },
  { key: "muted", value: "hsl(var(--muted-foreground) / 0.18)", label: "Muted" },
];

const TOOLBAR_STORAGE_PREFIX = "forge.canvas.toolbar.style.";

const TOOLS: Array<{
  kind: ToolKind;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { kind: "select", label: "Select (V)", Icon: MousePointer2 },
  { kind: "pan", label: "Pan (H)", Icon: Hand },
  { kind: "connect", label: "Connect (C)", Icon: Spline },
  { kind: "frame", label: "Frame (F)", Icon: FrameIcon },
  { kind: "box", label: "Box (R)", Icon: Square },
  { kind: "ellipse", label: "Ellipse (O)", Icon: Circle },
  { kind: "diamond", label: "Diamond (D)", Icon: Diamond },
  { kind: "arrow", label: "Arrow (A)", Icon: ArrowRight },
  { kind: "line", label: "Line (L)", Icon: Minus },
  { kind: "text", label: "Text (T)", Icon: Type },
  { kind: "freehand", label: "Pen (P)", Icon: Pen },
  { kind: "sticky", label: "Sticky (S)", Icon: StickyNote },
  { kind: "comment-pin", label: "Comment pin (M)", Icon: MessageCircle },
  { kind: "stamp", label: "Stamp (Y)", Icon: Smile },
  { kind: "entity-create", label: "Create here (I)", Icon: SquarePlus },
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
  /** W2.1: sticky-lock state. When true, draw tools don't auto-return
   *  to Select after one commit. Shift-click any tool toggles. */
  stickyLocked?: boolean;
  onToggleStickyLock?: () => void;
  /** Open a file picker to insert an image shape. */
  onInsertImage?: () => void;
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
  stickyLocked = false,
  onToggleStickyLock,
  onInsertImage,
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
      if (typeof parsed.sketch === "boolean") next.sketch = parsed.sketch;
      if (
        typeof parsed.stickyPalette === "string" &&
        STICKY_PALETTE.some((p) => p.key === parsed.stickyPalette)
      ) {
        next.stickyPalette = parsed.stickyPalette;
      }
      if (
        typeof parsed.stampEmoji === "string" &&
        STAMP_PALETTE.includes(parsed.stampEmoji)
      ) {
        next.stampEmoji = parsed.stampEmoji;
      }
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
        "pointer-events-auto fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-2",
      )}
      onMouseDown={(e) => e.stopPropagation()}
      data-canvas-toolbar
    >
      {/* Tool-specific palette popovers — render above the toolbar.
       * Only one ever shows because the active tool is exclusive. */}
      {activeTool === "sticky" ? (
        <StickyPalettePopover
          activeKey={style.stickyPalette ?? STICKY_PALETTE[0].key}
          onPick={(key) => onChangeStyle({ stickyPalette: key })}
        />
      ) : null}
      {activeTool === "stamp" ? (
        <StampPalettePopover
          activeEmoji={style.stampEmoji ?? STAMP_PALETTE[0]}
          onPick={(emoji) => onChangeStyle({ stampEmoji: emoji })}
        />
      ) : null}

      <div
        className={cn(
          "flex items-center gap-1 rounded-full border border-border bg-card/80 px-2 py-1.5 shadow-lg backdrop-blur-md",
        )}
      >
        {TOOLS.map(({ kind, label, Icon }) => {
          const active = activeTool === kind;
          return (
            <button
              key={kind}
              type="button"
              title={
                label +
                (active && stickyLocked
                  ? " · locked sticky (Shift+click to unlock)"
                  : active
                  ? " · Shift+click to lock"
                  : "")
              }
              aria-label={label}
              aria-pressed={active}
              onClick={(e) => {
                if (e.shiftKey && onToggleStickyLock) {
                  onToggleStickyLock();
                  return;
                }
                onSelectTool(kind);
              }}
              className={cn(
                "relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors",
                active
                  ? "bg-ember/15 text-ember ring-1 ring-ember/40"
                  : "hover:bg-subtle hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {active && stickyLocked && (
                <span
                  aria-hidden
                  className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-ember"
                />
              )}
            </button>
          );
        })}

        {onInsertImage ? (
          <button
            type="button"
            title="Insert image (paste or drop also works)"
            aria-label="Insert image"
            onClick={onInsertImage}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground"
          >
            <ImageIcon className="h-4 w-4" />
          </button>
        ) : null}

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

        <div className="flex items-center gap-1" role="group" aria-label="Fill color">
          {FILL_SWATCHES.map((sw) => {
            const active = style.fill === sw.value;
            return (
              <button
                key={sw.key}
                type="button"
                title={`Fill: ${sw.label}`}
                aria-label={`Fill ${sw.label}`}
                aria-pressed={active}
                onClick={() => onChangeStyle({ fill: sw.value })}
                className={cn(
                  "h-5 w-5 rounded-md border transition-all",
                  active ? "border-foreground ring-1 ring-ember scale-110" : "border-border hover:scale-110",
                  sw.key === "none" ? "bg-card" : "",
                )}
                style={sw.key === "none" ? undefined : { backgroundColor: sw.value }}
              >
                {sw.key === "none" ? (
                  <span className="block h-full w-full rotate-45">
                    <span className="mx-auto block h-full w-px bg-danger" />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="mx-1 h-6 w-px bg-border" />

        <button
          type="button"
          title="Hand-drawn (sketch) style"
          aria-label="Toggle hand-drawn style"
          aria-pressed={Boolean(style.sketch)}
          onClick={() => onChangeStyle({ sketch: !style.sketch })}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
            style.sketch
              ? "bg-ember/15 text-ember ring-1 ring-ember/40"
              : "text-muted-foreground hover:bg-subtle hover:text-foreground",
          )}
        >
          <PenLine className="h-4 w-4" />
        </button>

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
    </div>
  );
}

function StickyPalettePopover({
  activeKey,
  onPick,
}: {
  activeKey: string;
  onPick: (key: string) => void;
}) {
  return (
    <div
      className="flex items-center gap-1 rounded-full border border-border bg-card/80 px-2 py-1.5 shadow-lg backdrop-blur-md"
      role="group"
      aria-label="Sticky note color"
    >
      {STICKY_PALETTE.map((sw) => {
        const active = activeKey === sw.key;
        return (
          <button
            key={sw.key}
            type="button"
            title={sw.label}
            aria-label={`Sticky ${sw.label}`}
            aria-pressed={active}
            onClick={() => onPick(sw.key)}
            className={cn(
              "h-5 w-5 rounded-md border transition-all",
              active
                ? "border-foreground ring-1 ring-ember scale-110"
                : "border-border hover:scale-110",
            )}
            style={{ background: `hsl(var(${sw.cssVar}))` }}
          />
        );
      })}
    </div>
  );
}

function StampPalettePopover({
  activeEmoji,
  onPick,
}: {
  activeEmoji: string;
  onPick: (emoji: string) => void;
}) {
  return (
    <div
      className="flex items-center gap-1 rounded-full border border-border bg-card/80 px-2 py-1.5 shadow-lg backdrop-blur-md"
      role="group"
      aria-label="Stamp emoji"
    >
      {STAMP_PALETTE.map((emoji) => {
        const active = activeEmoji === emoji;
        return (
          <button
            key={emoji}
            type="button"
            title={`Stamp ${emoji}`}
            aria-label={`Stamp ${emoji}`}
            aria-pressed={active}
            onClick={() => onPick(emoji)}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md text-lg leading-none transition-colors",
              active
                ? "bg-ember/15 ring-1 ring-ember/40"
                : "hover:bg-subtle",
            )}
            style={{ userSelect: "none" }}
          >
            {emoji}
          </button>
        );
      })}
    </div>
  );
}
