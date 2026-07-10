"use client";
import {
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { motion, useDragControls, useReducedMotion } from "framer-motion";
import {
  ChevronDown,
  ChevronUp,
  EyeOff,
  GripVertical,
  Maximize2,
  Minimize2,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Customizable dashboard widget grid. Renders widgets in a user-defined
 * order across a responsive 2-column grid; each widget is `half` (one
 * column) or `full` (spans both). Order + hidden set + per-widget width
 * persist server-side via `dashboardPrefs`.
 *
 * Customize mode (`editing`) layers in:
 * - **Drag to reorder** — grab anywhere on a tile (a full-body overlay is
 *   the drag handle, so you don't have to aim for a tiny grip). The grid
 *   reflows live as you drag; framer-motion `layout` animates every tile,
 *   and the dragged tile springs to its committed slot on release. A short
 *   reorder cool-down keeps it from thrashing while tiles are mid-animation.
 * - **Resize** half↔full via the size button or by dragging the right edge.
 * - Hide to a shelf; reorder/restore with keyboard-friendly buttons.
 *
 * Widgets that render nothing (e.g. no agents, no recent items) collapse
 * via `:empty` when **not** editing, so an unused widget never shows as a
 * blank tile. In edit mode they stay visible (flagged "not in use") so you
 * can hide them deliberately.
 *
 * Honours `prefers-reduced-motion` (instant, no spring).
 */

export type WidgetWidth = "half" | "full";
export type DashboardWidget = {
  id: string;
  title: string;
  node: ReactNode;
  /** Default column width when the user hasn't set one. */
  defaultWidth?: WidgetWidth;
};
export type DashboardLayout = {
  order: string[];
  hidden: string[];
  /** Per-widget width override; falls back to the widget's `defaultWidth`. */
  widths?: Record<string, WidgetWidth>;
};

/** Resolve the effective widget order: saved order first (known ids only),
 *  then any widgets the saved order didn't mention, appended in registry
 *  order. */
export function orderWidgets(
  widgets: DashboardWidget[],
  order: string[],
): DashboardWidget[] {
  const known = new Map(widgets.map((w) => [w.id, w] as const));
  const seen = new Set<string>();
  const out: DashboardWidget[] = [];
  for (const id of order) {
    const w = known.get(id);
    if (w && !seen.has(id)) {
      out.push(w);
      seen.add(id);
    }
  }
  for (const w of widgets) if (!seen.has(w.id)) out.push(w);
  return out;
}

// Pointer travel (px) on the edge handle before a width flip commits.
const RESIZE_THRESHOLD = 56;
// Min gap (ms) between live reorders so tiles can settle (kills thrash).
const REORDER_COOLDOWN_MS = 90;
// Compact implicit rows let a measured tile span only the height it needs,
// producing a masonry-style pack without changing DOM/keyboard order.
const MASONRY_ROW_HEIGHT = 4;
const MASONRY_GAP = 16;

export function DashboardStack({
  widgets,
  layout,
  editing,
  onChange,
  columns = 2,
}: {
  widgets: DashboardWidget[];
  layout: DashboardLayout;
  editing: boolean;
  onChange: (next: DashboardLayout) => void;
  /** 1 forces a single-column stack (e.g. a narrow rail) — half/full width
   *  then both render at the rail's full width, so the resize control is
   *  hidden rather than offered with no visible effect. */
  columns?: 1 | 2;
}) {
  const ordered = orderWidgets(widgets, layout.order);
  const orderedIds = ordered.map((w) => w.id);
  const hidden = new Set(layout.hidden);
  const widths = layout.widths ?? {};

  const gridRef = useRef<HTMLDivElement>(null);
  const lastReorderAt = useRef(0);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);

  const visible = ordered.filter((w) => !hidden.has(w.id));
  const hiddenWidgets = ordered.filter((w) => hidden.has(w.id));

  const widthOf = (w: DashboardWidget): WidgetWidth =>
    widths[w.id] ?? w.defaultWidth ?? "full";

  function commitOrder(nextOrder: string[]) {
    onChange({ order: nextOrder, hidden: [...hidden], widths });
  }

  /** Move `sourceId` before `targetId` (or to the end of the visible run
   *  when `targetId` is null), preserving hidden-id positions. Emits only
   *  when the order actually changes. */
  function reorder(sourceId: string, targetId: string | null) {
    const ids = orderedIds.filter((id) => id !== sourceId);
    if (targetId && targetId !== sourceId) {
      const at = ids.indexOf(targetId);
      if (at < 0) return;
      ids.splice(at, 0, sourceId);
    } else {
      const lastVisible = [...ids].reverse().find((id) => !hidden.has(id));
      const at = lastVisible ? ids.indexOf(lastVisible) + 1 : ids.length;
      ids.splice(at, 0, sourceId);
    }
    if (ids.join(" ") !== orderedIds.join(" ")) commitOrder(ids);
  }

  /** Reading-order drop target under the pointer, or null to append. */
  function targetUnderPointer(clientX: number, clientY: number, sourceId: string) {
    const grid = gridRef.current;
    if (!grid) return null;
    const nodes = Array.from(grid.querySelectorAll<HTMLElement>("[data-widget-id]"));
    for (const n of nodes) {
      const id = n.dataset.widgetId;
      if (!id || id === sourceId) continue;
      const r = n.getBoundingClientRect();
      const before =
        clientY < r.top + r.height * 0.4 ||
        (clientY <= r.bottom && clientX < r.left + r.width * 0.5);
      if (before) return id;
    }
    return null;
  }

  function handleDrag(sourceId: string, e: PointerEvent | MouseEvent | TouchEvent) {
    const pt = "clientX" in e ? e : (e as TouchEvent).touches?.[0];
    if (!pt) return;
    lastPointer.current = { x: pt.clientX, y: pt.clientY };
    // Throttle reorder attempts so tiles can finish their layout animation
    // before we re-measure — this is what stops the mid-drag thrash.
    const now = Date.now();
    if (now - lastReorderAt.current < REORDER_COOLDOWN_MS) return;
    lastReorderAt.current = now;
    reorder(sourceId, targetUnderPointer(pt.clientX, pt.clientY, sourceId));
  }

  function handleDragEnd(sourceId: string) {
    // Honour the final pointer position even if the last move was within
    // the cool-down window, so the tile lands exactly where released.
    const p = lastPointer.current;
    if (p) reorder(sourceId, targetUnderPointer(p.x, p.y, sourceId));
    lastPointer.current = null;
  }

  function moveVisibleBy(id: string, delta: -1 | 1) {
    const visibleIds = orderedIds.filter((orderedId) => !hidden.has(orderedId));
    const from = visibleIds.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= visibleIds.length) return;
    reorder(id, delta < 0 ? visibleIds[to] : visibleIds[to + 1] ?? null);
  }

  function setWidth(id: string, width: WidgetWidth) {
    onChange({ order: orderedIds, hidden: [...hidden], widths: { ...widths, [id]: width } });
  }
  function hide(id: string) {
    onChange({ order: orderedIds, hidden: [...hidden, id], widths });
  }
  function show(id: string) {
    onChange({
      order: orderedIds,
      hidden: [...hidden].filter((h) => h !== id),
      widths,
    });
  }

  return (
    <div>
      <div
        ref={gridRef}
        style={editing ? undefined : { gridAutoRows: `${MASONRY_ROW_HEIGHT}px` }}
        className={cn(
          "grid grid-cols-1 items-start gap-4",
          // `columns=1` (the rail) still opens up to 2 columns in the
          // sm..xl range, where the outer page hasn't split into the
          // primary/rail layout yet and this stack is rendering as a
          // full-width section — forcing it to 1 column there just adds
          // unnecessary scroll. It collapses back to 1 at `xl`, then opens
          // to 2 again at `2xl` where the page gives the ambient rail 5/12
          // of the canvas. This is the wide-screen gap-filling layout.
          columns === 1
            ? "sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2"
            : "lg:grid-cols-2",
        )}
      >
        {visible.map((w, index) => (
          <DashboardTile
            key={w.id}
            widget={w}
            width={widthOf(w)}
            editing={editing}
            masonry={!editing}
            columns={columns}
            isFirst={index === 0}
            isLast={index === visible.length - 1}
            onDrag={(e) => handleDrag(w.id, e)}
            onDragEnd={() => handleDragEnd(w.id)}
            onMove={(delta) => moveVisibleBy(w.id, delta)}
            onSetWidth={(width) => setWidth(w.id, width)}
            onHide={() => hide(w.id)}
          />
        ))}
      </div>

      {editing && hiddenWidgets.length > 0 && (
        <div className="mt-6 rounded-lg border border-dashed border-border bg-card/30 p-3">
          <div className="mb-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Hidden widgets
          </div>
          <div className="flex flex-wrap gap-1.5">
            {hiddenWidgets.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => show(w.id)}
                className="focus-ring inline-flex items-center gap-1 rounded-md border border-border bg-card/40 px-2 py-1 text-meta hover:border-ember/40 hover:text-foreground"
              >
                <Plus className="h-3 w-3" /> {w.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DashboardTile({
  widget,
  width,
  editing,
  masonry,
  columns,
  isFirst,
  isLast,
  onDrag,
  onDragEnd,
  onMove,
  onSetWidth,
  onHide,
}: {
  widget: DashboardWidget;
  width: WidgetWidth;
  editing: boolean;
  masonry: boolean;
  columns: 1 | 2;
  isFirst: boolean;
  isLast: boolean;
  onDrag: (e: PointerEvent | MouseEvent | TouchEvent) => void;
  onDragEnd: () => void;
  onMove: (delta: -1 | 1) => void;
  onSetWidth: (width: WidgetWidth) => void;
  onHide: () => void;
}) {
  const controls = useDragControls();
  const reduce = useReducedMotion();
  const [resizing, setResizing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [rowSpan, setRowSpan] = useState(1);
  const tileRef = useRef<HTMLDivElement>(null);
  const resizeStartX = useRef(0);

  const isFull = width === "full";
  const spring = reduce
    ? { duration: 0 }
    : ({ type: "spring", stiffness: 520, damping: 40, mass: 0.8 } as const);

  useLayoutEffect(() => {
    if (!masonry) return;
    const node = tileRef.current;
    if (!node) return;
    const measure = () => {
      const height = node.getBoundingClientRect().height;
      const next = Math.max(
        1,
        Math.ceil((height + MASONRY_GAP) / (MASONRY_ROW_HEIGHT + MASONRY_GAP)),
      );
      setRowSpan((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [masonry, widget.node]);

  function onResizePointerDown(e: ReactPointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    resizeStartX.current = e.clientX;
    setResizing(true);
  }
  function onResizePointerMove(e: ReactPointerEvent) {
    if (!resizing) return;
    const dx = e.clientX - resizeStartX.current;
    if (!isFull && dx > RESIZE_THRESHOLD) {
      onSetWidth("full");
      resizeStartX.current = e.clientX;
    } else if (isFull && dx < -RESIZE_THRESHOLD) {
      onSetWidth("half");
      resizeStartX.current = e.clientX;
    }
  }
  function onResizePointerUp(e: ReactPointerEvent) {
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    setResizing(false);
  }

  return (
    <motion.div
      ref={tileRef}
      layout
      data-widget-id={widget.id}
      drag={editing && !resizing}
      dragListener={false}
      dragControls={controls}
      dragSnapToOrigin
      dragElastic={0}
      dragMomentum={false}
      onDragStart={() => setDragging(true)}
      onDrag={(e: PointerEvent | MouseEvent | TouchEvent) => onDrag(e)}
      onDragEnd={() => {
        setDragging(false);
        onDragEnd();
      }}
      transition={spring}
      style={{
        zIndex: dragging ? 40 : undefined,
        gridRowEnd: masonry ? `span ${rowSpan}` : undefined,
      }}
      whileDrag={reduce ? undefined : { scale: 1.03 }}
      className={cn(
        "relative min-w-0",
        // Collapse a widget that renders nothing — but only when not
        // editing (in edit mode the control strip keeps it non-empty so it
        // stays hideable).
        !editing && "empty:hidden",
        isFull &&
          (columns === 1
            ? "sm:col-span-2 xl:col-span-1 2xl:col-span-2"
            : "lg:col-span-2"),
        editing && "rounded-lg ring-1 ring-dashed ring-ember/40",
        dragging && "shadow-[0_18px_44px_rgba(0,0,0,0.20)]",
      )}
    >
      {editing && (
        <div className="relative z-20 flex flex-wrap items-center gap-1.5 rounded-t-lg border-b border-dashed border-ember/30 bg-ember/5 px-2.5 py-1.5 text-meta text-muted-foreground">
          <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground/80">
            {widget.title}
          </span>
          <div className="ml-auto inline-flex shrink-0 items-center gap-0.5">
            {columns === 2 && (
              <button
                type="button"
                onClick={() => onSetWidth(isFull ? "half" : "full")}
                className="focus-ring hidden h-7 w-7 place-items-center rounded hover:bg-subtle hover:text-foreground lg:grid"
                title={isFull ? "Make half width" : "Make full width"}
                aria-label={isFull ? `Make ${widget.title} half width` : `Make ${widget.title} full width`}
              >
                {isFull ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
            )}
            <button
              type="button"
              onClick={() => onMove(-1)}
              disabled={isFirst}
              className="focus-ring grid h-7 w-7 place-items-center rounded hover:bg-subtle hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              title="Move widget up"
              aria-label={`Move ${widget.title} up`}
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onMove(1)}
              disabled={isLast}
              className="focus-ring grid h-7 w-7 place-items-center rounded hover:bg-subtle hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              title="Move widget down"
              aria-label={`Move ${widget.title} down`}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={onHide}
            className="focus-ring inline-flex h-7 shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-subtle hover:text-foreground"
          >
            <EyeOff className="h-3 w-3" /> Hide
          </button>
        </div>
      )}

      {editing ? (
        <>
          <div className="peer pointer-events-none select-none p-2 opacity-90">
            {widget.node}
          </div>
          {/* Shown only when the widget rendered nothing — so an unused tile
              reads as "hide me" instead of a mysterious empty box. */}
          <div className="hidden px-3 py-6 text-center text-meta text-muted-foreground/70 peer-empty:block">
            Not in use right now — hide it to declutter.
          </div>
        </>
      ) : (
        widget.node
      )}

      {editing && (
        <>
          {/* Full-body drag handle: grab anywhere below the control strip.
              Sits above the (pointer-events-none) content and blocks inner
              clicks while editing; the resize handle stacks above it. */}
          <div
            onPointerDown={(e) => controls.start(e)}
            className="absolute inset-x-0 bottom-0 top-9 z-10 cursor-grab touch-none active:cursor-grabbing"
            aria-hidden
          />
          {/* Right-edge resize: drag in/out past a threshold to snap width. */}
          {columns === 2 && (
            <div
              onPointerDown={onResizePointerDown}
              onPointerMove={onResizePointerMove}
              onPointerUp={onResizePointerUp}
              className="group/resize absolute -right-1.5 bottom-2 top-10 z-30 hidden w-4 cursor-ew-resize touch-none place-items-center lg:grid"
              title={isFull ? "Drag in for half width" : "Drag out for full width"}
              aria-hidden
            >
              <span
                className={cn(
                  "h-12 w-1 rounded-full transition-colors",
                  resizing ? "bg-ember/70" : "bg-ember/25 group-hover/resize:bg-ember/50",
                )}
              />
            </div>
          )}
        </>
      )}
    </motion.div>
  );
}
