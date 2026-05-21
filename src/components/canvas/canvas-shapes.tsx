"use client";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Check, CornerDownLeft, MessageCircle, RotateCcw, Trash2 } from "lucide-react";
import { ChatMarkdown } from "@/components/mission-control/chat-markdown";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  seedFromId,
  roughRect,
  roughEllipse,
  roughPolygon,
  type RoughPath,
} from "@/lib/canvas-rough";

/**
 * Inline comment-thread for a canvas comment-pin (W2.2). Comments live
 * on `shape.style.comments` as `[{ id, body, byUserId, byName,
 * createdAt, resolved }]` so we don't need a polymorphic Comment table
 * mid-wave. Resolve = soft flag; the pin styling reads the count of
 * unresolved entries. shapePatch is the only mutation we need.
 */
type ShapeComment = {
  id: string;
  body: string;
  byUserId: string | null;
  byName: string;
  createdAt: string;
  resolved: boolean;
};

function parseShapeComments(style: unknown): ShapeComment[] {
  if (!style || typeof style !== "object") return [];
  const raw = (style as { comments?: unknown }).comments;
  if (!Array.isArray(raw)) return [];
  const out: ShapeComment[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const e = r as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.body !== "string") continue;
    out.push({
      id: e.id,
      body: e.body,
      byUserId: typeof e.byUserId === "string" ? e.byUserId : null,
      byName: typeof e.byName === "string" ? e.byName : "you",
      createdAt: typeof e.createdAt === "string" ? e.createdAt : new Date().toISOString(),
      resolved: e.resolved === true,
    });
  }
  return out;
}

function CommentPinPopover({
  shape,
  onClose,
}: {
  shape: CanvasShapeRow;
  onClose: () => void;
}) {
  const comments = parseShapeComments(shape.style);
  const [draft, setDraft] = useState("");
  const meQ = trpc.user.me.useQuery(undefined, { staleTime: 5 * 60_000 });
  const me = meQ.data;
  const utils = trpc.useUtils();
  const patch = trpc.canvas.shapePatch.useMutation({
    onSuccess: () => {
      // Refresh the hydrate so other clients see the new comment list.
      utils.canvas.hydrate.invalidate({ id: shape.canvasId });
    },
  });

  const writeComments = (next: ShapeComment[]) => {
    const cur = (shape.style ?? {}) as Record<string, unknown>;
    patch.mutate({ id: shape.id, style: { ...cur, comments: next } });
  };

  const onAdd = () => {
    const body = draft.trim();
    if (body.length === 0) return;
    const newComment: ShapeComment = {
      id: `cmt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      body,
      byUserId: me?.id ?? null,
      byName: me?.name ?? me?.email ?? "you",
      createdAt: new Date().toISOString(),
      resolved: false,
    };
    writeComments([...comments, newComment]);
    setDraft("");
  };
  const onToggleResolved = (id: string) => {
    writeComments(
      comments.map((c) => (c.id === id ? { ...c, resolved: !c.resolved } : c)),
    );
  };
  const onDelete = (id: string) => {
    writeComments(comments.filter((c) => c.id !== id));
  };

  return (
    <div
      className="absolute left-0 rounded-md border border-border bg-popover p-2 text-xs shadow-lg"
      style={{ top: 30, width: 260, pointerEvents: "auto" }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-medium text-foreground">
          Comments
          {comments.length > 0 && (
            <span className="ml-1 font-mono text-[0.6875rem] text-muted-foreground">
              {comments.filter((c) => !c.resolved).length}/{comments.length}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="focus-ring h-5 w-5 rounded text-muted-foreground hover:bg-subtle hover:text-foreground"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>
      {comments.length > 0 ? (
        <ul className="mb-2 max-h-44 space-y-1.5 overflow-y-auto">
          {comments.map((c) => (
            <li
              key={c.id}
              className={cn(
                "group rounded border border-border/60 bg-card/60 p-1.5",
                c.resolved && "opacity-60",
              )}
            >
              <div className="mb-0.5 flex items-center justify-between">
                <span className="font-mono text-[0.625rem] text-muted-foreground">
                  {c.byName}
                </span>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100">
                  <button
                    type="button"
                    title={c.resolved ? "Reopen" : "Resolve"}
                    onClick={() => onToggleResolved(c.id)}
                    className="rounded p-0.5 text-muted-foreground hover:bg-subtle hover:text-foreground"
                  >
                    {c.resolved ? (
                      <RotateCcw className="h-3 w-3" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    onClick={() => onDelete(c.id)}
                    className="rounded p-0.5 text-muted-foreground hover:bg-subtle hover:text-danger"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <div className={cn("whitespace-pre-wrap", c.resolved && "line-through")}>
                {c.body}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mb-2 text-muted-foreground">No comments yet.</div>
      )}
      <div className="flex items-center gap-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Reply…"
          className="focus-ring h-7 flex-1 rounded border border-border bg-background px-1.5 text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onAdd();
            }
          }}
        />
        <button
          type="button"
          onClick={onAdd}
          disabled={patch.isPending || draft.trim().length === 0}
          className="focus-ring inline-flex h-7 items-center gap-1 rounded bg-ember px-2 text-[0.6875rem] text-ember-foreground hover:bg-ember/90 disabled:opacity-50"
        >
          <CornerDownLeft className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

export type ShapeKind =
  | "box"
  | "ellipse"
  | "diamond"
  | "line"
  | "arrow"
  | "text"
  | "freehand"
  | "sticky"
  | "comment-pin"
  | "stamp"
  | "image";

/** Arrow-end marker styles (Excalidraw parity). */
export type ArrowHead = "none" | "triangle" | "line" | "circle" | "diamond";

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
  /** Box corner radius (px). Undefined → default 6. */
  cornerRadius?: number;
  /** Hand-drawn (rough.js) rendering for geometric shapes. */
  sketch?: boolean;
  /** Arrow end/start markers. */
  arrowHead?: ArrowHead;
  arrowTail?: ArrowHead;
  /** Image src (resolved presigned URL injected by hydrate) + attachment id. */
  src?: string;
  attachmentId?: string;
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
    cornerRadius: typeof s.cornerRadius === "number" ? (s.cornerRadius as number) : undefined,
    sketch: s.sketch === true,
    arrowHead: typeof s.arrowHead === "string" ? (s.arrowHead as ArrowHead) : undefined,
    arrowTail: typeof s.arrowTail === "string" ? (s.arrowTail as ArrowHead) : undefined,
    src: typeof s.src === "string" ? (s.src as string) : undefined,
    attachmentId: typeof s.attachmentId === "string" ? (s.attachmentId as string) : undefined,
  };
}

// Diamond polygon points for a w×h box at (x,y).
function diamondPoints(x: number, y: number, w: number, h: number): Array<[number, number]> {
  return [
    [x + w / 2, y],
    [x + w, y + h / 2],
    [x + w / 2, y + h],
    [x, y + h / 2],
  ];
}

/** Render a set of rough.js paths as SVG <path> elements. */
function RoughPaths({
  paths,
  opacity,
  onMouseDown,
  shapeId,
}: {
  paths: RoughPath[];
  opacity: number;
  onMouseDown: (e: React.MouseEvent) => void;
  shapeId: string;
}) {
  return (
    <g opacity={opacity} className="cursor-pointer" pointerEvents="all" onMouseDown={onMouseDown} data-canvas-shape={shapeId}>
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          stroke={p.stroke}
          fill={p.fill}
          strokeWidth={p.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </g>
  );
}

/** Map an ArrowHead style to its marker url(). */
function markerUrl(head: ArrowHead | undefined, fallbackTriangle: boolean): string | undefined {
  const h = head ?? (fallbackTriangle ? "triangle" : "none");
  switch (h) {
    case "triangle":
      return "url(#canvas-arrow-triangle)";
    case "line":
      return "url(#canvas-arrow-line)";
    case "circle":
      return "url(#canvas-arrow-circle)";
    case "diamond":
      return "url(#canvas-arrow-diamond)";
    default:
      return undefined;
  }
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
  if (
    shape.kind === "box" ||
    shape.kind === "ellipse" ||
    shape.kind === "diamond" ||
    shape.kind === "image" ||
    shape.kind === "text"
  ) {
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
        {/* Legacy single arrowhead (kept for back-compat with existing
            arrows + the draft preview). */}
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
        {/* Styled arrowheads. `context-stroke` makes the marker inherit the
            line's stroke color; `auto-start-reverse` lets one marker serve
            both ends. */}
        <marker id="canvas-arrow-triangle" viewBox="0 -5 10 10" refX="8" refY="0" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,-4 L8,0 L0,4 Z" fill="context-stroke" />
        </marker>
        <marker id="canvas-arrow-line" viewBox="0 -5 10 10" refX="7" refY="0" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,-4 L7,0 L0,4" fill="none" stroke="context-stroke" strokeWidth="1.4" />
        </marker>
        <marker id="canvas-arrow-circle" viewBox="-5 -5 10 10" refX="0" refY="0" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <circle r="3.4" fill="context-stroke" />
        </marker>
        <marker id="canvas-arrow-diamond" viewBox="-6 -6 12 12" refX="0" refY="0" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M-5,0 L0,-4 L5,0 L0,4 Z" fill="context-stroke" />
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
    const radius = style.cornerRadius ?? 6;
    if (style.sketch) {
      const paths = roughRect(seedFromId(shape.id), x, y, w, h, {
        stroke: style.stroke,
        fill: style.fill,
        strokeWidth: style.strokeWidth,
      });
      content = (
        <RoughPaths paths={paths} opacity={style.opacity ?? 1} onMouseDown={onMouseDown} shapeId={shape.id} />
      );
    } else {
      content = (
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={radius}
          ry={radius}
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
    }
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
    if (style.sketch) {
      const paths = roughEllipse(seedFromId(shape.id), cx, cy, w, h, {
        stroke: style.stroke,
        fill: style.fill,
        strokeWidth: style.strokeWidth,
      });
      content = (
        <RoughPaths paths={paths} opacity={style.opacity ?? 1} onMouseDown={onMouseDown} shapeId={shape.id} />
      );
    } else {
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
    }
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
  } else if (shape.kind === "diamond") {
    const w = shape.width ?? 80;
    const h = shape.height ?? 80;
    const x = shape.x - offsetX;
    const y = shape.y - offsetY;
    const pts = diamondPoints(x, y, w, h);
    if (style.sketch) {
      const paths = roughPolygon(seedFromId(shape.id), pts, {
        stroke: style.stroke,
        fill: style.fill,
        strokeWidth: style.strokeWidth,
      });
      content = (
        <RoughPaths paths={paths} opacity={style.opacity ?? 1} onMouseDown={onMouseDown} shapeId={shape.id} />
      );
    } else {
      content = (
        <polygon
          points={pts.map((p) => p.join(",")).join(" ")}
          fill={style.fill}
          stroke={style.stroke}
          strokeWidth={style.strokeWidth}
          strokeDasharray={style.dasharray}
          strokeLinejoin="round"
          opacity={style.opacity ?? 1}
          className="cursor-pointer"
          pointerEvents="all"
          onMouseDown={onMouseDown}
          data-canvas-shape={shape.id}
        />
      );
    }
    if (selected) {
      ring = (
        <rect
          x={x - 3}
          y={y - 3}
          width={w + 6}
          height={h + 6}
          rx={6}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          pointerEvents="none"
        />
      );
    }
  } else if (shape.kind === "image") {
    const w = shape.width ?? 160;
    const h = shape.height ?? 120;
    const x = shape.x - offsetX;
    const y = shape.y - offsetY;
    content = style.src ? (
      <image
        href={style.src}
        x={x}
        y={y}
        width={w}
        height={h}
        opacity={style.opacity ?? 1}
        preserveAspectRatio="xMidYMid meet"
        className="cursor-pointer"
        pointerEvents="all"
        onMouseDown={onMouseDown}
        data-canvas-shape={shape.id}
      />
    ) : (
      // Placeholder while the presigned src resolves (or storage is off).
      <g onMouseDown={onMouseDown} data-canvas-shape={shape.id} className="cursor-pointer" pointerEvents="all">
        <rect x={x} y={y} width={w} height={h} rx={6} fill="rgba(255,255,255,0.04)" stroke="currentColor" strokeWidth={1} strokeDasharray="4 4" />
        <text x={x + w / 2} y={y + h / 2} textAnchor="middle" dominantBaseline="middle" fontSize={11} fill="currentColor" opacity={0.5}>
          image
        </text>
      </g>
    );
    if (selected) {
      ring = (
        <rect
          x={x - 3}
          y={y - 3}
          width={w + 6}
          height={h + 6}
          rx={8}
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
          markerEnd={shape.kind === "arrow" ? markerUrl(style.arrowHead, true) : markerUrl(style.arrowHead, false)}
          markerStart={markerUrl(style.arrowTail, false)}
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
    const allComments = parseShapeComments(shape.style);
    const unresolved = allComments.filter((c) => !c.resolved).length;
    const allResolved = allComments.length > 0 && unresolved === 0;
    // Popover footprint extends below the pin; expand the foreignObject
    // bbox so the popover doesn't clip against its parent SVG.
    const fX = x;
    const fY = y;
    const fW = Math.max(w, 260);
    const fH = commentPinOpen ? h + 260 : h;
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
            className={cn(
              "absolute left-0 top-0 flex items-center justify-center rounded-full shadow-md transition-transform hover:scale-105",
              allResolved
                ? "text-foreground/70 opacity-60 ring-1 ring-success/40"
                : "text-ember-foreground",
            )}
            style={{
              width: w,
              height: h,
              background: allResolved
                ? "hsl(var(--success) / 0.18)"
                : "hsl(var(--ember))",
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
            {unresolved > 0 ? (
              <span
                className="absolute -right-1 -top-1 flex h-3 min-w-3 items-center justify-center rounded-full px-1 text-[9px] font-medium text-ember-foreground"
                style={{ background: "hsl(var(--danger))" }}
              >
                {unresolved > 9 ? "9+" : unresolved}
              </span>
            ) : null}
          </button>
          {commentPinOpen ? (
            <CommentPinPopover
              shape={shape}
              onClose={() => onCommentPinClose?.()}
            />
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
