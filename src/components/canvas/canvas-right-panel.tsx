"use client";
/**
 * CanvasRightPanel — collapsible right-edge sidebar that hosts the
 * Layers and Components tabs. Mirrors the existing left sidebar's
 * draggable resize + localStorage-backed width persistence.
 *
 * Mount as a flex sibling of the canvas surface, AFTER the surface
 * (so it sits on the right). The panel itself is `shrink-0` and
 * resolves to either:
 *   - open: `width` px (default 280), draggable handle on the LEFT edge
 *   - closed: 28px sliver with a chevron button to re-open
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CanvasComponentsPanel,
  type CanvasComponentsPanelProps,
} from "@/components/canvas/canvas-components-panel";
import {
  CanvasLayersPanel,
  type CanvasHydratePayload,
  type LayerSelectionRef,
} from "@/components/canvas/canvas-layers-panel";

const RIGHT_PANEL_MIN_WIDTH = 220;
const RIGHT_PANEL_MAX_WIDTH = 520;
const RIGHT_PANEL_DEFAULT_WIDTH = 280;
const RIGHT_PANEL_WIDTH_PREFIX = "forge.canvas.right-panel.";
const RIGHT_PANEL_OPEN_PREFIX = "forge.canvas.right-panel.open.";

type Tab = "layers" | "components";

export type CanvasRightPanelProps = {
  /** Workspace slug — used to scope localStorage keys per workspace. */
  slug: string;
  canvasId: string;
  data: CanvasHydratePayload;
  selected: LayerSelectionRef[];
  onSelect: (refs: LayerSelectionRef[], opts: { additive: boolean }) => void;
  selectionCount: CanvasComponentsPanelProps["selectionCount"];
  buildSelectionSnapshot: CanvasComponentsPanelProps["buildSelectionSnapshot"];
};

export function CanvasRightPanel({
  slug,
  canvasId,
  data,
  selected,
  onSelect,
  selectionCount,
  buildSelectionSnapshot,
}: CanvasRightPanelProps) {
  const widthKey = useMemo(() => `${RIGHT_PANEL_WIDTH_PREFIX}${slug}`, [slug]);
  const openKey = useMemo(() => `${RIGHT_PANEL_OPEN_PREFIX}${slug}`, [slug]);

  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const raw = window.localStorage.getItem(openKey);
    if (raw == null) return true;
    return raw === "1";
  });
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return RIGHT_PANEL_DEFAULT_WIDTH;
    const raw = window.localStorage.getItem(widthKey);
    const n = raw ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return RIGHT_PANEL_DEFAULT_WIDTH;
    return Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, n));
  });
  const [tab, setTab] = useState<Tab>("layers");
  const [resizing, setResizing] = useState(false);

  // Persist open/closed.
  useEffect(() => {
    try {
      window.localStorage.setItem(openKey, open ? "1" : "0");
    } catch {
      /* ignore quota */
    }
  }, [open, openKey]);

  // Drag handle on the LEFT edge. The right panel shrinks/grows by moving
  // its left boundary; clientX decreasing -> wider panel.
  const dragStartRef = useRef<{ startX: number; startW: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      setResizing(true);
      dragStartRef.current = { startX: e.clientX, startW: width };
      let lastWidth = width;
      const onMove = (ev: MouseEvent) => {
        const ds = dragStartRef.current;
        if (!ds) return;
        const delta = ds.startX - ev.clientX; // dragging left grows
        const next = Math.min(
          RIGHT_PANEL_MAX_WIDTH,
          Math.max(RIGHT_PANEL_MIN_WIDTH, ds.startW + delta),
        );
        lastWidth = next;
        if (panelRef.current) panelRef.current.style.width = `${next}px`;
      };
      const onUp = () => {
        setResizing(false);
        dragStartRef.current = null;
        setWidth(lastWidth);
        try {
          window.localStorage.setItem(widthKey, String(lastWidth));
        } catch {
          /* ignore */
        }
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width, widthKey],
  );

  if (!open) {
    return (
      <div className="relative flex w-7 shrink-0 items-start border-l border-border bg-card/40">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open layers + components panel"
          title="Open layers + components"
          className="m-1 flex h-6 w-5 items-center justify-center rounded text-muted-foreground hover:bg-subtle hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      className="relative flex shrink-0 flex-col border-l border-border bg-card/40"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize layers panel"
        onMouseDown={onHandleMouseDown}
        className={cn(
          "absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-ember/40",
          resizing && "bg-ember/60",
        )}
      />
      <div className="flex items-center justify-between gap-1 border-b border-border px-2 py-1.5">
        <div className="flex gap-1">
          <TabButton active={tab === "layers"} onClick={() => setTab("layers")}>
            Layers
          </TabButton>
          <TabButton
            active={tab === "components"}
            onClick={() => setTab("components")}
          >
            Components
          </TabButton>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Collapse panel"
          title="Collapse panel"
          className="rounded p-0.5 text-muted-foreground hover:bg-subtle hover:text-foreground"
        >
          <ChevronRight className="h-3 w-3" />
        </button>
      </div>
      {tab === "layers" ? (
        <CanvasLayersPanel
          canvasId={canvasId}
          data={data}
          selected={selected}
          onSelect={onSelect}
        />
      ) : (
        <CanvasComponentsPanel
          selectionCount={selectionCount}
          buildSelectionSnapshot={buildSelectionSnapshot}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded px-2 py-0.5 text-xs transition-colors",
        active
          ? "bg-card text-foreground"
          : "text-muted-foreground hover:bg-subtle hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
