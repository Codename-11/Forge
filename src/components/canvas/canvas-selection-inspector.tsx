"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlignJustify,
  ChevronDown,
  Lock,
  LockOpen,
  Maximize2,
  Minus,
  Plus,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import type { CanvasShapeRow } from "@/components/canvas/canvas-shapes";
import type { CanvasFrameRow } from "@/components/canvas/canvas-frames";

// Floating mini-toolbar that hovers 8px above the active selection
// bounding box (auto-flips below near the top of the viewport). Per
// W1.5: each kind exposes 4-6 properties max. Multi-selection shows
// only properties common to every member.
//
// Coordinate space: the parent passes us `bbox` already converted to
// **viewport-space** so we can position with simple `top`/`left`
// styles instead of redoing the canvas→viewport math in here.

export type InspectorSelection =
  | { kind: "shape"; shape: CanvasShapeRow }
  | { kind: "frame"; frame: CanvasFrameRow }
  | { kind: "node"; node: { id: string; meta?: Record<string, unknown> | null } }
  | { kind: "edge"; edgeId: string; edgeKind: string }
  | { kind: "multi"; count: number; kinds: Set<string> };

export type InspectorPatch =
  | {
      kind: "shape";
      id: string;
      patch: Partial<{
        stroke: string;
        fill: string;
        strokeWidth: number;
        opacity: number;
        cornerRadius: number;
        sketch: boolean;
        arrowHead: string;
        arrowTail: string;
        lockedAt: Date | null;
      }>;
    }
  | {
      kind: "frame";
      frameId: string;
      patch: Partial<{
        name: string;
        autoLayoutDirection: "vertical" | "horizontal" | null;
        autoLayoutGap: number;
        autoLayoutPadding: number;
      }>;
    }
  | { kind: "edge"; edgeId: string; patch: Partial<{ kind: string }> };

type Props = {
  selection: InspectorSelection;
  /** Selection bounding box in viewport-space pixels. */
  bbox: { x: number; y: number; width: number; height: number } | null;
  onPatch: (p: InspectorPatch) => void;
  onDelete: () => void;
  onOpenDetail?: () => void;
};

const STROKE_SWATCHES: Array<{ key: string; value: string }> = [
  { key: "foreground", value: "hsl(var(--foreground))" },
  { key: "muted", value: "hsl(var(--muted-foreground))" },
  { key: "ember", value: "hsl(var(--ember))" },
  { key: "success", value: "hsl(var(--success))" },
  { key: "warning", value: "hsl(var(--warning))" },
  { key: "danger", value: "hsl(var(--danger))" },
];

const STROKE_WIDTHS = [1, 2, 4] as const;

const FILL_SWATCHES: Array<{ key: string; value: string }> = [
  { key: "none", value: "transparent" },
  { key: "ember", value: "hsl(var(--ember) / 0.18)" },
  { key: "success", value: "hsl(var(--success) / 0.18)" },
  { key: "warning", value: "hsl(var(--warning) / 0.18)" },
  { key: "muted", value: "hsl(var(--muted-foreground) / 0.18)" },
];

const ARROW_HEADS = ["none", "triangle", "line", "circle", "diamond"] as const;
const ARROW_HEAD_GLYPH: Record<string, string> = {
  none: "—",
  triangle: "▶",
  line: "›",
  circle: "●",
  diamond: "◆",
};

const EDGE_KINDS = ["solid", "dashed", "dotted", "curved"] as const;

export function CanvasSelectionInspector({
  selection,
  bbox,
  onPatch,
  onDelete,
  onOpenDetail,
}: Props) {
  // Debounce patches so rapid clicks (e.g. nudging opacity by holding
  // the slider) don't flood the mutation pipe.
  const pendingRef = useRef<NodeJS.Timeout | null>(null);
  const enqueue = (p: InspectorPatch) => {
    if (pendingRef.current) clearTimeout(pendingRef.current);
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      onPatch(p);
    }, 200);
  };
  // Immediate-fire variant for discrete toggles (lock, edge kind) that
  // shouldn't feel laggy.
  const fireNow = (p: InspectorPatch) => {
    if (pendingRef.current) {
      clearTimeout(pendingRef.current);
      pendingRef.current = null;
    }
    onPatch(p);
  };
  useEffect(() => () => {
    if (pendingRef.current) clearTimeout(pendingRef.current);
  }, []);

  if (!bbox) return null;

  // Auto-flip below if too close to the top of the viewport.
  const FLIP_THRESHOLD_PX = 64;
  const flipBelow = bbox.y < FLIP_THRESHOLD_PX;
  const topPx = flipBelow ? bbox.y + bbox.height + 8 : bbox.y - 44;
  const leftPx = bbox.x + bbox.width / 2;

  return (
    <div
      role="toolbar"
      aria-label="Selection inspector"
      className={cn(
        "pointer-events-auto absolute z-30 -translate-x-1/2 select-none",
        "flex items-center gap-1 rounded-md border border-border bg-card/95 px-1.5 py-1 shadow-lg backdrop-blur",
        MOTION.fast,
      )}
      style={{ top: topPx, left: leftPx }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {selection.kind === "shape" && (
        <ShapeInspector shape={selection.shape} onEnqueue={enqueue} onFireNow={fireNow} />
      )}
      {selection.kind === "frame" && (
        <FrameInspector frame={selection.frame} onEnqueue={enqueue} onFireNow={fireNow} />
      )}
      {selection.kind === "edge" && (
        <EdgeInspector edgeId={selection.edgeId} edgeKind={selection.edgeKind} onFireNow={fireNow} />
      )}
      {selection.kind === "node" && (
        <NodeInspector onOpenDetail={onOpenDetail} />
      )}
      {selection.kind === "multi" && (
        <MultiInspector count={selection.count} />
      )}

      <Divider />
      <IconButton title="Delete (⌫)" onClick={onDelete}>
        <Trash2 className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
}

function ShapeInspector({
  shape,
  onEnqueue,
  onFireNow,
}: {
  shape: CanvasShapeRow;
  onEnqueue: (p: InspectorPatch) => void;
  onFireNow: (p: InspectorPatch) => void;
}) {
  const style = (shape.style ?? {}) as {
    stroke?: string;
    fill?: string;
    strokeWidth?: number;
    opacity?: number;
    cornerRadius?: number;
    sketch?: boolean;
    arrowHead?: string;
    arrowTail?: string;
  };
  const currentStroke = style.stroke ?? "hsl(var(--foreground))";
  const currentFill = style.fill ?? "transparent";
  const currentWidth = style.strokeWidth ?? 1.5;
  const currentOpacity = style.opacity ?? 1;
  const locked = !!shape.lockedAt;
  const isBoxy = shape.kind === "box";
  const isFillable = shape.kind === "box" || shape.kind === "ellipse" || shape.kind === "diamond";
  const isLinear = shape.kind === "arrow" || shape.kind === "line";

  return (
    <>
      <Popover label="Color" trigger={<Swatch color={currentStroke} />}>
        <div className="grid grid-cols-3 gap-1">
          {STROKE_SWATCHES.map((s) => (
            <button
              key={s.key}
              type="button"
              className={cn(
                "h-6 w-6 rounded border border-border",
                currentStroke === s.value && "ring-2 ring-ember/60",
              )}
              style={{ background: s.value }}
              onClick={() => onFireNow({ kind: "shape", id: shape.id, patch: { stroke: s.value } })}
            />
          ))}
        </div>
      </Popover>

      <Popover
        label="Stroke"
        trigger={
          <span className="font-mono text-[0.6875rem] text-muted-foreground">
            {currentWidth}px
          </span>
        }
      >
        <div className="flex items-center gap-1">
          {STROKE_WIDTHS.map((w) => (
            <button
              key={w}
              type="button"
              className={cn(
                "rounded px-2 py-1 font-mono text-[0.6875rem] hover:bg-subtle",
                currentWidth === w && "bg-subtle text-foreground",
              )}
              onClick={() => onFireNow({ kind: "shape", id: shape.id, patch: { strokeWidth: w } })}
            >
              {w}
            </button>
          ))}
        </div>
      </Popover>

      <Popover
        label="Opacity"
        trigger={
          <span className="font-mono text-[0.6875rem] text-muted-foreground">
            {Math.round(currentOpacity * 100)}%
          </span>
        }
      >
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(currentOpacity * 100)}
          onChange={(e) =>
            onEnqueue({
              kind: "shape",
              id: shape.id,
              patch: { opacity: Number(e.target.value) / 100 },
            })
          }
        />
      </Popover>

      {isFillable && (
        <Popover label="Fill" trigger={<Swatch color={currentFill === "transparent" ? "hsl(var(--card))" : currentFill} />}>
          <div className="grid grid-cols-5 gap-1">
            {FILL_SWATCHES.map((s) => (
              <button
                key={s.key}
                type="button"
                title={s.key}
                className={cn(
                  "h-6 w-6 rounded border border-border",
                  currentFill === s.value && "ring-2 ring-ember/60",
                  s.key === "none" && "bg-card",
                )}
                style={s.key === "none" ? undefined : { background: s.value }}
                onClick={() => onFireNow({ kind: "shape", id: shape.id, patch: { fill: s.value } })}
              >
                {s.key === "none" ? <span className="text-[0.625rem] text-danger">∅</span> : null}
              </button>
            ))}
          </div>
        </Popover>
      )}

      {isFillable && (
        <IconButton
          title="Hand-drawn (sketch) style"
          onClick={() => onFireNow({ kind: "shape", id: shape.id, patch: { sketch: !style.sketch } })}
        >
          <span className={cn("text-[0.6875rem]", style.sketch ? "text-ember" : "text-muted-foreground")}>✎</span>
        </IconButton>
      )}

      {isBoxy && (
        <Popover
          label="Radius"
          trigger={
            <span className="font-mono text-[0.6875rem] text-muted-foreground">
              {style.cornerRadius ?? 6}
            </span>
          }
        >
          <input
            type="range"
            min={0}
            max={40}
            value={style.cornerRadius ?? 6}
            onChange={(e) =>
              onEnqueue({ kind: "shape", id: shape.id, patch: { cornerRadius: Number(e.target.value) } })
            }
          />
        </Popover>
      )}

      {isLinear && (
        <Popover
          label="Ends"
          trigger={
            <span className="font-mono text-[0.6875rem] text-muted-foreground">
              {ARROW_HEAD_GLYPH[style.arrowTail ?? "none"]}–{ARROW_HEAD_GLYPH[style.arrowHead ?? (shape.kind === "arrow" ? "triangle" : "none")]}
            </span>
          }
        >
          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <span className="w-8 text-[0.625rem] text-muted-foreground">Start</span>
              {ARROW_HEADS.map((h) => (
                <button
                  key={`tail-${h}`}
                  type="button"
                  title={h}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[0.75rem] hover:bg-subtle",
                    (style.arrowTail ?? "none") === h && "bg-subtle text-foreground",
                  )}
                  onClick={() => onFireNow({ kind: "shape", id: shape.id, patch: { arrowTail: h } })}
                >
                  {ARROW_HEAD_GLYPH[h]}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <span className="w-8 text-[0.625rem] text-muted-foreground">End</span>
              {ARROW_HEADS.map((h) => (
                <button
                  key={`head-${h}`}
                  type="button"
                  title={h}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[0.75rem] hover:bg-subtle",
                    (style.arrowHead ?? (shape.kind === "arrow" ? "triangle" : "none")) === h && "bg-subtle text-foreground",
                  )}
                  onClick={() => onFireNow({ kind: "shape", id: shape.id, patch: { arrowHead: h } })}
                >
                  {ARROW_HEAD_GLYPH[h]}
                </button>
              ))}
            </div>
          </div>
        </Popover>
      )}

      <Divider />
      <IconButton
        title={locked ? "Unlock" : "Lock"}
        onClick={() =>
          onFireNow({
            kind: "shape",
            id: shape.id,
            patch: { lockedAt: locked ? null : new Date() },
          })
        }
      >
        {locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
      </IconButton>
    </>
  );
}

function FrameInspector({
  frame,
  onEnqueue,
  onFireNow,
}: {
  frame: CanvasFrameRow;
  onEnqueue: (p: InspectorPatch) => void;
  onFireNow: (p: InspectorPatch) => void;
}) {
  const layout = (frame as { autoLayout?: unknown }).autoLayout as
    | { direction?: string; gap?: number; padding?: number }
    | null
    | undefined;
  const direction = layout?.direction === "horizontal" ? "horizontal" : layout?.direction === "vertical" ? "vertical" : null;
  const [name, setName] = useState(frame.name ?? "");
  useEffect(() => setName(frame.name ?? ""), [frame.name]);

  return (
    <>
      <input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          onEnqueue({ kind: "frame", frameId: frame.id, patch: { name: e.target.value } });
        }}
        className="h-6 w-28 rounded border border-border bg-card px-1.5 text-[0.6875rem] focus-ring"
        placeholder="Frame name"
      />
      <Divider />
      <Popover
        label="Auto-layout"
        trigger={
          <span className="text-[0.6875rem] text-muted-foreground">
            {direction ?? "none"}
          </span>
        }
      >
        <div className="flex flex-col gap-1">
          {(["vertical", "horizontal", null] as const).map((d) => (
            <button
              key={d ?? "none"}
              type="button"
              className={cn(
                "rounded px-2 py-1 text-left text-[0.6875rem] hover:bg-subtle",
                direction === d && "bg-subtle text-foreground",
              )}
              onClick={() =>
                onFireNow({
                  kind: "frame",
                  frameId: frame.id,
                  patch: { autoLayoutDirection: d },
                })
              }
            >
              {d ?? "None"}
            </button>
          ))}
        </div>
      </Popover>

      {direction && (
        <>
          <Popover
            label="Gap"
            trigger={
              <span className="font-mono text-[0.6875rem] text-muted-foreground">
                {layout?.gap ?? 12}
              </span>
            }
          >
            <NumberStepper
              value={layout?.gap ?? 12}
              onChange={(v) => onEnqueue({ kind: "frame", frameId: frame.id, patch: { autoLayoutGap: v } })}
            />
          </Popover>
          <Popover
            label="Pad"
            trigger={
              <span className="font-mono text-[0.6875rem] text-muted-foreground">
                {layout?.padding ?? 12}
              </span>
            }
          >
            <NumberStepper
              value={layout?.padding ?? 12}
              onChange={(v) => onEnqueue({ kind: "frame", frameId: frame.id, patch: { autoLayoutPadding: v } })}
            />
          </Popover>
        </>
      )}
    </>
  );
}

function EdgeInspector({
  edgeId,
  edgeKind,
  onFireNow,
}: {
  edgeId: string;
  edgeKind: string;
  onFireNow: (p: InspectorPatch) => void;
}) {
  return (
    <>
      <Popover
        label="Style"
        trigger={
          <span className="text-[0.6875rem] capitalize text-muted-foreground">
            {edgeKind}
          </span>
        }
      >
        <div className="flex flex-col gap-1">
          {EDGE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={cn(
                "rounded px-2 py-1 text-left text-[0.6875rem] capitalize hover:bg-subtle",
                edgeKind === k && "bg-subtle text-foreground",
              )}
              onClick={() => onFireNow({ kind: "edge", edgeId, patch: { kind: k } })}
            >
              {k}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

function NodeInspector({ onOpenDetail }: { onOpenDetail?: () => void }) {
  return (
    <>
      <IconButton title="Open detail" onClick={() => onOpenDetail?.()}>
        <Maximize2 className="h-3.5 w-3.5" />
      </IconButton>
    </>
  );
}

function MultiInspector({ count }: { count: number }) {
  return (
    <span className="px-1 text-[0.6875rem] text-muted-foreground">
      <AlignJustify className="mr-1 inline h-3 w-3" />
      {count} selected
    </span>
  );
}

// ----- Subcomponents -----

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="focus-ring inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-subtle hover:text-foreground"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />;
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="block h-3.5 w-3.5 rounded-sm border border-border"
      style={{ background: color }}
    />
  );
}

function Popover({
  label,
  trigger,
  children,
}: {
  label: string;
  trigger: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={label}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "focus-ring inline-flex h-6 items-center gap-1 rounded px-1.5 hover:bg-subtle",
          open && "bg-subtle",
        )}
      >
        {trigger}
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-1/2 top-[calc(100%+4px)] z-50 -translate-x-1/2 rounded-md border border-border bg-card p-2 shadow-lg">
          {children}
        </div>
      )}
    </div>
  );
}

function NumberStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="rounded p-1 hover:bg-subtle"
        onClick={() => onChange(Math.max(0, value - 4))}
      >
        <Minus className="h-3 w-3" />
      </button>
      <span className="w-8 text-center font-mono text-[0.6875rem]">{value}</span>
      <button
        type="button"
        className="rounded p-1 hover:bg-subtle"
        onClick={() => onChange(value + 4)}
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
}
