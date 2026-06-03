"use client";
import { useRef, type ReactNode } from "react";
import { ChevronDown, ChevronUp, EyeOff, GripVertical, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Customizable dashboard widget stack. Renders a set of widgets in a
 * user-defined order, with per-widget hide, all persisted server-side
 * via `dashboardPrefs`.
 *
 * Design notes:
 * - Each widget owns its own card chrome, so we don't wrap it in an
 *   outer header. In **edit mode** a thin dashed control strip appears
 *   above each widget (drag handle + hide); otherwise widgets render
 *   pristine, exactly as before.
 * - Widgets that render `null` (empty state) collapse via `empty:hidden`
 *   so they leave no gap when not editing — but in edit mode the control
 *   strip keeps them reorderable/hideable even while empty.
 * - Reorder is HTML5 drag-and-drop (no dep), matching the saved-views
 *   bar. New widget ids not present in a saved order append at the end,
 *   so shipping a new widget never requires a prefs migration.
 */

export type DashboardWidget = { id: string; title: string; node: ReactNode };
export type DashboardLayout = { order: string[]; hidden: string[] };

/** Resolve the effective widget order: saved order first (known ids
 *  only), then any widgets the saved order didn't mention, appended in
 *  registry order. */
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

export function DashboardStack({
  widgets,
  layout,
  editing,
  onChange,
}: {
  /** Widgets in their default (registry) order. */
  widgets: DashboardWidget[];
  layout: DashboardLayout;
  editing: boolean;
  onChange: (next: DashboardLayout) => void;
}) {
  const ordered = orderWidgets(widgets, layout.order);
  const orderedIds = ordered.map((w) => w.id);
  const hidden = new Set(layout.hidden);
  const dragId = useRef<string | null>(null);

  const visible = ordered.filter((w) => !hidden.has(w.id));
  const hiddenWidgets = ordered.filter((w) => hidden.has(w.id));

  function moveBefore(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const ids = orderedIds.filter((id) => id !== sourceId);
    const at = ids.indexOf(targetId);
    if (at < 0) return;
    ids.splice(at, 0, sourceId);
    onChange({ order: ids, hidden: [...hidden] });
  }

  function moveVisibleBy(id: string, delta: -1 | 1) {
    const visibleIds = orderedIds.filter((orderedId) => !hidden.has(orderedId));
    const from = visibleIds.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= visibleIds.length) return;
    const targetId = visibleIds[to];
    const ids = orderedIds.filter((orderedId) => orderedId !== id);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex < 0) return;
    ids.splice(delta < 0 ? targetIndex : targetIndex + 1, 0, id);
    onChange({ order: ids, hidden: [...hidden] });
  }

  function hide(id: string) {
    onChange({ order: orderedIds, hidden: [...hidden, id] });
  }

  function show(id: string) {
    onChange({ order: orderedIds, hidden: [...hidden].filter((h) => h !== id) });
  }

  return (
    <div className="space-y-6">
      {visible.map((w, index) => (
        <div
          key={w.id}
          className={cn(
            "empty:hidden",
            editing && "rounded-lg ring-1 ring-dashed ring-ember/40",
          )}
          draggable={editing}
          onDragStart={() => {
            if (editing) dragId.current = w.id;
          }}
          onDragOver={(e) => {
            if (editing && dragId.current) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!editing || !dragId.current) return;
            e.preventDefault();
            moveBefore(dragId.current, w.id);
            dragId.current = null;
          }}
        >
          {editing && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-t-lg border-b border-dashed border-ember/30 bg-ember/5 px-2.5 py-1.5 text-meta text-muted-foreground">
              <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab active:cursor-grabbing" />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground/80">
                {w.title}
              </span>
              <div className="ml-auto inline-flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => moveVisibleBy(w.id, -1)}
                  disabled={index === 0}
                  className="focus-ring grid h-7 w-7 place-items-center rounded hover:bg-subtle hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                  title="Move widget up"
                  aria-label={`Move ${w.title} up`}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => moveVisibleBy(w.id, 1)}
                  disabled={index === visible.length - 1}
                  className="focus-ring grid h-7 w-7 place-items-center rounded hover:bg-subtle hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                  title="Move widget down"
                  aria-label={`Move ${w.title} down`}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => hide(w.id)}
                className="focus-ring inline-flex h-7 shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-subtle hover:text-foreground"
              >
                <EyeOff className="h-3 w-3" /> Hide
              </button>
            </div>
          )}
          {editing ? (
            <div className="pointer-events-none select-none p-2 opacity-90">
              {w.node}
            </div>
          ) : (
            w.node
          )}
        </div>
      ))}

      {editing && hiddenWidgets.length > 0 && (
        <div className="rounded-lg border border-dashed border-border bg-card/30 p-3">
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
