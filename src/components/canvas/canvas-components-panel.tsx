"use client";
/**
 * Components panel — the right-edge sidebar's Components tab.
 *
 * Lists workspace-scoped `CanvasComponent` rows. Each card is
 * draggable; dropping it on the canvas creates a
 * `CanvasComponentInstance` (the canvas page wires the drop handler
 * via the `application/x-forge-canvas-component` mime type). The
 * "Create from selection" button captures the currently-selected
 * canvas items into a snapshot `definition` and registers a new
 * component.
 */
import { memo, useMemo, useState } from "react";
import { Package, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const COMPONENT_DRAG_MIME = "application/x-forge-canvas-component";

export type ComponentDragPayload = {
  componentId: string;
  name: string;
  defaultWidth: number;
  defaultHeight: number;
};

/**
 * Selection snapshot sent from the canvas page so we can build a
 * `definition` JSON for `canvas.componentCreate`. The page is the
 * source of truth for what's selected — it passes us the raw rows
 * (cleaned to plain JSON) per selected entry.
 */
export type ComponentSelectionSnapshot = {
  /** Raw `WorkspaceCanvasNode` rows (selected nodes). */
  nodes: Array<{
    id: string;
    targetType: string;
    targetId: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  /** Raw `CanvasShape` rows (selected shapes). */
  shapes: Array<Record<string, unknown>>;
  /** Bounding box of the snapshot — used to seed component defaults. */
  bbox: { x: number; y: number; width: number; height: number };
};

export type CanvasComponentsPanelProps = {
  /**
   * Currently-selected items on the canvas, in the parent page's
   * `SelectedRef`-compatible shape. Used to gate the
   * "Create from selection" button.
   */
  selectionCount: number;
  /**
   * Lazy snapshot builder — only called when the operator confirms
   * "Create from selection" so we don't recompute on every render.
   */
  buildSelectionSnapshot: () => ComponentSelectionSnapshot | null;
};

export const CanvasComponentsPanel = memo(function CanvasComponentsPanel({
  selectionCount,
  buildSelectionSnapshot,
}: CanvasComponentsPanelProps) {
  const utils = trpc.useUtils();
  const list = trpc.canvas.componentList.useQuery({ includeArchived: false });
  const create = trpc.canvas.componentCreate.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: ({ name }) => {
      toast.success(`Created component "${name}"`);
      utils.canvas.componentList.invalidate();
    },
  });

  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");

  const filtered = useMemo(() => {
    const items = list.data?.items ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        (it.description ?? "").toLowerCase().includes(q),
    );
  }, [list.data, query]);

  function commitCreate() {
    const trimmed = draftName.trim();
    if (!trimmed) {
      toast.error("Name required");
      return;
    }
    const snap = buildSelectionSnapshot();
    if (!snap || (snap.nodes.length === 0 && snap.shapes.length === 0)) {
      toast.error("Select at least one node or shape on the canvas first.");
      return;
    }
    // Normalise positions so the snapshot is origin-relative. Stored
    // definition is independent of where on the canvas the source rows
    // happened to live.
    const ox = snap.bbox.x;
    const oy = snap.bbox.y;
    const definitionNodes = snap.nodes.map((n) => ({
      targetType: n.targetType,
      targetId: n.targetId,
      x: n.x - ox,
      y: n.y - oy,
      width: n.width,
      height: n.height,
    }));
    const definitionShapes = snap.shapes.map((raw) => {
      const s = raw as { x?: number; y?: number };
      return {
        ...raw,
        x: typeof s.x === "number" ? s.x - ox : 0,
        y: typeof s.y === "number" ? s.y - oy : 0,
      };
    });
    create.mutate(
      {
        name: trimmed,
        definition: {
          nodes: definitionNodes,
          shapes: definitionShapes,
          frames: [],
          edges: [],
          width: Math.max(1, Math.round(snap.bbox.width)),
          height: Math.max(1, Math.round(snap.bbox.height)),
        },
      },
      {
        onSuccess: () => {
          setCreating(false);
          setDraftName("");
        },
      },
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-2 pb-2 pt-2">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full rounded border border-border bg-card/40 py-0.5 pl-6 pr-1.5 text-xs"
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            title="Create component from selection"
            disabled={selectionCount === 0 || create.isPending}
            onClick={() => {
              if (selectionCount === 0) return;
              setCreating(true);
              setDraftName("");
            }}
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
        {creating ? (
          <div className="mt-1.5 flex items-center gap-1">
            <input
              autoFocus
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="Component name"
              onKeyDown={(e) => {
                if (e.key === "Enter") commitCreate();
                if (e.key === "Escape") {
                  setCreating(false);
                  setDraftName("");
                }
              }}
              className="flex-1 rounded border border-border bg-card/40 px-1.5 py-0.5 text-xs"
            />
            <Button
              size="sm"
              variant="ember"
              onClick={commitCreate}
              disabled={create.isPending}
            >
              Save
            </Button>
          </div>
        ) : null}
        <div className="mt-1.5 text-meta uppercase tracking-wider text-muted-foreground">
          Drag onto canvas
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-1.5 overflow-y-auto p-1.5">
        {filtered.length === 0 ? (
          <div className="col-span-2 px-2 py-4 text-meta text-muted-foreground">
            {list.isLoading
              ? "Loading…"
              : list.data?.items?.length
                ? "No components match that filter."
                : "No components yet. Select items on the canvas, then click + to capture them."}
          </div>
        ) : (
          filtered.map((c) => (
            <ComponentCard
              key={c.id}
              id={c.id}
              name={c.name}
              description={c.description}
              thumbnail={c.thumbnail}
            />
          ))
        )}
      </div>
    </div>
  );
});

type ComponentCardProps = {
  id: string;
  name: string;
  description: string | null;
  thumbnail: string | null;
};

function ComponentCard({ id, name, description, thumbnail }: ComponentCardProps) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copy";
        const payload: ComponentDragPayload = {
          componentId: id,
          name,
          // v1 defaults — the server falls back to definition width/height
          // if these are omitted, so we send conservative numbers.
          defaultWidth: 320,
          defaultHeight: 200,
        };
        e.dataTransfer.setData(COMPONENT_DRAG_MIME, JSON.stringify(payload));
      }}
      title={description ?? name}
      className={cn(
        "group flex flex-col gap-1 rounded-md border border-border bg-card/40 p-1.5 text-left text-xs",
        "hover:border-ember/40 hover:bg-subtle active:scale-[0.98] transition-all duration-200",
        "cursor-grab active:cursor-grabbing",
      )}
    >
      <div className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded border border-border/60 bg-card/60">
        {thumbnail ? (
          // Thumbnails are stored as data URLs (or asset keys, future).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnail}
            alt={name}
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <Package className="h-5 w-5 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 truncate text-foreground">{name}</div>
    </div>
  );
}
