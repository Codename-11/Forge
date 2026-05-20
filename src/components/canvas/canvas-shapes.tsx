"use client";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { ChatMarkdown } from "@/components/mission-control/chat-markdown";

export type ShapeKind =
  | "box"
  | "ellipse"
  | "line"
  | "arrow"
  | "text"
  | "freehand"
  | "sticky"
  | "comment-pin"
  | "stamp";

/** Sticky-note palette — keys map to `--sticky-*` CSS vars in
 * globals.css. Order matters: index 0 is the "default" swatch new
 * stickies use when no palette key is supplied. */
export const STICKY_PALETTE: ReadonlyArray<{ key: string; label: string; cssVar: string }> = [
  { key: "sand", label: "Sand", cssVar: "--sticky-sand" },
  { key: "blush", label: "Blush", cssVar: "--sticky-blush" },
  { key: "sage", label: "Sage", cssVar: "--sticky-sage" },
  { key: "sky", label: "Sky", cssVar: "--sticky-sky" },
  { key: "lavender", label: "Lavender", cssVar: "--sticky-lavender" },
  { key: "peach", label: "Peach", cssVar: "--sticky-peach" },
];

const STICKY_PALETTE_KEYS = new Set(STICKY_PALETTE.map((p) => p.key));

/** Stamp emoji palette — fixed 8-glyph set so we can validate at the
 * router boundary. */
export const STAMP_PALETTE: ReadonlyArray<string> = [
  "👍",
  "👎",
  "⭐",
  "🔥",
  "❤️",
  "💡",
  "⚠️",
  "🎯",
];

const STAMP_PALETTE_SET = new Set(STAMP_PALETTE);

export function isStickyPaletteKey(key: unknown): key is string {
  return typeof key === "string" && STICKY_PALETTE_KEYS.has(key);
}

export function isStampEmoji(value: unknown): value is string {
  return typeof value === "string" && STAMP_PALETTE_SET.has(value);
}

function stickyCssVarForKey(key: string | undefined): string {
  const entry = STICKY_PALETTE.find((p) => p.key === key) ?? STICKY_PALETTE[0];
  return entry.cssVar;
}

export type CanvasShapeRow = {
  id: string;
  canvasId: string;
  kind: ShapeKind;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  path: Array<[number, number]> | null;
  style: Record<string, unknown> | null;
  text: string | null;
  zIndex: number;
  groupId: string | null;
  /** Set when the shape is hidden via the layers panel. Filtered out
   * by the renderer so it never paints. */
  hiddenAt?: Date | string | null;
  /** Set when the shape is locked from edits. The renderer still
   * paints but blocks the inline editor + selection-drag gestures. */
  lockedAt?: Date | string | null;
};

type ShapeStyle = {
  stroke: string;
  fill: string;
  strokeWidth: number;
  dasharray?: string;
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  opacity?: number;
};

function readStyle(raw: Record<string, unknown> | null | undefined): ShapeStyle {
  const s = raw ?? {};
  return {
    stroke: typeof s.stroke === "string" ? (s.stroke as string) : "currentColor",
    fill: typeof s.fill === "string" ? (s.fill as string) : "transparent",
    strokeWidth: typeof s.strokeWidth === "number" ? (s.strokeWidth as number) : 1.5,
    dasharray: typeof s.dasharray === "string" ? (s.dasharray as string) : undefined,
    fontSize: typeof s.fontSize === "number" ? (s.fontSize as number) : undefined,
    fontWeight: typeof s.fontWeight === "number" ? (s.fontWeight as number) : undefined,
    color: typeof s.color === "string" ? (s.color as string) : undefined,
    opacity: typeof s.opacity === "number" ? (s.opacity as number) : undefined,
  };
}

// Catmull-Rom -> Bezier so freehand stays smooth without re-sampling.
function smoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const [x, y] = points[0];
    return `M ${x},${y}`;
  }
  if (points.length === 2) {
    const [x0, y0] = points[0];
    const [x1, y1] = points[1];
    return `M ${x0},${y0} L ${x1},${y1}`;
  }
  let d = `M ${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

function shapeBoundingBox(shape: CanvasShapeRow): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (shape.kind === "box" || shape.kind === "ellipse" || shape.kind === "text") {
    return {
      x: shape.x,
      y: shape.y,
      width: shape.width ?? 1,
      height: shape.height ?? 1,
    };
  }
  if (shape.kind === "sticky") {
    return {
      x: shape.x,
      y: shape.y,
      width: shape.width ?? 200,
      height: shape.height ?? 120,
    };
  }
  if (shape.kind === "comment-pin") {
    return {
      x: shape.x,
      y: shape.y,
      width: shape.width ?? 24,
      height: shape.height ?? 24,
    };
  }
  if (shape.kind === "stamp") {
    return {
      x: shape.x,
      y: shape.y,
      width: shape.width ?? 48,
      height: shape.height ?? 48,
    };
  }
  if (shape.kind === "line" || shape.kind === "arrow") {
    let endDx = shape.width ?? 0;
    let endDy = shape.height ?? 0;
    if (Array.isArray(shape.path) && shape.path.length > 0) {
      const last = shape.path[shape.path.length - 1];
      endDx = last[0];
      endDy = last[1];
    }
    const minDx = Math.min(0, endDx);
    const minDy = Math.min(0, endDy);
    return {
      x: shape.x + minDx,
      y: shape.y + minDy,
      width: Math.abs(endDx) || 1,
      height: Math.abs(endDy) || 1,
    };
  }
  // freehand
  if (Array.isArray(shape.path) && shape.path.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [dx, dy] of shape.path) {
      if (dx < minX) minX = dx;
      if (dy < minY) minY = dy;
      if (dx > maxX) maxX = dx;
      if (dy > maxY) maxY = dy;
    }
    return {
      x: shape.x + minX,
      y: shape.y + minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }
  return { x: shape.x, y: shape.y, width: 1, height: 1 };
}

type CanvasShapesProps = {
  shapes: CanvasShapeRow[];
  selectedIds: Set<string>;
  onSelectShape: (id: string, event: React.MouseEvent) => void;
  /** When set, the matching text-shape renders an inline `<textarea>`
   * instead of the read-only markdown view, with focus + autoselect on
   * mount. Used immediately after creating a text shape, and on
   * double-click of an existing one. */
  editingShapeId?: string | null;
  /** Called when the inline editor commits (blur / Enter). The parent
   * persists via `canvas.shapePatch`. */
  onTextShapeSave?: (id: string, text: string) => void;
  /** Called when the inline editor closes without committing (Esc) or
   * after a successful save — parent clears `editingShapeId`. */
  onTextShapeEditEnd?: () => void;
  /** Called when a text shape is double-clicked — parent sets
   * `editingShapeId` to enter inline edit mode. */
  onTextShapeEditStart?: (id: string) => void;
};

/**
 * Pure SVG renderer for canvas drawing primitives. Mounts INSIDE the
 * transformed pan/zoom surface so its coords are canvas-space. Shapes
 * are pointer-evented; the parent surface keeps pan/zoom for empty
 * areas.
 */
export const CanvasShapes = memo(function CanvasShapes({
  shapes,
  selectedIds,
  onSelectShape,
  editingShapeId,
  onTextShapeSave,
  onTextShapeEditEnd,
  onTextShapeEditStart,
}: CanvasShapesProps) {
  // Hidden shapes never paint. Locked shapes still render but the
  // per-kind branches disable inline edit / double-click gestures.
  const visibleShapes = useMemo(
    () => shapes.filter((s) => !s.hiddenAt),
    [shapes],
  );
  const bbox = useMemo(() => {
    if (visibleShapes.length === 0) {
      return { left: 0, top: 0, width: 1, height: 1 };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of visibleShapes) {
      const b = shapeBoundingBox(s);
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.width > maxX) maxX = b.x + b.width;
      if (b.y + b.height > maxY) maxY = b.y + b.height;
    }
    const margin = 80;
    return {
      left: Math.floor(minX - margin),
      top: Math.floor(minY - margin),
      width: Math.ceil(maxX - minX + margin * 2),
      height: Math.ceil(maxY - minY + margin * 2),
    };
  }, [visibleShapes]);

  // Local popover state for comment pins. Cleared when the user
  // clicks any other pin or presses Esc on the popover.
  const [openCommentPinId, setOpenCommentPinId] = useState<string | null>(null);

  if (visibleShapes.length === 0) return null;
  const { left, top, width, height } = bbox;

  return (
    <svg
      className="absolute text-foreground/60"
      style={{ left, top, width, height, overflow: "visible" }}
      width={width}
      height={height}
    >
      <defs>
        <marker
          id="canvas-shape-arrow"
          viewBox="0 -5 10 10"
          refX="9"
          refY="0"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,-4 L8,0 L0,4 Z" fill="currentColor" />
        </marker>
      </defs>
      {visibleShapes.map((shape) => (
        <ShapeNode
          key={shape.id}
          shape={shape}
          selected={selectedIds.has(shape.id)}
          offsetX={left}
          offsetY={top}
          onSelectShape={onSelectShape}
          editing={editingShapeId === shape.id}
          onTextShapeSave={onTextShapeSave}
          onTextShapeEditEnd={onTextShapeEditEnd}
          onTextShapeEditStart={onTextShapeEditStart}
          commentPinOpen={openCommentPinId === shape.id}
          onCommentPinToggle={(id) =>
            setOpenCommentPinId((cur) => (cur === id ? null : id))
          }
          onCommentPinClose={() => setOpenCommentPinId(null)}
        />
      ))}
    </svg>
  );
});

type ShapeNodeProps = {
  shape: CanvasShapeRow;
  selected: boolean;
  offsetX: number;
  offsetY: number;
  onSelectShape: (id: string, event: React.MouseEvent) => void;
  editing?: boolean;
  onTextShapeSave?: (id: string, text: string) => void;
  onTextShapeEditEnd?: () => void;
  onTextShapeEditStart?: (id: string) => void;
  /** True when this comment-pin's placeholder popover should render. */
  commentPinOpen?: boolean;
  /** Click-handler for comment pins; the parent owns which pin is open. */
  onCommentPinToggle?: (id: string) => void;
  /** Close the comment pin popover (called from the popover's
   * Close button or backdrop). */
  onCommentPinClose?: () => void;
};

const ShapeNode = memo(function ShapeNode({
  shape,
  selected,
  offsetX,
  offsetY,
  onSelectShape,
  editing = false,
  onTextShapeSave,
  onTextShapeEditEnd,
  onTextShapeEditStart,
  commentPinOpen = false,
  onCommentPinToggle,
  onCommentPinClose,
}: ShapeNodeProps) {
  const style = readStyle(shape.style);
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelectShape(shape.id, e);
  };
  const ringClass = selected ? "text-ember" : "";

  let content: React.ReactNode = null;
  let ring: React.ReactNode = null;

  if (shape.kind === "box") {
    const w = shape.width ?? 80;
    const h = shape.height ?? 80;
    const x = shape.x - offsetX;
    const y = shape.y - offsetY;
    content = (
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
        ry={6}
        fill={style.fill}
        stroke={style.stroke}
        strokeWidth={style.strokeWidth}
        strokeDasharray={style.dasharray}
        opacity={style.opacity ?? 1}
        className="cursor-pointer"
        pointerEvents="all"
        onMouseDown={onMouseDown}
        data-canvas-shape={shape.id}
      />
    );
    if (selected) {
      ring = (
        <rect
          x={x - 3}
          y={y - 3}
          width={w + 6}
          height={h + 6}
          rx={8}
          ry={8}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          pointerEvents="none"
        />
      );
    }
  } else if (shape.kind === "ellipse") {
    const w = shape.width ?? 80;
    const h = shape.height ?? 80;
    const cx = shape.x - offsetX + w / 2;
    const cy = shape.y - offsetY + h / 2;
    content = (
      <ellipse
        cx={cx}
        cy={cy}
        rx={Math.max(1, w / 2)}
        ry={Math.max(1, h / 2)}
        fill={style.fill}
        stroke={style.stroke}
        strokeWidth={style.strokeWidth}
        strokeDasharray={style.dasharray}
        opacity={style.opacity ?? 1}
        className="cursor-pointer"
        pointerEvents="all"
        onMouseDown={onMouseDown}
        data-canvas-shape={shape.id}
      />
    );
    if (selected) {
      ring = (
        <ellipse
          cx={cx}
          cy={cy}
          rx={Math.max(1, w / 2) + 3}
          ry={Math.max(1, h / 2) + 3}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          pointerEvents="none"
        />
      );
    }
  } else if (shape.kind === "line" || shape.kind === "arrow") {
    let endDx = shape.width ?? 0;
    let endDy = shape.height ?? 0;
    if (Array.isArray(shape.path) && shape.path.length > 0) {
      const last = shape.path[shape.path.length - 1];
      endDx = last[0];
      endDy = last[1];
    }
    const x1 = shape.x - offsetX;
    const y1 = shape.y - offsetY;
    const x2 = x1 + endDx;
    const y2 = y1 + endDy;
    content = (
      <g>
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="transparent"
          strokeWidth={Math.max(10, style.strokeWidth + 8)}
          pointerEvents="stroke"
          onMouseDown={onMouseDown}
          data-canvas-shape={shape.id}
          className="cursor-pointer"
        />
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={style.stroke}
          strokeWidth={style.strokeWidth}
          strokeDasharray={style.dasharray}
          opacity={style.opacity ?? 1}
          markerEnd={shape.kind === "arrow" ? "url(#canvas-shape-arrow)" : undefined}
          pointerEvents="none"
        />
      </g>
    );
    if (selected) {
      const minX = Math.min(x1, x2) - 4;
      const minY = Math.min(y1, y2) - 4;
      const w = Math.abs(x2 - x1) + 8;
      const h = Math.abs(y2 - y1) + 8;
      ring = (
        <rect
          x={minX}
          y={minY}
          width={Math.max(w, 8)}
          height={Math.max(h, 8)}
          rx={4}
          ry={4}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          pointerEvents="none"
        />
      );
    }
  } else if (shape.kind === "text") {
    const w = shape.width ?? 200;
    const h = shape.height ?? 60;
    const x = shape.x - offsetX;
    const y = shape.y - offsetY;
    const fontSize = style.fontSize ?? 14;
    const fontWeight = style.fontWeight ?? 400;
    const color = style.color ?? "hsl(var(--foreground))";
    content = (
      <foreignObject
        x={x}
        y={y}
        width={w}
        height={h}
        pointerEvents="all"
        // Pointerdown selects only when NOT editing — otherwise the
        // click inside the textarea is forwarded as a selection
        // gesture and steals focus.
        onMouseDown={editing ? undefined : onMouseDown}
        onDoubleClick={(e) => {
          if (editing) return;
          e.stopPropagation();
          onTextShapeEditStart?.(shape.id);
        }}
        data-canvas-shape={shape.id}
        className={editing ? "" : "cursor-pointer"}
      >
        {editing ? (
          <TextShapeEditor
            initial={shape.text ?? ""}
            fontSize={fontSize}
            fontWeight={fontWeight}
            color={color}
            onCommit={(next) => {
              onTextShapeSave?.(shape.id, next);
              onTextShapeEditEnd?.();
            }}
            onCancel={() => onTextShapeEditEnd?.()}
          />
        ) : (
          <div
            style={{
              fontSize,
              fontWeight,
              color,
              width: "100%",
              height: "100%",
              opacity: style.opacity ?? 1,
              lineHeight: 1.35,
              wordBreak: "break-word",
              overflow: "hidden",
            }}
          >
            {shape.text && shape.text !== "Text" ? (
              <ChatMarkdown body={shape.text} />
            ) : (
              <span className="text-muted-foreground italic">Double-click to edit</span>
            )}
          </div>
        )}
      </foreignObject>
    );
    if (selected) {
      ring = (
        <rect
          x={x - 3}
          y={y - 3}
          width={w + 6}
          height={h + 6}
          rx={6}
          ry={6}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          pointerEvents="none"
        />
      );
    }
  } else if (shape.kind === "sticky") {
    const w = shape.width ?? 200;
    const h = shape.height ?? 120;
    const x = shape.x - offsetX;
    const y = shape.y - offsetY;
    const paletteKey =
      typeof (shape.style as Record<string, unknown> | null | undefined)?.fill === "string"
        ? ((shape.style as Record<string, unknown>).fill as string)
        : undefined;
    const cssVar = stickyCssVarForKey(
      isStickyPaletteKey(paletteKey) ? (paletteKey as string) : undefined,
    );
    const fontSize = style.fontSize ?? 14;
    const locked = !!shape.lockedAt;
    content = (
      <foreignObject
        x={x}
        y={y}
        width={w}
        height={h}
        pointerEvents="all"
        onMouseDown={editing ? undefined : onMouseDown}
        onDoubleClick={(e) => {
          if (editing || locked) return;
          e.stopPropagation();
          onTextShapeEditStart?.(shape.id);
        }}
        data-canvas-shape={shape.id}
        data-shape-kind="sticky"
        className={editing ? "" : "cursor-pointer"}
      >
        <div
          className="h-full w-full rounded-md shadow-md text-foreground"
          style={{
            background: `hsl(var(${cssVar}))`,
            opacity: style.opacity ?? 1,
            padding: 12,
            overflow: "hidden",
          }}
        >
          {editing && !locked ? (
            <TextShapeEditor
              initial={shape.text ?? ""}
              fontSize={fontSize}
              fontWeight={style.fontWeight ?? 400}
              color="hsl(var(--foreground))"
              onCommit={(next) => {
                onTextShapeSave?.(shape.id, next);
                onTextShapeEditEnd?.();
              }}
              onCancel={() => onTextShapeEditEnd?.()}
            />
          ) : (
            <div
              className="text-sm"
              style={{
                fontSize,
                lineHeight: 1.35,
                wordBreak: "break-word",
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {shape.text && shape.text !== "Sticky" ? (
                shape.text
              ) : (
                <span className="italic opacity-60">Double-click to edit</span>
              )}
            </div>
          )}
        </div>
      </foreignObject>
    );
    if (selected) {
      ring = (
        <rect
          x={x - 2}
          y={y - 2}
          width={w + 4}
          height={h + 4}
          rx={8}
          ry={8}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          pointerEvents="none"
        />
      );
    }
  } else if (shape.kind === "comment-pin") {
    const w = shape.width ?? 24;
    const h = shape.height ?? 24;
    const x = shape.x - offsetX;
    const y = shape.y - offsetY;
    const rawUnread = (shape.style as Record<string, unknown> | null | undefined)?.unread;
    const unread = typeof rawUnread === "number" ? rawUnread : 0;
    // Popover footprint extends below the pin; expand the foreignObject
    // bbox so the popover doesn't clip against its parent SVG.
    const fX = x;
    const fY = y;
    const fW = Math.max(w, 220);
    const fH = commentPinOpen ? h + 130 : h;
    content = (
      <foreignObject
        x={fX}
        y={fY}
        width={fW}
        height={fH}
        // Default to none so the surrounding canvas can still receive
        // empty-area clicks; the inner button + popover opt back in.
        pointerEvents="none"
        data-canvas-shape={shape.id}
        data-shape-kind="comment-pin"
      >
        <div className="relative" style={{ width: fW, height: fH }}>
          <button
            type="button"
            aria-label="Open comment thread"
            className="absolute left-0 top-0 flex items-center justify-center rounded-full text-ember-foreground shadow-md transition-transform hover:scale-105"
            style={{
              width: w,
              height: h,
              background: "hsl(var(--ember))",
              pointerEvents: "auto",
            }}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              onSelectShape(shape.id, e);
            }}
            onClick={(e) => {
              e.stopPropagation();
              onCommentPinToggle?.(shape.id);
            }}
          >
            <MessageCircle size={14} />
            {unread > 0 ? (
              <span
                className="absolute -right-1 -top-1 flex h-3 min-w-3 items-center justify-center rounded-full px-1 text-[9px] font-medium text-ember-foreground"
                style={{ background: "hsl(var(--danger))" }}
              >
                {unread > 9 ? "9+" : unread}
              </span>
            ) : null}
          </button>
          {commentPinOpen ? (
            <div
              className="absolute left-0 rounded-md border border-border bg-popover p-3 text-xs shadow-lg"
              style={{
                top: h + 6,
                width: 220,
                pointerEvents: "auto",
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-1 font-medium text-foreground">Comments</div>
              <div className="text-muted-foreground">
                Threads land in Wave 2. The pin is anchored — comments
                will hang off this shape id.
              </div>
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-subtle hover:text-foreground"
                  onClick={() => onCommentPinClose?.()}
                >
                  Close
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </foreignObject>
    );
    if (selected) {
      ring = (
        <circle
          cx={x + w / 2}
          cy={y + h / 2}
          r={w / 2 + 3}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          pointerEvents="none"
        />
      );
    }
  } else if (shape.kind === "stamp") {
    const w = shape.width ?? 48;
    const h = shape.height ?? 48;
    const x = shape.x - offsetX;
    const y = shape.y - offsetY;
    const rawEmoji = (shape.style as Record<string, unknown> | null | undefined)?.emoji;
    const emoji = isStampEmoji(rawEmoji) ? (rawEmoji as string) : STAMP_PALETTE[0];
    content = (
      <foreignObject
        x={x}
        y={y}
        width={w}
        height={h}
        pointerEvents="all"
        onMouseDown={onMouseDown}
        data-canvas-shape={shape.id}
        data-shape-kind="stamp"
        className="cursor-pointer"
      >
        <div
          className="flex h-full w-full items-center justify-center leading-none"
          style={{ fontSize: 36, opacity: style.opacity ?? 1, userSelect: "none" }}
        >
          {emoji}
        </div>
      </foreignObject>
    );
    if (selected) {
      ring = (
        <rect
          x={x - 3}
          y={y - 3}
          width={w + 6}
          height={h + 6}
          rx={8}
          ry={8}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          pointerEvents="none"
        />
      );
    }
  } else if (shape.kind === "freehand") {
    const ox = shape.x - offsetX;
    const oy = shape.y - offsetY;
    const pts: Array<[number, number]> = Array.isArray(shape.path)
      ? shape.path.map(([dx, dy]) => [ox + dx, oy + dy] as [number, number])
      : [];
    const d = smoothPath(pts);
    content = (
      <g>
        <path
          d={d}
          fill="none"
          stroke="transparent"
          strokeWidth={Math.max(12, style.strokeWidth + 10)}
          pointerEvents="stroke"
          onMouseDown={onMouseDown}
          data-canvas-shape={shape.id}
          className="cursor-pointer"
        />
        <path
          d={d}
          fill="none"
          stroke={style.stroke}
          strokeWidth={style.strokeWidth}
          strokeDasharray={style.dasharray}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={style.opacity ?? 1}
          pointerEvents="none"
        />
      </g>
    );
    if (selected && pts.length > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [px, py] of pts) {
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
      }
      ring = (
        <rect
          x={minX - 4}
          y={minY - 4}
          width={Math.max(8, maxX - minX + 8)}
          height={Math.max(8, maxY - minY + 8)}
          rx={4}
          ry={4}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          pointerEvents="none"
        />
      );
    }
  }

  return (
    <g className={ringClass}>
      {content}
      {ring}
    </g>
  );
});

function TextShapeEditor({
  initial,
  fontSize,
  fontWeight,
  color,
  onCommit,
  onCancel,
}: {
  initial: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial === "Text" ? "" : initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select-all on mount so the "Text" placeholder gets replaced on
    // first keystroke without a manual ctrl+a.
    if (initial && initial !== "Text") el.setSelectionRange(0, el.value.length);
  }, [initial]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        // Enter commits (Shift+Enter inserts a newline like a normal
        // multi-line editor). Esc cancels without persisting.
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onCommit(value);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      style={{
        fontSize,
        fontWeight,
        color,
        width: "100%",
        height: "100%",
        lineHeight: 1.35,
        resize: "none",
        border: "none",
        outline: "none",
        background: "transparent",
        padding: 0,
        fontFamily: "inherit",
      }}
      placeholder="Type…"
    />
  );
}
