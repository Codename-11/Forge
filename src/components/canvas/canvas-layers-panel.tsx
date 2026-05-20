"use client";
/**
 * Canvas Layers panel — the right-edge sidebar layers tree.
 *
 * Reads from the existing `canvas.hydrate` response (passed in from the
 * parent page so we don't re-fetch) and assembles a tree where:
 *   - top-level items   = top-level frames (no parentFrameId) PLUS any
 *     ungrouped node / shape / instance whose parentFrameId is null and
 *     groupId is null,
 *   - a frame owns its child frames, nodes, shapes, instances, and
 *     groups (anything whose parentFrameId === frame.id),
 *   - a group owns nodes / shapes (via canvasGroupId) / instances whose
 *     groupId === group.id.
 *
 * Each row supports: chevron expand/collapse, eye toggle (hide), lock
 * toggle, double-click rename for frames / groups / components, and
 * click-to-select. Drag-to-reorder uses the HTML5 DnD API with a
 * native parent-only drop target (siblings only — cross-parent moves
 * land in a later round).
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  Group as GroupIcon,
  Lock,
  Package,
  Pencil,
  Square,
  Unlock,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types — narrow shapes from the hydrate query. We keep them local so this
// component doesn't depend on the page file's internal types.
// ---------------------------------------------------------------------------

export type LayerKind = "frame" | "group" | "node" | "shape" | "instance";

export type LayerSelectionRef = { kind: LayerKind; id: string };

type NodeRow = {
  id: string;
  parentFrameId: string | null;
  groupId: string | null;
  zIndex: number;
  lockedAt: Date | string | null;
  hiddenAt: Date | string | null;
  ref?: { label?: string | null } | null;
};

type ShapeRow = {
  id: string;
  kind: string;
  parentFrameId: string | null;
  canvasGroupId: string | null;
  zIndex: number;
  lockedAt: Date | string | null;
  hiddenAt: Date | string | null;
  text?: string | null;
};

type FrameRow = {
  id: string;
  parentFrameId: string | null;
  name: string;
  z: number;
  lockedAt: Date | string | null;
  hiddenAt: Date | string | null;
};

type GroupRow = {
  id: string;
  parentFrameId: string | null;
  name: string;
  z: number;
  lockedAt: Date | string | null;
  hiddenAt: Date | string | null;
};

type InstanceRow = {
  id: string;
  parentFrameId: string | null;
  groupId: string | null;
  componentId: string;
  z: number;
  lockedAt: Date | string | null;
  hiddenAt: Date | string | null;
};

export type CanvasHydratePayload = {
  nodes?: NodeRow[];
  shapes?: ShapeRow[];
  frames?: FrameRow[];
  groups?: GroupRow[];
  componentInstances?: InstanceRow[];
} | null | undefined;

// ---------------------------------------------------------------------------
// Tree assembly. Pure function over the hydrate slice — memoizable in the
// parent component.
// ---------------------------------------------------------------------------

type TreeRow =
  | { kind: "frame"; id: string; row: FrameRow; depth: number; hasChildren: boolean }
  | { kind: "group"; id: string; row: GroupRow; depth: number; hasChildren: boolean }
  | { kind: "node"; id: string; row: NodeRow; depth: number; hasChildren: false }
  | { kind: "shape"; id: string; row: ShapeRow; depth: number; hasChildren: false }
  | {
      kind: "instance";
      id: string;
      row: InstanceRow;
      depth: number;
      hasChildren: false;
    };

type BuildContext = {
  frames: FrameRow[];
  groups: GroupRow[];
  nodes: NodeRow[];
  shapes: ShapeRow[];
  instances: InstanceRow[];
};

function sortByZ<T extends { z?: number; zIndex?: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const az = (a.z ?? a.zIndex ?? 0) as number;
    const bz = (b.z ?? b.zIndex ?? 0) as number;
    return az - bz;
  });
}

/**
 * Flatten the layers tree into a render-ready list. Honors `expanded`
 * so collapsed parents skip their descendants.
 */
function buildTree(
  ctx: BuildContext,
  expanded: Set<string>,
): TreeRow[] {
  const out: TreeRow[] = [];

  // Index children by parent for O(1) lookup.
  const framesByParent = new Map<string | null, FrameRow[]>();
  for (const f of ctx.frames) {
    const k = f.parentFrameId ?? null;
    if (!framesByParent.has(k)) framesByParent.set(k, []);
    framesByParent.get(k)!.push(f);
  }
  const groupsByFrame = new Map<string | null, GroupRow[]>();
  for (const g of ctx.groups) {
    const k = g.parentFrameId ?? null;
    if (!groupsByFrame.has(k)) groupsByFrame.set(k, []);
    groupsByFrame.get(k)!.push(g);
  }
  const nodesByFrame = new Map<string | null, NodeRow[]>();
  const nodesByGroup = new Map<string, NodeRow[]>();
  for (const n of ctx.nodes) {
    if (n.groupId) {
      if (!nodesByGroup.has(n.groupId)) nodesByGroup.set(n.groupId, []);
      nodesByGroup.get(n.groupId)!.push(n);
    } else {
      const k = n.parentFrameId ?? null;
      if (!nodesByFrame.has(k)) nodesByFrame.set(k, []);
      nodesByFrame.get(k)!.push(n);
    }
  }
  const shapesByFrame = new Map<string | null, ShapeRow[]>();
  const shapesByGroup = new Map<string, ShapeRow[]>();
  for (const s of ctx.shapes) {
    if (s.canvasGroupId) {
      if (!shapesByGroup.has(s.canvasGroupId)) shapesByGroup.set(s.canvasGroupId, []);
      shapesByGroup.get(s.canvasGroupId)!.push(s);
    } else {
      const k = s.parentFrameId ?? null;
      if (!shapesByFrame.has(k)) shapesByFrame.set(k, []);
      shapesByFrame.get(k)!.push(s);
    }
  }
  const instByFrame = new Map<string | null, InstanceRow[]>();
  const instByGroup = new Map<string, InstanceRow[]>();
  for (const i of ctx.instances) {
    if (i.groupId) {
      if (!instByGroup.has(i.groupId)) instByGroup.set(i.groupId, []);
      instByGroup.get(i.groupId)!.push(i);
    } else {
      const k = i.parentFrameId ?? null;
      if (!instByFrame.has(k)) instByFrame.set(k, []);
      instByFrame.get(k)!.push(i);
    }
  }

  function frameHasChildren(f: FrameRow): boolean {
    return (
      (framesByParent.get(f.id)?.length ?? 0) > 0 ||
      (groupsByFrame.get(f.id)?.length ?? 0) > 0 ||
      (nodesByFrame.get(f.id)?.length ?? 0) > 0 ||
      (shapesByFrame.get(f.id)?.length ?? 0) > 0 ||
      (instByFrame.get(f.id)?.length ?? 0) > 0
    );
  }
  function groupHasChildren(g: GroupRow): boolean {
    return (
      (nodesByGroup.get(g.id)?.length ?? 0) > 0 ||
      (shapesByGroup.get(g.id)?.length ?? 0) > 0 ||
      (instByGroup.get(g.id)?.length ?? 0) > 0
    );
  }

  // Per-parent emit. Mixes frames + groups + leaves at every depth, ordered
  // by their stored z/zIndex.
  function emitFrameChildren(parentFrameId: string | null, depth: number): void {
    type Combined =
      | { tag: "frame"; row: FrameRow; z: number }
      | { tag: "group"; row: GroupRow; z: number }
      | { tag: "node"; row: NodeRow; z: number }
      | { tag: "shape"; row: ShapeRow; z: number }
      | { tag: "instance"; row: InstanceRow; z: number };
    const merged: Combined[] = [];
    for (const f of framesByParent.get(parentFrameId) ?? [])
      merged.push({ tag: "frame", row: f, z: f.z ?? 0 });
    for (const g of groupsByFrame.get(parentFrameId) ?? [])
      merged.push({ tag: "group", row: g, z: g.z ?? 0 });
    for (const n of nodesByFrame.get(parentFrameId) ?? [])
      merged.push({ tag: "node", row: n, z: n.zIndex ?? 0 });
    for (const s of shapesByFrame.get(parentFrameId) ?? [])
      merged.push({ tag: "shape", row: s, z: s.zIndex ?? 0 });
    for (const i of instByFrame.get(parentFrameId) ?? [])
      merged.push({ tag: "instance", row: i, z: i.z ?? 0 });
    merged.sort((a, b) => a.z - b.z);
    for (const it of merged) {
      if (it.tag === "frame") {
        const f = it.row;
        const hasKids = frameHasChildren(f);
        out.push({ kind: "frame", id: f.id, row: f, depth, hasChildren: hasKids });
        if (hasKids && expanded.has(f.id)) emitFrameChildren(f.id, depth + 1);
      } else if (it.tag === "group") {
        const g = it.row;
        const hasKids = groupHasChildren(g);
        out.push({ kind: "group", id: g.id, row: g, depth, hasChildren: hasKids });
        if (hasKids && expanded.has(g.id)) emitGroupChildren(g.id, depth + 1);
      } else if (it.tag === "node") {
        out.push({ kind: "node", id: it.row.id, row: it.row, depth, hasChildren: false });
      } else if (it.tag === "shape") {
        out.push({ kind: "shape", id: it.row.id, row: it.row, depth, hasChildren: false });
      } else {
        out.push({
          kind: "instance",
          id: it.row.id,
          row: it.row,
          depth,
          hasChildren: false,
        });
      }
    }
  }

  function emitGroupChildren(groupId: string, depth: number): void {
    const merged: Array<
      | { tag: "node"; row: NodeRow; z: number }
      | { tag: "shape"; row: ShapeRow; z: number }
      | { tag: "instance"; row: InstanceRow; z: number }
    > = [];
    for (const n of nodesByGroup.get(groupId) ?? [])
      merged.push({ tag: "node", row: n, z: n.zIndex ?? 0 });
    for (const s of shapesByGroup.get(groupId) ?? [])
      merged.push({ tag: "shape", row: s, z: s.zIndex ?? 0 });
    for (const i of instByGroup.get(groupId) ?? [])
      merged.push({ tag: "instance", row: i, z: i.z ?? 0 });
    merged.sort((a, b) => a.z - b.z);
    for (const it of merged) {
      if (it.tag === "node") {
        out.push({ kind: "node", id: it.row.id, row: it.row, depth, hasChildren: false });
      } else if (it.tag === "shape") {
        out.push({ kind: "shape", id: it.row.id, row: it.row, depth, hasChildren: false });
      } else {
        out.push({
          kind: "instance",
          id: it.row.id,
          row: it.row,
          depth,
          hasChildren: false,
        });
      }
    }
  }

  emitFrameChildren(null, 0);
  // also use sortByZ to keep import live for future use (no-op call here)
  void sortByZ;
  return out;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const SHAPE_DISPLAY_NAMES: Record<string, string> = {
  box: "Box",
  ellipse: "Ellipse",
  line: "Line",
  arrow: "Arrow",
  text: "Text",
  freehand: "Freehand",
};

export type CanvasLayersPanelProps = {
  canvasId: string;
  data: CanvasHydratePayload;
  selected: LayerSelectionRef[];
  onSelect: (refs: LayerSelectionRef[], opts: { additive: boolean }) => void;
};

export const CanvasLayersPanel = memo(function CanvasLayersPanel({
  canvasId,
  data,
  selected,
  onSelect,
}: CanvasLayersPanelProps) {
  const utils = trpc.useUtils();

  const setHidden = trpc.canvas.layerSetHidden.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: () => utils.canvas.hydrate.invalidate({ id: canvasId }),
  });
  const setLocked = trpc.canvas.layerSetLocked.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: () => utils.canvas.hydrate.invalidate({ id: canvasId }),
  });
  const rename = trpc.canvas.layerRename.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: () => utils.canvas.hydrate.invalidate({ id: canvasId }),
  });
  const reorder = trpc.canvas.layerReorder.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: () => utils.canvas.hydrate.invalidate({ id: canvasId }),
  });

  const ctx = useMemo<BuildContext>(
    () => ({
      frames: (data?.frames ?? []) as FrameRow[],
      groups: (data?.groups ?? []) as GroupRow[],
      nodes: (data?.nodes ?? []) as NodeRow[],
      shapes: (data?.shapes ?? []) as ShapeRow[],
      instances: (data?.componentInstances ?? []) as InstanceRow[],
    }),
    [data],
  );

  // Default-expand everything so the operator sees the full structure on
  // first mount. Collapse state is in-memory only (intentional — the panel
  // is small enough that persisting expand/collapse adds noise).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (!data) return;
    const next = new Set<string>();
    for (const f of ctx.frames) next.add(f.id);
    for (const g of ctx.groups) next.add(g.id);
    setExpanded(next);
    seededRef.current = true;
  }, [data, ctx.frames, ctx.groups]);

  const rows = useMemo(() => buildTree(ctx, expanded), [ctx, expanded]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // -- rename ----------------------------------------------------------
  const [editing, setEditing] = useState<{
    kind: "frame" | "group" | "component";
    id: string;
  } | null>(null);
  const [draftName, setDraftName] = useState("");

  function commitRename() {
    if (!editing) return;
    const trimmed = draftName.trim();
    if (trimmed) {
      rename.mutate({ kind: editing.kind, id: editing.id, name: trimmed });
    }
    setEditing(null);
    setDraftName("");
  }

  // -- drag-to-reorder -------------------------------------------------
  // We track only same-parent reorders. Drop on a sibling = insert before
  // that sibling. The parent context lookup is implicit via row.depth +
  // ancestors; we resolve parentFrameId from the row itself for nodes,
  // shapes, instances, frames (parentFrameId) and groups (parentFrameId).
  const dragRef = useRef<{ kind: LayerKind; id: string; parentFrameId: string | null } | null>(
    null,
  );

  function parentFrameIdFor(row: TreeRow): string | null {
    if (row.kind === "frame") return row.row.parentFrameId;
    if (row.kind === "group") return row.row.parentFrameId;
    if (row.kind === "node") return row.row.parentFrameId;
    if (row.kind === "shape") return row.row.parentFrameId;
    if (row.kind === "instance") return row.row.parentFrameId;
    return null;
  }

  // Collect every sibling row id at a given parent — used to compute the
  // new ordered list on drop.
  function siblingIds(parentFrameId: string | null): TreeRow[] {
    const sibs: TreeRow[] = [];
    function pushFrameChildren(pfid: string | null): void {
      const m = ctx.frames.filter((f) => (f.parentFrameId ?? null) === pfid);
      const g = ctx.groups.filter((x) => (x.parentFrameId ?? null) === pfid);
      const n = ctx.nodes.filter(
        (x) => !x.groupId && (x.parentFrameId ?? null) === pfid,
      );
      const s = ctx.shapes.filter(
        (x) => !x.canvasGroupId && (x.parentFrameId ?? null) === pfid,
      );
      const i = ctx.instances.filter(
        (x) => !x.groupId && (x.parentFrameId ?? null) === pfid,
      );
      type Combined = { kind: LayerKind; id: string; z: number };
      const merged: Combined[] = [
        ...m.map((r) => ({ kind: "frame" as const, id: r.id, z: r.z ?? 0 })),
        ...g.map((r) => ({ kind: "group" as const, id: r.id, z: r.z ?? 0 })),
        ...n.map((r) => ({ kind: "node" as const, id: r.id, z: r.zIndex ?? 0 })),
        ...s.map((r) => ({ kind: "shape" as const, id: r.id, z: r.zIndex ?? 0 })),
        ...i.map((r) => ({ kind: "instance" as const, id: r.id, z: r.z ?? 0 })),
      ];
      merged.sort((a, b) => a.z - b.z);
      for (const it of merged) {
        if (it.kind === "frame") {
          const row = ctx.frames.find((x) => x.id === it.id)!;
          sibs.push({ kind: "frame", id: it.id, row, depth: 0, hasChildren: false });
        } else if (it.kind === "group") {
          const row = ctx.groups.find((x) => x.id === it.id)!;
          sibs.push({ kind: "group", id: it.id, row, depth: 0, hasChildren: false });
        } else if (it.kind === "node") {
          const row = ctx.nodes.find((x) => x.id === it.id)!;
          sibs.push({ kind: "node", id: it.id, row, depth: 0, hasChildren: false });
        } else if (it.kind === "shape") {
          const row = ctx.shapes.find((x) => x.id === it.id)!;
          sibs.push({ kind: "shape", id: it.id, row, depth: 0, hasChildren: false });
        } else {
          const row = ctx.instances.find((x) => x.id === it.id)!;
          sibs.push({ kind: "instance", id: it.id, row, depth: 0, hasChildren: false });
        }
      }
    }
    pushFrameChildren(parentFrameId);
    return sibs;
  }

  function handleDropOn(targetRow: TreeRow) {
    const src = dragRef.current;
    dragRef.current = null;
    if (!src) return;
    const tgtParent = parentFrameIdFor(targetRow);
    if (src.parentFrameId !== tgtParent) {
      // Cross-parent moves not supported in v1; layerReorder is sibling-only.
      return;
    }
    if (src.id === targetRow.id) return;
    const sibs = siblingIds(tgtParent);
    const filtered = sibs.filter((r) => r.id !== src.id);
    const tgtIdx = filtered.findIndex((r) => r.id === targetRow.id);
    if (tgtIdx < 0) return;
    filtered.splice(tgtIdx, 0, sibs.find((r) => r.id === src.id) ?? filtered[0]);
    reorder.mutate({
      canvasId,
      parentFrameId: tgtParent,
      ordered: filtered.map((r) => ({ kind: r.kind, id: r.id })),
    });
  }

  // -- selection ------------------------------------------------------
  const selectedSet = useMemo(() => {
    const m = new Set<string>();
    for (const s of selected) m.add(`${s.kind}:${s.id}`);
    return m;
  }, [selected]);

  if (!data) {
    return (
      <div className="px-3 py-4 text-meta text-muted-foreground">Loading layers…</div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="px-3 py-4 text-meta text-muted-foreground">
        Empty canvas. Draw shapes or drop entities to populate the layer tree.
      </div>
    );
  }

  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 py-1.5">
      {rows.map((r) => (
        <LayerRow
          key={`${r.kind}:${r.id}`}
          row={r}
          isExpanded={expanded.has(r.id)}
          selected={selectedSet.has(`${r.kind}:${r.id}`)}
          editing={
            editing != null &&
            editing.id === r.id &&
            ((editing.kind === "frame" && r.kind === "frame") ||
              (editing.kind === "group" && r.kind === "group"))
          }
          draftName={draftName}
          onDraftNameChange={setDraftName}
          onCommitRename={commitRename}
          onStartEdit={(kind) => {
            if (r.kind === "frame") {
              setEditing({ kind: "frame", id: r.id });
              setDraftName(r.row.name);
            } else if (r.kind === "group") {
              setEditing({ kind: "group", id: r.id });
              setDraftName(r.row.name);
            }
            // component is the workspace-level component; the layers tree
            // doesn't surface bare components — only instances. Inline
            // rename for components happens in the Components panel.
            void kind;
          }}
          onToggleExpand={() => toggle(r.id)}
          onToggleHide={() => {
            const hidden = !!(
              ("hiddenAt" in r.row && r.row.hiddenAt != null) || false
            );
            setHidden.mutate({ kind: r.kind, id: r.id, hidden: !hidden });
          }}
          onToggleLock={() => {
            const locked = !!(
              ("lockedAt" in r.row && r.row.lockedAt != null) || false
            );
            setLocked.mutate({ kind: r.kind, id: r.id, locked: !locked });
          }}
          onClick={(e) => {
            const additive = e.shiftKey || e.metaKey || e.ctrlKey;
            const ref: LayerSelectionRef = { kind: r.kind, id: r.id };
            if (additive) {
              const next = selected.some((s) => s.kind === ref.kind && s.id === ref.id)
                ? selected.filter((s) => !(s.kind === ref.kind && s.id === ref.id))
                : [...selected, ref];
              onSelect(next, { additive: true });
            } else {
              onSelect([ref], { additive: false });
            }
          }}
          onDragStart={() => {
            dragRef.current = {
              kind: r.kind,
              id: r.id,
              parentFrameId: parentFrameIdFor(r),
            };
          }}
          onDragOver={(e) => {
            const src = dragRef.current;
            if (!src) return;
            if (src.parentFrameId !== parentFrameIdFor(r)) return;
            e.preventDefault();
          }}
          onDrop={() => handleDropOn(r)}
        />
      ))}
    </ul>
  );
});

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

type LayerRowProps = {
  row: TreeRow;
  isExpanded: boolean;
  selected: boolean;
  editing: boolean;
  draftName: string;
  onDraftNameChange: (v: string) => void;
  onCommitRename: () => void;
  onStartEdit: (kind: "frame" | "group" | "component") => void;
  onToggleExpand: () => void;
  onToggleHide: () => void;
  onToggleLock: () => void;
  onClick: (e: React.MouseEvent) => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
};

function LayerRow({
  row,
  isExpanded,
  selected,
  editing,
  draftName,
  onDraftNameChange,
  onCommitRename,
  onStartEdit,
  onToggleExpand,
  onToggleHide,
  onToggleLock,
  onClick,
  onDragStart,
  onDragOver,
  onDrop,
}: LayerRowProps) {
  const hidden =
    "hiddenAt" in row.row ? row.row.hiddenAt != null : false;
  const locked =
    "lockedAt" in row.row ? row.row.lockedAt != null : false;

  const icon: ReactNode = (() => {
    if (row.kind === "frame") return <Square className="h-3 w-3" />;
    if (row.kind === "group") return <GroupIcon className="h-3 w-3" />;
    if (row.kind === "node") return <FileText className="h-3 w-3" />;
    if (row.kind === "shape") return <Pencil className="h-3 w-3" />;
    return <Package className="h-3 w-3" />;
  })();

  const label = (() => {
    if (row.kind === "frame") return row.row.name || "Frame";
    if (row.kind === "group") return row.row.name || "Group";
    if (row.kind === "node") return row.row.ref?.label ?? "Card";
    if (row.kind === "shape")
      return row.row.text?.trim() || SHAPE_DISPLAY_NAMES[row.row.kind] || "Shape";
    return "Component";
  })();

  const canRename = row.kind === "frame" || row.kind === "group";

  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={onDragOver}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      className={cn(
        "group flex items-center gap-1 rounded-sm px-1 py-0.5 text-xs transition-colors duration-150",
        selected
          ? "bg-ember/15 text-foreground"
          : "text-foreground hover:bg-subtle",
        hidden ? "text-muted-foreground/60" : "",
      )}
      style={{ paddingLeft: 4 + row.depth * 12 }}
      onClick={onClick}
      onDoubleClick={(e) => {
        if (!canRename) return;
        e.stopPropagation();
        onStartEdit(row.kind === "frame" ? "frame" : "group");
      }}
    >
      <button
        type="button"
        className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
        onClick={(e) => {
          e.stopPropagation();
          if (row.hasChildren) onToggleExpand();
        }}
        aria-label={row.hasChildren ? "Toggle expand" : undefined}
        tabIndex={row.hasChildren ? 0 : -1}
      >
        {row.hasChildren ? (
          isExpanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )
        ) : (
          <span className="block h-3 w-3" />
        )}
      </button>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      {editing && canRename ? (
        <input
          autoFocus
          value={draftName}
          onChange={(e) => onDraftNameChange(e.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitRename();
            if (e.key === "Escape") onCommitRename();
            e.stopPropagation();
          }}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 rounded border border-border bg-card px-1 py-0 text-xs"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate" title={label}>
          {label}
        </span>
      )}
      <button
        type="button"
        className={cn(
          "shrink-0 text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100",
          (hidden || locked) && "opacity-100",
        )}
        onClick={(e) => {
          e.stopPropagation();
          onToggleLock();
        }}
        aria-label={locked ? "Unlock layer" : "Lock layer"}
        title={locked ? "Unlock" : "Lock"}
      >
        {locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
      </button>
      <button
        type="button"
        className={cn(
          "shrink-0 text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100",
          hidden && "opacity-100",
        )}
        onClick={(e) => {
          e.stopPropagation();
          onToggleHide();
        }}
        aria-label={hidden ? "Show layer" : "Hide layer"}
        title={hidden ? "Show" : "Hide"}
      >
        {hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
      </button>
    </li>
  );
}
