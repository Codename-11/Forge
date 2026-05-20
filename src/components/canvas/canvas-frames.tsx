"use client";
import { memo, useMemo } from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Server frame shape, mirroring `CanvasFrame` from Prisma. JSON columns
 * are widened to `unknown` because the hydrate query returns them as
 * `JsonValue`; we narrow on read below.
 */
export type CanvasFrameRow = {
  id: string;
  canvasId: string;
  workspaceId: string;
  parentFrameId: string | null;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isPage: boolean;
  autoLayout: unknown;
  constraints: unknown;
  backgroundFill: unknown;
  z: number;
  lockedAt: Date | string | null;
  hiddenAt: Date | string | null;
};

const TITLE_BAR_HEIGHT = 24;

function readBackgroundFill(raw: unknown): {
  backgroundColor?: string;
  opacity?: number;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: { backgroundColor?: string; opacity?: number } = {};
  if (typeof o.color === "string") out.backgroundColor = o.color;
  if (typeof o.opacity === "number") out.opacity = o.opacity;
  return out;
}

type CanvasFramesProps = {
  frames: CanvasFrameRow[];
  selectedFrameIds: Set<string>;
  onSelectFrame: (id: string, event: React.MouseEvent) => void;
  /** Title-bar mousedown — begins frame drag in the parent. */
  onFrameTitleMouseDown: (id: string, event: React.MouseEvent) => void;
  /** Live drag overrides keyed by frame id (canvas-space x/y). */
  overrides?: Map<string, { x: number; y: number }>;
  /** Currently-active page id (for DESIGN canvases). When set, frames
   * that are top-level pages (`isPage` + no parentFrameId) other than
   * this id are hidden so multi-page canvases show one page at a time. */
  activePageId?: string | null;
  /** Canvas kind — DESIGN canvases honor multi-page filtering. */
  canvasKind?: string | null;
};

/**
 * Read-only renderer for `CanvasFrame` rows. Mounted INSIDE the
 * canvas-space transform group so frame coords share the node + shape
 * coordinate space. Frames render BELOW lanes/shapes/nodes — the
 * frame body has `pointer-events: none` so children stay clickable;
 * the title bar is the only interactive zone.
 */
export const CanvasFrames = memo(function CanvasFrames({
  frames,
  selectedFrameIds,
  onSelectFrame,
  onFrameTitleMouseDown,
  overrides,
  activePageId,
  canvasKind,
}: CanvasFramesProps) {
  const visible = useMemo(() => {
    return frames.filter((f) => {
      if (f.hiddenAt) return false;
      // DESIGN canvas: hide top-level pages other than the active one.
      if (
        canvasKind === "DESIGN" &&
        f.isPage &&
        f.parentFrameId === null &&
        activePageId &&
        f.id !== activePageId
      ) {
        return false;
      }
      return true;
    });
  }, [frames, canvasKind, activePageId]);

  if (visible.length === 0) return null;

  return (
    <>
      {visible.map((frame) => {
        const ov = overrides?.get(frame.id);
        const x = ov?.x ?? frame.x;
        const y = ov?.y ?? frame.y;
        const selected = selectedFrameIds.has(frame.id);
        const locked = frame.lockedAt != null;
        const bg = readBackgroundFill(frame.backgroundFill);
        return (
          <div
            key={frame.id}
            data-canvas-frame
            data-frame-id={frame.id}
            // Body is non-interactive so children stay clickable. The
            // title bar below re-enables pointer events for selection.
            className={cn(
              "pointer-events-none absolute border border-border",
              selected ? "ring-1 ring-ember/60" : "",
            )}
            style={{
              left: x,
              top: y,
              width: frame.width,
              height: frame.height,
              zIndex: frame.z, // local stacking; the outer wrapper keeps frames behind nodes/shapes
              ...bg,
            }}
          >
            <div
              data-canvas-frame-title
              data-frame-id={frame.id}
              className={cn(
                "pointer-events-auto absolute left-0 right-0 top-0 flex items-center gap-1 px-2",
                "border-b border-border/70 bg-card/60 backdrop-blur-sm",
                "text-meta text-foreground/80 select-none cursor-move",
                "hover:border-foreground/30",
                selected ? "border-foreground/40 bg-card/80" : "",
              )}
              style={{ height: TITLE_BAR_HEIGHT }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                // Selection is layered onto the title-bar mousedown
                // so a single gesture both selects AND primes drag.
                onSelectFrame(frame.id, e);
                if (!locked) onFrameTitleMouseDown(frame.id, e);
              }}
              title={frame.name}
            >
              {locked ? (
                <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
              ) : null}
              <span className="truncate">{frame.name}</span>
              {frame.isPage ? (
                <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground/70">
                  page
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </>
  );
});
