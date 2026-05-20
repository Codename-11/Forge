"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ChevronLeft,
  ExternalLink,
  GitBranch,
  Image as ImageIcon,
  Layers,
  Maximize2,
  MessageCircle,
  Minimize2,
  Plus,
  Settings,
  StickyNote,
  Trash2,
  Bot,
  User as UserIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { Confirm } from "@/components/ui/modal";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { useRealtime } from "@/hooks/use-realtime";
import { relativeTime } from "@/lib/utils";
import { ChatMarkdown } from "@/components/mission-control/chat-markdown";
import { useAttachmentLightbox } from "@/components/attachments/attachment-lightbox";
import {
  CanvasPreview,
  canvasKindForArtifact,
  canvasKindForAttachment,
  type CanvasPreviewKind,
} from "@/components/canvas/canvas-preview";
import { CanvasSettingsModal } from "@/components/canvas/canvas-settings-modal";
import {
  CanvasShapes,
  type CanvasShapeRow,
  type ShapeKind,
} from "@/components/canvas/canvas-shapes";
import {
  CanvasToolbar,
  DEFAULT_STYLE_STATE,
  type StyleState,
  type ToolKind,
} from "@/components/canvas/canvas-toolbar";
import { routeEdge, type HandleSide, type Rect } from "@/lib/canvas-routing";

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 280;
const SIDEBAR_STORAGE_PREFIX = "forge.canvas.sidebar.";
const GRID_SIZE_PX = 20;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

const PRESENCE_PUBLISH_HZ = 10;
const PRESENCE_STALE_MS = 5_000;

type HydratedNode = {
  id: string;
  canvasId: string;
  targetType: string;
  targetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  collapsed: boolean;
  viewMode: string | null;
  meta?: Record<string, unknown> | null;
  ref: {
    type: string;
    id: string;
    missing: boolean;
    label: string;
    subLabel?: string;
    url?: string;
    meta?: Record<string, unknown>;
  };
};

type Viewport = { x: number; y: number; zoom: number };

type RemoteCursor = {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  updatedAt: number;
};

type DragPayload =
  | { kind: "node"; nodeId: string; offsetX: number; offsetY: number }
  | { kind: "resize"; nodeId: string; startX: number; startY: number; startW: number; startH: number }
  | {
      kind: "shape-move";
      primaryShapeId: string;
      // ids of all shapes (and grouped siblings) that should ride along.
      shapeIds: string[];
      // canvas-space offset from pointer to each shape's (x, y).
      offsetsByShape: Record<string, { ox: number; oy: number }>;
    };

type ShapeDraft = {
  kind: ShapeKind;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  path: Array<[number, number]>;
  text?: string;
};

type RubberBand = { startX: number; startY: number; endX: number; endY: number };

type EdgeRow = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label: string | null;
  kind: string | null;
  meta: Record<string, unknown> | null;
};

type EdgeMeta = {
  fromHandle?: HandleSide;
  toHandle?: HandleSide;
};

type ConnectorDraft = {
  fromNodeId: string;
  fromHandle: HandleSide;
  toX: number;
  toY: number;
};

const EDGE_KIND_STYLES: Array<{ kind: string; label: string; dash?: string }> = [
  { kind: "solid", label: "Solid" },
  { kind: "dashed", label: "Dashed", dash: "6 4" },
  { kind: "dotted", label: "Dotted", dash: "2 4" },
  { kind: "curved", label: "Curved" },
];

type SelectedRef = { kind: "node" | "shape"; id: string };

// Per-node visual overlay applied during a drag/resize. Ref-driven so the
// pointer-move stream doesn't fire React state updates 60+ times/sec; a
// single `dragRev` counter coalesces re-renders to one per animation frame.
type DragOverride = { x?: number; y?: number; width?: number; height?: number };

type ConfirmState =
  | { kind: "remove-card"; id: string }
  | {
      kind: "convert";
      stepCount: number;
      skipped: Array<{ targetType: string; reason: string }>;
    }
  | null;

const PRESENCE_COLORS = ["#d97706", "#10b981", "#06b6d4", "#a855f7", "#ec4899", "#84cc16"];

function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length];
}

/**
 * Canvas viewer — pan/zoom surface with node renderers per `targetType`.
 * Augments the v0 viewer with:
 *  - Chat-thread + note (artifact) renderers
 *  - Drag-from-sidebar drop zone (HTML5 dnd, ember ring while active)
 *  - Lane bands (rendered from `node.meta.lane`)
 *  - Convert-to-plan button (gracefully disabled if Agent H hasn't shipped)
 *  - Remote presence cursors via the `canvas-presence` SSE channel
 *  - Subtle ember-glow pulse on RUNNING/ACTIVE live nodes
 */
export default function CanvasViewerPage() {
  const params = useParams<{ slug: string; canvasId: string }>();
  const router = useRouter();
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const meQ = trpc.user.me.useQuery(undefined, { staleTime: 5 * 60_000 });
  const myUserId = meQ.data?.id ?? null;

  const { data, isLoading } = trpc.canvas.hydrate.useQuery({ id: params.canvasId });

  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [panning, setPanning] = useState(false);
  const panStart = useRef<{ vx: number; vy: number; mx: number; my: number } | null>(null);
  const dragNode = useRef<DragPayload | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [openPicker, setOpenPicker] = useState(false);
  const [openSidebar, setOpenSidebar] = useState(true);
  const [openSettings, setOpenSettings] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [editingLaneFor, setEditingLaneFor] = useState<string | null>(null);
  const [editingNoteFor, setEditingNoteFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  // -- Phase 2: drawing primitives + selection ------------------------
  const [activeTool, setActiveTool] = useState<ToolKind>("select");
  const [toolbarStyle, setToolbarStyle] = useState<StyleState>(DEFAULT_STYLE_STATE);
  // Unified selection set; entries tagged by kind so node-drag and
  // shape-drag handlers can pull just their slice.
  const [selected, setSelected] = useState<SelectedRef[]>([]);
  // Reserved for future node-selection styling (Phase 2 keyboard +
  // group-drag is shape-first; node selection plumbing can land later).
  const _selectedNodeIds = useMemo(
    () => new Set(selected.filter((s) => s.kind === "node").map((s) => s.id)),
    [selected],
  );
  const selectedShapeIds = useMemo(
    () => new Set(selected.filter((s) => s.kind === "shape").map((s) => s.id)),
    [selected],
  );
  const activeToolRef = useRef<ToolKind>(activeTool);
  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);
  const toolbarStyleRef = useRef<StyleState>(toolbarStyle);
  useEffect(() => {
    toolbarStyleRef.current = toolbarStyle;
  }, [toolbarStyle]);

  // Live drag overrides for shapes — mirrors the node `dragOverridesRef`
  // pattern. Keyed by shape id; value is delta in canvas-space.
  const shapeDragOverridesRef = useRef<Map<string, { dx: number; dy: number }>>(new Map());

  // Ghost shape preview during a draw gesture (ref-driven, paint-coalesced).
  const shapeDraftRef = useRef<ShapeDraft | null>(null);
  const [shapeDraftRev, setShapeDraftRev] = useState(0);
  const scheduleShapeDraftRender = useCallback(() => {
    setShapeDraftRev((r) => r + 1);
  }, []);

  // Rubber-band marquee for select-tool drags on background.
  const rubberBandRef = useRef<RubberBand | null>(null);
  const [rubberBandRev, setRubberBandRev] = useState(0);

  // Phase 3: drag-to-connect handle preview. Ref-driven so pointermove
  // doesn't cycle through React state; a rev counter coalesces paints.
  const connectorDraftRef = useRef<ConnectorDraft | null>(null);
  const [connectorRev, setConnectorRev] = useState(0);
  const scheduleConnectorRender = useCallback(() => {
    setConnectorRev((r) => r + 1);
  }, []);
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // Stable ref to the latest `surfaceToCanvas` so handlers defined before
  // it (e.g. background-mousedown) can call through without re-binding.
  const surfaceToCanvasRef = useRef<((clientX: number, clientY: number) => { x: number; y: number }) | null>(null);

  // Sidebar width — persisted per workspace slug. `sidebarRef` is used by
  // the drag handler so live moves only touch the DOM, not React state.
  const sidebarStorageKey = `${SIDEBAR_STORAGE_PREFIX}${ws.slug}`;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
    const raw = window.localStorage.getItem(sidebarStorageKey);
    const parsed = raw ? Number(raw) : NaN;
    if (!Number.isFinite(parsed)) return SIDEBAR_DEFAULT_WIDTH;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, parsed));
  });
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const [sidebarResizing, setSidebarResizing] = useState(false);

  // View settings — persisted per workspace slug so the modal sticks. Grid
  // dots and presence cursors honor these toggles; snap-to-grid quantizes
  // the active drag position.
  const viewStorageKey = `forge.canvas.view.${ws.slug}`;
  type CanvasViewPrefs = { showGrid: boolean; snapToGrid: boolean; presenceVisible: boolean };
  const defaultViewPrefs: CanvasViewPrefs = {
    showGrid: true,
    snapToGrid: false,
    presenceVisible: true,
  };
  const [viewPrefs, setViewPrefs] = useState<CanvasViewPrefs>(() => {
    if (typeof window === "undefined") return defaultViewPrefs;
    try {
      const raw = window.localStorage.getItem(viewStorageKey);
      if (!raw) return defaultViewPrefs;
      const parsed = JSON.parse(raw) as Partial<CanvasViewPrefs>;
      return { ...defaultViewPrefs, ...parsed };
    } catch {
      return defaultViewPrefs;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(viewStorageKey, JSON.stringify(viewPrefs));
    } catch {
      /* ignore quota */
    }
  }, [viewPrefs, viewStorageKey]);
  const setShowGrid = useCallback(
    (v: boolean) => setViewPrefs((p) => ({ ...p, showGrid: v })),
    [],
  );
  const setSnapToGrid = useCallback(
    (v: boolean) => setViewPrefs((p) => ({ ...p, snapToGrid: v })),
    [],
  );
  const setPresenceVisible = useCallback(
    (v: boolean) => setViewPrefs((p) => ({ ...p, presenceVisible: v })),
    [],
  );
  // Refs so the drag-move and mousemove publish reads stay in sync with the
  // latest toggle without re-binding global listeners.
  const snapToGridRef = useRef(viewPrefs.snapToGrid);
  const presenceVisibleRef = useRef(viewPrefs.presenceVisible);
  useEffect(() => {
    snapToGridRef.current = viewPrefs.snapToGrid;
  }, [viewPrefs.snapToGrid]);
  useEffect(() => {
    presenceVisibleRef.current = viewPrefs.presenceVisible;
  }, [viewPrefs.presenceVisible]);

  // Ref-based drag overrides — see DragOverride type. `dragRev` is bumped
  // once per rAF tick during an active drag so we re-render at paint
  // cadence instead of mousemove cadence.
  const dragOverridesRef = useRef<Map<string, DragOverride>>(new Map());
  const [dragRev, setDragRev] = useState(0);
  const dragRafRef = useRef<number | null>(null);
  const draggingRef = useRef(false);

  // Ref-based remote cursors so SSE ticks don't re-render the whole
  // node tree — only the cursor overlay reads `cursorsRev`.
  const remoteCursorsRef = useRef<Map<string, RemoteCursor>>(new Map());
  const [cursorsRev, setCursorsRev] = useState(0);
  const cursorsRafRef = useRef<number | null>(null);
  const scheduleCursorsRender = useCallback(() => {
    if (cursorsRafRef.current != null) return;
    cursorsRafRef.current = requestAnimationFrame(() => {
      cursorsRafRef.current = null;
      setCursorsRev((r) => r + 1);
    });
  }, []);

  useEffect(() => {
    if (data?.canvas.viewport) {
      const v = data.canvas.viewport as Partial<Viewport>;
      setViewport({
        x: typeof v.x === "number" ? v.x : 0,
        y: typeof v.y === "number" ? v.y : 0,
        zoom: typeof v.zoom === "number" ? v.zoom : 1,
      });
    }
  }, [data?.canvas.viewport]);

  const patchNode = trpc.canvas.patchNode.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: () => utils.canvas.hydrate.invalidate({ id: params.canvasId }),
  });

  const patchNodeMeta = trpc.canvas.patchNodeMeta.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: () => utils.canvas.hydrate.invalidate({ id: params.canvasId }),
  });

  const setViewportMut = trpc.canvas.setViewport.useMutation({
    onError: (e) => toast.error(e.message),
  });

  const removeNode = trpc.canvas.removeNode.useMutation({
    onSuccess: () => utils.canvas.hydrate.invalidate({ id: params.canvasId }),
    onError: (e) => toast.error(e.message),
  });

  const addNode = trpc.canvas.addNode.useMutation({
    onSuccess: () => {
      toast.success("Card added");
      utils.canvas.hydrate.invalidate({ id: params.canvasId });
    },
    onError: (e) => toast.error(e.message),
  });

  const addEdge = trpc.canvas.addEdge.useMutation({
    onSuccess: () => utils.canvas.hydrate.invalidate({ id: params.canvasId }),
    onError: (e) => toast.error(e.message),
  });
  const removeEdge = trpc.canvas.removeEdge.useMutation({
    onSuccess: () => utils.canvas.hydrate.invalidate({ id: params.canvasId }),
    onError: (e) => toast.error(e.message),
  });
  // edgePatch ships in Phase 3; older backends won't have it. Probe via the
  // any-router so the page degrades gracefully on a stale server.
  const edgePatchAny = (
    (trpc as unknown as Record<string, unknown>).canvas as Record<string, unknown> | undefined
  )?.edgePatch as
    | {
        useMutation: (opts?: unknown) => {
          mutate: (input: {
            id: string;
            label?: string | null;
            kind?: string | null;
            meta?: unknown;
          }) => void;
          isPending: boolean;
        };
      }
    | undefined;
  const edgePatchMut = edgePatchAny?.useMutation({
    onSuccess: () => utils.canvas.hydrate.invalidate({ id: params.canvasId }),
    onError: (e: { message: string }) => toast.error(e.message),
  });

  // Optional helpers from Agent H — gracefully disabled if not on the proxy.
  const canvasRouterAny = (trpc as unknown as Record<string, unknown>).canvas as
    | Record<string, unknown>
    | undefined;
  const convertToPlanAny = canvasRouterAny?.convertToPlan as
    | {
        useMutation: (opts?: unknown) => {
          mutate: (input: { canvasId: string }) => void;
          isPending: boolean;
        };
      }
    | undefined;
  const convertToPlanAvailable = Boolean(convertToPlanAny);
  const convertToPlanMut = convertToPlanAny?.useMutation({
    onSuccess: (result: { planId?: string } | undefined) => {
      const planId = result?.planId;
      if (planId) {
        toast.success("Plan created from canvas");
        router.push(`/w/${ws.slug}/plans/${planId}`);
      } else {
        toast.error("Convert returned no plan id.");
      }
    },
    onError: (e: { message: string }) => toast.error(e.message),
  }) as
    | { mutate: (input: { canvasId: string }) => void; isPending: boolean }
    | undefined;

  const addNoteAny = canvasRouterAny?.addNote as
    | {
        useMutation: (opts?: unknown) => {
          mutate: (input: { canvasId: string; body: string; x: number; y: number }) => void;
          isPending: boolean;
        };
      }
    | undefined;
  const addNoteMut = addNoteAny?.useMutation({
    onSuccess: () => {
      utils.canvas.hydrate.invalidate({ id: params.canvasId });
    },
    onError: (e: { message: string }) => toast.error(e.message),
  }) as
    | { mutate: (input: { canvasId: string; body: string; x: number; y: number }) => void; isPending: boolean }
    | undefined;

  // Phase 2: shape mutations. Backend may expose either flat (`shapeAdd`)
  // or namespaced (`shape.add`) — probe both, fall through gracefully.
  type ShapeAddInput = {
    canvasId: string;
    kind: ShapeKind;
    x: number;
    y: number;
    width?: number;
    height?: number;
    path?: Array<[number, number]> | unknown;
    style?: Record<string, unknown>;
    text?: string;
    groupId?: string;
  };
  type ShapePatchInput = {
    id: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    path?: Array<[number, number]> | unknown;
    style?: Record<string, unknown>;
    text?: string;
    groupId?: string | null;
    zIndex?: number;
  };
  type ShapeBulkPatchInput = {
    ids: string[];
    style?: Record<string, unknown>;
    groupId?: string | null;
    dxdy?: { dx: number; dy: number };
  };
  type ShapeRemoveInput = { id: string };
  type ShapeMutationHook<TInput, TOutput> = {
    useMutation: (opts?: {
      onSuccess?: (data: TOutput, vars: TInput) => void;
      onError?: (e: { message: string }) => void;
    }) => {
      mutate: (input: TInput) => void;
      mutateAsync: (input: TInput) => Promise<TOutput>;
      isPending: boolean;
    };
  };
  const shapeAddAny =
    (canvasRouterAny?.shapeAdd as ShapeMutationHook<ShapeAddInput, { id: string }> | undefined) ??
    ((canvasRouterAny?.shape as Record<string, unknown> | undefined)?.add as
      | ShapeMutationHook<ShapeAddInput, { id: string }>
      | undefined);
  const shapePatchAny =
    (canvasRouterAny?.shapePatch as ShapeMutationHook<ShapePatchInput, { ok: true }> | undefined) ??
    ((canvasRouterAny?.shape as Record<string, unknown> | undefined)?.patch as
      | ShapeMutationHook<ShapePatchInput, { ok: true }>
      | undefined);
  const shapeRemoveAny =
    (canvasRouterAny?.shapeRemove as ShapeMutationHook<ShapeRemoveInput, { ok: true }> | undefined) ??
    ((canvasRouterAny?.shape as Record<string, unknown> | undefined)?.remove as
      | ShapeMutationHook<ShapeRemoveInput, { ok: true }>
      | undefined);
  const shapeBulkPatchAny =
    (canvasRouterAny?.shapeBulkPatch as
      | ShapeMutationHook<ShapeBulkPatchInput, { ok: true; count: number }>
      | undefined) ??
    ((canvasRouterAny?.shape as Record<string, unknown> | undefined)?.bulkPatch as
      | ShapeMutationHook<ShapeBulkPatchInput, { ok: true; count: number }>
      | undefined);

  const invalidateHydrate = useCallback(() => {
    utils.canvas.hydrate.invalidate({ id: params.canvasId });
  }, [utils, params.canvasId]);

  const shapeAddMut = shapeAddAny?.useMutation({
    onSuccess: () => invalidateHydrate(),
    onError: (e) => toast.error(e.message),
  });
  const shapePatchMut = shapePatchAny?.useMutation({
    onSuccess: () => invalidateHydrate(),
    onError: (e) => toast.error(e.message),
  });
  const shapeRemoveMut = shapeRemoveAny?.useMutation({
    onSuccess: () => invalidateHydrate(),
    onError: (e) => toast.error(e.message),
  });
  const shapeBulkPatchMut = shapeBulkPatchAny?.useMutation({
    onSuccess: () => invalidateHydrate(),
    onError: (e) => toast.error(e.message),
  });

  const nodes = useMemo(() => (data?.nodes ?? []) as HydratedNode[], [data?.nodes]);
  const edges = useMemo(() => {
    const raw = (data?.edges ?? []) as Array<{
      id: string;
      fromNodeId: string;
      toNodeId: string;
      label: string | null;
      kind: string | null;
      meta?: unknown;
    }>;
    return raw.map((e) => ({
      id: e.id,
      fromNodeId: e.fromNodeId,
      toNodeId: e.toNodeId,
      label: e.label,
      kind: e.kind,
      meta:
        e.meta && typeof e.meta === "object" && !Array.isArray(e.meta)
          ? (e.meta as Record<string, unknown>)
          : null,
    })) as EdgeRow[];
  }, [data?.edges]);
  // Phase 2: shapes from extended hydrate. `?? []` guards a transient
  // window where the migration hasn't run yet — the field is absent
  // rather than empty until the backend agent's slice lands.
  const shapes = useMemo<CanvasShapeRow[]>(() => {
    const raw = (data as unknown as { shapes?: unknown })?.shapes;
    if (!Array.isArray(raw)) return [];
    return raw as CanvasShapeRow[];
  }, [data]);
  // Ref mirror so long-running pointer handlers read the latest shapes
  // without depending on a useEffect rebind.
  const shapesRef = useRef<CanvasShapeRow[]>(shapes);
  useEffect(() => {
    shapesRef.current = shapes;
  }, [shapes]);

  // Apply any active drag overrides on top of the server-hydrated nodes.
  // While no drag is active the override map is empty and the returned
  // array shares identity with `nodes` — so memoized children skip work.
  const displayNodes = useMemo(() => {
    const overrides = dragOverridesRef.current;
    if (overrides.size === 0) return nodes;
    return nodes.map((n) => {
      const ov = overrides.get(n.id);
      if (!ov) return n;
      return {
        ...n,
        x: ov.x ?? n.x,
        y: ov.y ?? n.y,
        width: ov.width ?? n.width,
        height: ov.height ?? n.height,
      };
    });
    // dragRev forces recomputation each rAF tick during a drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, dragRev]);

  // Apply shape-drag overrides (delta from origin) on top of hydrated shapes.
  const displayShapes = useMemo(() => {
    const overrides = shapeDragOverridesRef.current;
    if (overrides.size === 0) return shapes;
    return shapes.map((s) => {
      const ov = overrides.get(s.id);
      if (!ov) return s;
      return { ...s, x: s.x + ov.dx, y: s.y + ov.dy };
    });
    // dragRev forces recomputation each rAF tick during a drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, dragRev]);

  // -- Pan + zoom handlers --------------------------------------------

  // Map of canvas-space drag-set ids based on grouping. Given a primary
  // shape, returns the primary + every sibling with the same non-null
  // groupId. Pure — derived from `shapes` snapshot at call time.
  const expandGroupedShapes = useCallback(
    (primaryId: string): string[] => {
      const primary = shapes.find((s) => s.id === primaryId);
      if (!primary) return [primaryId];
      if (!primary.groupId) return [primaryId];
      const groupId = primary.groupId;
      return shapes.filter((s) => s.groupId === groupId).map((s) => s.id);
    },
    [shapes],
  );

  const onBackgroundMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-canvas-card]")) return;
    if ((e.target as HTMLElement).closest("[data-canvas-shape]")) return;
    if (editingLaneFor || editingNoteFor) return;
    const tool = activeToolRef.current;
    const drawKinds: ToolKind[] = ["box", "ellipse", "arrow", "line", "text", "freehand"];
    if (drawKinds.includes(tool)) {
      // Begin a draw gesture. Convert pointer to canvas-space; the
      // pointer-move handler updates the draft ref and rAF-paints.
      const { x, y } = surfaceToCanvasRef.current?.(e.clientX, e.clientY) ?? { x: 0, y: 0 };
      shapeDraftRef.current = {
        kind: tool as ShapeKind,
        startX: x,
        startY: y,
        endX: x,
        endY: y,
        path: tool === "freehand" ? [[0, 0]] : [],
      };
      scheduleShapeDraftRender();
      return;
    }
    if (tool === "select") {
      if (e.shiftKey) {
        // Rubber-band marquee (additive when shift held).
        const { x, y } = surfaceToCanvasRef.current?.(e.clientX, e.clientY) ?? { x: 0, y: 0 };
        rubberBandRef.current = { startX: x, startY: y, endX: x, endY: y };
        setRubberBandRev((r) => r + 1);
        return;
      }
      // Click on background with no modifier clears selection.
      if (selected.length > 0) setSelected([]);
      if (selectedEdgeId) setSelectedEdgeId(null);
    }
    // Default: pan.
    setPanning(true);
    panStart.current = {
      vx: viewport.x,
      vy: viewport.y,
      mx: e.clientX,
      my: e.clientY,
    };
  };

  useEffect(() => {
    if (!panning) return;
    const onMove = (e: MouseEvent) => {
      if (!panStart.current) return;
      const { vx, vy, mx, my } = panStart.current;
      setViewport((v) => ({
        ...v,
        x: vx + (e.clientX - mx),
        y: vy + (e.clientY - my),
      }));
    };
    const onUp = () => {
      setPanning(false);
      panStart.current = null;
      setViewportMut.mutate({ id: params.canvasId, viewport });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panning]);

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = -Math.sign(e.deltaY) * ZOOM_STEP;
    setViewport((v) => {
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom + delta));
      return { ...v, zoom: nextZoom };
    });
  };

  // -- Card drag (move + resize) -------------------------------------

  const onCardMouseDown = useCallback(
    (e: React.MouseEvent, node: HydratedNode) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      dragNode.current = {
        kind: "node",
        nodeId: node.id,
        offsetX: e.clientX - node.x * viewport.zoom - viewport.x,
        offsetY: e.clientY - node.y * viewport.zoom - viewport.y,
      };
      draggingRef.current = true;
    },
    [viewport.x, viewport.y, viewport.zoom],
  );

  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent, node: HydratedNode) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      dragNode.current = {
        kind: "resize",
        nodeId: node.id,
        startX: e.clientX,
        startY: e.clientY,
        startW: node.width,
        startH: node.height,
      };
      draggingRef.current = true;
    },
    [],
  );

  useEffect(() => {
    const scheduleDragRender = () => {
      if (dragRafRef.current != null) return;
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = null;
        setDragRev((r) => r + 1);
      });
    };

    const onMove = (e: MouseEvent) => {
      const drag = dragNode.current;
      if (!drag) return;
      const overrides = dragOverridesRef.current;
      if (drag.kind === "node") {
        const { nodeId, offsetX, offsetY } = drag;
        let newX = (e.clientX - viewport.x - offsetX) / viewport.zoom;
        let newY = (e.clientY - viewport.y - offsetY) / viewport.zoom;
        if (snapToGridRef.current) {
          newX = Math.round(newX / GRID_SIZE_PX) * GRID_SIZE_PX;
          newY = Math.round(newY / GRID_SIZE_PX) * GRID_SIZE_PX;
        }
        overrides.set(nodeId, { ...overrides.get(nodeId), x: newX, y: newY });
      } else if (drag.kind === "resize") {
        const { nodeId, startX, startY, startW, startH } = drag;
        const dx = (e.clientX - startX) / viewport.zoom;
        const dy = (e.clientY - startY) / viewport.zoom;
        const w = Math.max(120, startW + dx);
        const h = Math.max(80, startH + dy);
        overrides.set(nodeId, { ...overrides.get(nodeId), width: w, height: h });
      } else if (drag.kind === "shape-move") {
        // Translate every shape in the drag set by the same delta from
        // the gesture's anchor offset. The primary shape's offset gives
        // us the canonical (dx, dy); siblings inherit it.
        const primary = drag.offsetsByShape[drag.primaryShapeId];
        if (!primary) return;
        const pointerX = (e.clientX - viewport.x) / viewport.zoom;
        const pointerY = (e.clientY - viewport.y) / viewport.zoom;
        let targetX = pointerX - primary.ox;
        let targetY = pointerY - primary.oy;
        if (snapToGridRef.current) {
          targetX = Math.round(targetX / GRID_SIZE_PX) * GRID_SIZE_PX;
          targetY = Math.round(targetY / GRID_SIZE_PX) * GRID_SIZE_PX;
        }
        // dx/dy applied to every shape relative to its *initial* (x,y).
        const primaryShape = shapesRef.current.find((s) => s.id === drag.primaryShapeId);
        if (!primaryShape) return;
        const dx = targetX - primaryShape.x;
        const dy = targetY - primaryShape.y;
        const shapeOverrides = shapeDragOverridesRef.current;
        for (const id of drag.shapeIds) {
          shapeOverrides.set(id, { dx, dy });
        }
      }
      scheduleDragRender();
    };
    const onUp = () => {
      const drag = dragNode.current;
      if (!drag) return;
      if (drag.kind === "shape-move") {
        const shapeOverrides = shapeDragOverridesRef.current;
        const primary = shapeOverrides.get(drag.primaryShapeId);
        if (primary && (primary.dx !== 0 || primary.dy !== 0)) {
          if (drag.shapeIds.length > 1 && shapeBulkPatchMut) {
            shapeBulkPatchMut.mutate({
              ids: drag.shapeIds,
              dxdy: { dx: primary.dx, dy: primary.dy },
            });
          } else if (shapePatchMut) {
            for (const id of drag.shapeIds) {
              const s = shapesRef.current.find((sh) => sh.id === id);
              if (!s) continue;
              shapePatchMut.mutate({ id, x: s.x + primary.dx, y: s.y + primary.dy });
            }
          }
        }
        for (const id of drag.shapeIds) shapeOverrides.delete(id);
      } else {
        const overrides = dragOverridesRef.current;
        const ov = overrides.get(drag.nodeId);
        if (ov) {
          if (drag.kind === "node" && typeof ov.x === "number" && typeof ov.y === "number") {
            patchNode.mutate({ id: drag.nodeId, x: ov.x, y: ov.y });
          } else if (
            drag.kind === "resize" &&
            typeof ov.width === "number" &&
            typeof ov.height === "number"
          ) {
            patchNode.mutate({
              id: drag.nodeId,
              width: ov.width,
              height: ov.height,
            });
          }
        }
        overrides.delete(drag.nodeId);
      }
      dragNode.current = null;
      draggingRef.current = false;
      // Trailing realtime refresh — we suppressed invalidations during
      // the drag, so pull once on release in case anything changed.
      utils.canvas.hydrate.invalidate({ id: params.canvasId });
      setDragRev((r) => r + 1);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (dragRafRef.current != null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport.x, viewport.y, viewport.zoom]);

  // -- Shape draw + rubber-band selection ----------------------------

  // Stable callback for shape selection — supports click + shift-click.
  const onSelectShape = useCallback(
    (id: string, event: React.MouseEvent) => {
      const shape = shapes.find((s) => s.id === id);
      if (!shape) return;
      // Begin a shape-move gesture so the click that selects a shape
      // also primes drag. If the pointer moves the drag handler picks
      // it up; if it doesn't, mouseup falls through unchanged.
      const additive = event.shiftKey;
      const next = (() => {
        if (additive) {
          if (selected.some((s) => s.kind === "shape" && s.id === id)) {
            return selected.filter((s) => !(s.kind === "shape" && s.id === id));
          }
          return [...selected, { kind: "shape" as const, id }];
        }
        if (selected.some((s) => s.kind === "shape" && s.id === id)) return selected;
        return [{ kind: "shape" as const, id }];
      })();
      setSelected(next);

      // Build the drag set — include grouped siblings and any other
      // currently-selected shapes so multi-select drag moves them all.
      const dragIds = new Set<string>();
      dragIds.add(id);
      for (const g of expandGroupedShapes(id)) dragIds.add(g);
      for (const sel of next) {
        if (sel.kind !== "shape") continue;
        for (const g of expandGroupedShapes(sel.id)) dragIds.add(g);
      }
      const offsetsByShape: Record<string, { ox: number; oy: number }> = {};
      const pointerX = (event.clientX - viewport.x) / viewport.zoom;
      const pointerY = (event.clientY - viewport.y) / viewport.zoom;
      for (const sid of dragIds) {
        const s = shapes.find((sh) => sh.id === sid);
        if (!s) continue;
        offsetsByShape[sid] = { ox: pointerX - s.x, oy: pointerY - s.y };
      }
      dragNode.current = {
        kind: "shape-move",
        primaryShapeId: id,
        shapeIds: [...dragIds],
        offsetsByShape,
      };
      draggingRef.current = true;
    },
    [selected, shapes, expandGroupedShapes, viewport.x, viewport.y, viewport.zoom],
  );

  // Pointer-move for an active draw draft / rubber-band. Lives in its own
  // effect so it can install only while a gesture is open.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const surfaceToCanvasFn = surfaceToCanvasRef.current;
      if (!surfaceToCanvasFn) return;
      const draft = shapeDraftRef.current;
      if (draft) {
        const { x, y } = surfaceToCanvasFn(e.clientX, e.clientY);
        draft.endX = x;
        draft.endY = y;
        if (draft.kind === "freehand") {
          draft.path.push([x - draft.startX, y - draft.startY]);
        }
        scheduleShapeDraftRender();
        return;
      }
      const band = rubberBandRef.current;
      if (band) {
        const { x, y } = surfaceToCanvasFn(e.clientX, e.clientY);
        band.endX = x;
        band.endY = y;
        setRubberBandRev((r) => r + 1);
        return;
      }
    };
    const onUp = () => {
      const draft = shapeDraftRef.current;
      if (draft && shapeAddMut) {
        const minSize = 4;
        const w = Math.abs(draft.endX - draft.startX);
        const h = Math.abs(draft.endY - draft.startY);
        const tool = draft.kind;
        if (tool === "freehand") {
          if (draft.path.length >= 2) {
            shapeAddMut.mutate({
              canvasId: params.canvasId,
              kind: "freehand",
              x: draft.startX,
              y: draft.startY,
              path: draft.path,
              style: { stroke: toolbarStyleRef.current.stroke, strokeWidth: toolbarStyleRef.current.strokeWidth },
            });
          }
        } else if (tool === "line" || tool === "arrow") {
          if (w + h >= minSize) {
            shapeAddMut.mutate({
              canvasId: params.canvasId,
              kind: tool,
              x: draft.startX,
              y: draft.startY,
              width: draft.endX - draft.startX,
              height: draft.endY - draft.startY,
              style: { stroke: toolbarStyleRef.current.stroke, strokeWidth: toolbarStyleRef.current.strokeWidth },
            });
          }
        } else if (tool === "text") {
          // For text, the drag defines the box; default body asks the
          // operator to fill it in later via a future inline editor.
          const boxW = Math.max(120, w);
          const boxH = Math.max(40, h);
          const startX = Math.min(draft.startX, draft.endX);
          const startY = Math.min(draft.startY, draft.endY);
          shapeAddMut.mutate({
            canvasId: params.canvasId,
            kind: "text",
            x: startX,
            y: startY,
            width: boxW,
            height: boxH,
            text: "Text",
            style: { color: toolbarStyleRef.current.stroke, fontSize: 14 },
          });
        } else if (tool === "box" || tool === "ellipse") {
          if (w >= minSize && h >= minSize) {
            const startX = Math.min(draft.startX, draft.endX);
            const startY = Math.min(draft.startY, draft.endY);
            shapeAddMut.mutate({
              canvasId: params.canvasId,
              kind: tool,
              x: startX,
              y: startY,
              width: w,
              height: h,
              style: {
                stroke: toolbarStyleRef.current.stroke,
                fill: toolbarStyleRef.current.fill,
                strokeWidth: toolbarStyleRef.current.strokeWidth,
              },
            });
          }
        }
        shapeDraftRef.current = null;
        scheduleShapeDraftRender();
        // Drop back to select after each draw so single-shot drawing
        // feels less stateful; persistent draw flows can flip the
        // tool back manually.
        setActiveTool("select");
        return;
      }
      const band = rubberBandRef.current;
      if (band) {
        const minX = Math.min(band.startX, band.endX);
        const maxX = Math.max(band.startX, band.endX);
        const minY = Math.min(band.startY, band.endY);
        const maxY = Math.max(band.startY, band.endY);
        const hits: SelectedRef[] = [];
        for (const n of nodes) {
          if (
            n.x + n.width >= minX &&
            n.x <= maxX &&
            n.y + n.height >= minY &&
            n.y <= maxY
          ) {
            hits.push({ kind: "node", id: n.id });
          }
        }
        for (const s of shapes) {
          const w = s.width ?? 0;
          const h = s.height ?? 0;
          if (
            s.x + w >= minX &&
            s.x <= maxX &&
            s.y + h >= minY &&
            s.y <= maxY
          ) {
            hits.push({ kind: "shape", id: s.id });
          }
        }
        setSelected((prev) => {
          // Shift-drag is additive (intersect of existing + new).
          const seen = new Set(prev.map((r) => `${r.kind}:${r.id}`));
          const merged = [...prev];
          for (const h of hits) {
            const k = `${h.kind}:${h.id}`;
            if (!seen.has(k)) {
              merged.push(h);
              seen.add(k);
            }
          }
          return merged;
        });
        rubberBandRef.current = null;
        setRubberBandRev((r) => r + 1);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [nodes, shapes, params.canvasId, shapeAddMut, scheduleShapeDraftRender]);

  // -- Phase 3: connector preview drag (handle-to-node) -----------------

  const beginConnectorDrag = useCallback(
    (nodeId: string, side: HandleSide, clientX: number, clientY: number) => {
      const { x, y } = surfaceToCanvasRef.current?.(clientX, clientY) ?? { x: 0, y: 0 };
      connectorDraftRef.current = {
        fromNodeId: nodeId,
        fromHandle: side,
        toX: x,
        toY: y,
      };
      scheduleConnectorRender();
    },
    [scheduleConnectorRender],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const draft = connectorDraftRef.current;
      if (!draft) return;
      const surfaceToCanvasFn = surfaceToCanvasRef.current;
      if (!surfaceToCanvasFn) return;
      const { x, y } = surfaceToCanvasFn(e.clientX, e.clientY);
      draft.toX = x;
      draft.toY = y;
      scheduleConnectorRender();
    };
    const onUp = (e: MouseEvent) => {
      const draft = connectorDraftRef.current;
      if (!draft) return;
      connectorDraftRef.current = null;
      scheduleConnectorRender();
      const target = e.target as HTMLElement | null;
      const targetCard = target?.closest("[data-canvas-card]");
      const targetNodeId = targetCard?.getAttribute("data-node-id") ?? null;
      if (!targetNodeId || targetNodeId === draft.fromNodeId) return;
      const fromNode = nodes.find((n) => n.id === draft.fromNodeId);
      const toNode = nodes.find((n) => n.id === targetNodeId);
      if (!fromNode || !toNode) return;
      const toHandle = closestSideForPoint(toNode, draft.toX, draft.toY);
      const fromHandle = draft.fromHandle;
      // Persist the chosen handles via edgePatch once the row exists.
      // Falls back to bare-add if edgePatch isn't available on the server.
      void addEdge
        .mutateAsync({
          canvasId: params.canvasId,
          fromNodeId: draft.fromNodeId,
          toNodeId: targetNodeId,
          kind: "links",
        })
        .then((res: { id: string }) => {
          if (!edgePatchMut) return;
          edgePatchMut.mutate({
            id: res.id,
            meta: { fromHandle, toHandle } as EdgeMeta,
          });
        })
        .catch(() => {
          /* surfaced via onError toast */
        });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [addEdge, edgePatchMut, nodes, params.canvasId, scheduleConnectorRender]);

  // -- Keyboard shortcuts (Phase 2) -----------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack typing.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.key === "Escape") {
        setActiveTool("select");
        shapeDraftRef.current = null;
        scheduleShapeDraftRender();
        if (selectedEdgeId) setSelectedEdgeId(null);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedEdgeId) {
          e.preventDefault();
          removeEdge.mutate({ id: selectedEdgeId });
          setSelectedEdgeId(null);
          return;
        }
        const shapeIds = selected.filter((s) => s.kind === "shape").map((s) => s.id);
        if (shapeIds.length === 0) return;
        if (!shapeRemoveMut) return;
        e.preventDefault();
        for (const id of shapeIds) shapeRemoveMut.mutate({ id });
        setSelected((prev) => prev.filter((s) => s.kind !== "shape"));
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "d" || e.key === "D")) {
        const shapeIds = selected.filter((s) => s.kind === "shape").map((s) => s.id);
        if (shapeIds.length === 0) return;
        if (!shapeAddMut) return;
        e.preventDefault();
        for (const id of shapeIds) {
          const s = shapes.find((sh) => sh.id === id);
          if (!s) continue;
          const dup: ShapeAddInput = {
            canvasId: params.canvasId,
            kind: s.kind,
            x: s.x + 20,
            y: s.y + 20,
          };
          if (s.width != null) dup.width = s.width;
          if (s.height != null) dup.height = s.height;
          if (s.path != null) dup.path = s.path;
          if (s.style != null) dup.style = s.style;
          if (s.text != null) dup.text = s.text;
          if (s.groupId != null) dup.groupId = s.groupId;
          shapeAddMut.mutate(dup);
        }
        return;
      }
      if (mod && e.shiftKey && (e.key === "g" || e.key === "G")) {
        const shapeIds = selected.filter((s) => s.kind === "shape").map((s) => s.id);
        if (shapeIds.length < 1) return;
        if (!shapeBulkPatchMut) return;
        e.preventDefault();
        shapeBulkPatchMut.mutate({ ids: shapeIds, groupId: null });
        return;
      }
      if (mod && (e.key === "g" || e.key === "G")) {
        const shapeIds = selected.filter((s) => s.kind === "shape").map((s) => s.id);
        if (shapeIds.length < 2) return;
        if (!shapeBulkPatchMut) return;
        e.preventDefault();
        const newGroupId =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        shapeBulkPatchMut.mutate({ ids: shapeIds, groupId: newGroupId });
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    selected,
    shapes,
    shapeRemoveMut,
    shapeAddMut,
    shapeBulkPatchMut,
    params.canvasId,
    scheduleShapeDraftRender,
    selectedEdgeId,
    removeEdge,
  ]);

  // Toolbar style change — when shapes are selected, apply via bulkPatch;
  // otherwise update the default style for new shapes.
  const onChangeStyle = useCallback(
    (patch: Partial<StyleState>) => {
      setToolbarStyle((s) => ({ ...s, ...patch }));
      const shapeIds = selected.filter((s) => s.kind === "shape").map((s) => s.id);
      if (shapeIds.length > 0 && shapeBulkPatchMut) {
        const styleUpdate: Record<string, unknown> = {};
        if (patch.stroke !== undefined) styleUpdate.stroke = patch.stroke;
        if (patch.fill !== undefined) styleUpdate.fill = patch.fill;
        if (patch.strokeWidth !== undefined) styleUpdate.strokeWidth = patch.strokeWidth;
        if (Object.keys(styleUpdate).length > 0) {
          shapeBulkPatchMut.mutate({ ids: shapeIds, style: styleUpdate });
        }
      }
    },
    [selected, shapeBulkPatchMut],
  );

  const onToolbarGroup = useCallback(() => {
    const shapeIds = selected.filter((s) => s.kind === "shape").map((s) => s.id);
    if (shapeIds.length < 2 || !shapeBulkPatchMut) return;
    const newGroupId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    shapeBulkPatchMut.mutate({ ids: shapeIds, groupId: newGroupId });
  }, [selected, shapeBulkPatchMut]);
  const onToolbarUngroup = useCallback(() => {
    const shapeIds = selected.filter((s) => s.kind === "shape").map((s) => s.id);
    if (shapeIds.length < 1 || !shapeBulkPatchMut) return;
    shapeBulkPatchMut.mutate({ ids: shapeIds, groupId: null });
  }, [selected, shapeBulkPatchMut]);

  const canGroup = useMemo(
    () => selected.filter((s) => s.kind === "shape").length >= 2,
    [selected],
  );
  const canUngroup = useMemo(() => {
    const sel = selected.filter((s) => s.kind === "shape");
    if (sel.length === 0) return false;
    return sel.some((s) => {
      const sh = shapes.find((x) => x.id === s.id);
      return sh?.groupId != null;
    });
  }, [selected, shapes]);

  // -- Lanes ----------------------------------------------------------

  const lanes = useMemo(() => computeLanes(displayNodes), [displayNodes]);

  // -- Drop target ----------------------------------------------------

  const surfaceToCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      const sx = rect ? clientX - rect.left : clientX;
      const sy = rect ? clientY - rect.top : clientY;
      return {
        x: (sx - viewport.x) / viewport.zoom,
        y: (sy - viewport.y) / viewport.zoom,
      };
    },
    [viewport.x, viewport.y, viewport.zoom],
  );
  useEffect(() => {
    surfaceToCanvasRef.current = surfaceToCanvas;
  }, [surfaceToCanvas]);

  const onSurfaceDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("application/x-forge-entity")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dropActive) setDropActive(true);
  };
  const onSurfaceDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDropActive(false);
  };
  const onSurfaceDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    const raw = e.dataTransfer.getData("application/x-forge-entity");
    if (!raw) return;
    try {
      const payload = JSON.parse(raw) as { type?: string; id?: string };
      if (!payload.type || !payload.id) return;
      const { x, y } = surfaceToCanvas(e.clientX, e.clientY);
      const tt = payload.type;
      // New attachment / artifact cards default to inline `preview`
      // mode so file drops render as a thumbnail/iframe immediately;
      // other types keep the existing card layout.
      const viewMode =
        tt === "attachment" || tt === "artifact" ? "preview" : undefined;
      // Larger default box for preview cards — a 120px-tall image is
      // a thumbnail; the preview component fills its container.
      const initialHeight = viewMode === "preview" ? 220 : 120;
      addNode.mutate({
        canvasId: params.canvasId,
        targetType: tt as "issue" | "artifact",
        targetId: payload.id,
        x,
        y,
        width: 280,
        height: initialHeight,
        viewMode,
      });
    } catch {
      /* ignore malformed drop */
    }
  };

  // -- Presence -------------------------------------------------------

  useRealtime(
    (evt) => {
      // Agent H publishes via `subjectType: "canvas-presence"`, `subjectId =
      // canvasId`, and a payload of `{ userId, name, x, y, ts }`.
      if (evt.subjectId && evt.subjectId !== params.canvasId) return;
      const payload = (evt.payload ?? {}) as {
        userId?: string | null;
        name?: string;
        x?: number;
        y?: number;
      };
      const id = payload.userId ?? evt.actorId ?? null;
      if (!id) return;
      // Suppress self — the local operator's own broadcasts come back
      // through the workspace SSE bus and we don't want to render a
      // dot for them.
      if (myUserId && id === myUserId) return;
      if (typeof payload.x !== "number" || typeof payload.y !== "number") return;
      // Mutate the ref and coalesce paint via rAF — full state replacement
      // on every cursor tick was triggering whole-canvas re-renders.
      remoteCursorsRef.current.set(id, {
        id,
        name: payload.name ?? "Operator",
        color: colorForId(id),
        x: payload.x,
        y: payload.y,
        updatedAt: Date.now(),
      });
      scheduleCursorsRender();
    },
    { subjectType: "canvas-presence" },
  );

  // Workspace entity events normally invalidate the hydrate query. While
  // the operator is mid-drag we suppress that — the trailing invalidate
  // on mouseup catches anything that landed during the gesture.
  useRealtime(
    () => {
      if (draggingRef.current) return;
      utils.canvas.hydrate.invalidate({ id: params.canvasId });
    },
    { subjectType: ["canvas", "issue", "artifact", "execution-step", "execution-plan"] },
  );

  // Sweep stale cursors every second.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      const cursors = remoteCursorsRef.current;
      let mutated = false;
      for (const [id, c] of cursors) {
        if (now - c.updatedAt > PRESENCE_STALE_MS) {
          cursors.delete(id);
          mutated = true;
        }
      }
      if (mutated) scheduleCursorsRender();
    }, 1000);
    return () => clearInterval(t);
  }, [scheduleCursorsRender]);

  // Throttled local cursor broadcast — uses the optional helper only.
  const presencePublishAny = canvasRouterAny?.broadcastPresence as
    | {
        useMutation: () => {
          mutate: (input: { canvasId: string; x: number; y: number }) => void;
        };
      }
    | undefined;
  const presencePublishMut = presencePublishAny?.useMutation();
  // rAF-aligned throttle so the broadcast cadence rides paint frames
  // instead of the setTimeout queue.
  const lastPublishRef = useRef(0);
  const pendingPublishRef = useRef<{ x: number; y: number } | null>(null);
  const publishRafRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (publishRafRef.current != null) {
        cancelAnimationFrame(publishRafRef.current);
        publishRafRef.current = null;
      }
    };
  }, []);
  const onSurfaceMouseMove = (e: React.MouseEvent) => {
    if (!presencePublishMut) return;
    if (!presenceVisibleRef.current) return;
    const { x, y } = surfaceToCanvas(e.clientX, e.clientY);
    pendingPublishRef.current = { x, y };
    if (publishRafRef.current != null) return;
    publishRafRef.current = requestAnimationFrame(() => {
      publishRafRef.current = null;
      const now = performance.now();
      if (now - lastPublishRef.current < 1000 / PRESENCE_PUBLISH_HZ) return;
      const pending = pendingPublishRef.current;
      if (!pending) return;
      lastPublishRef.current = now;
      pendingPublishRef.current = null;
      try {
        presencePublishMut.mutate({ canvasId: params.canvasId, ...pending });
      } catch {
        /* ignore */
      }
    });
  };

  // Stable callbacks so memoized cards don't churn.
  const handleEditLane = useCallback(
    (nodeId: string, active: boolean) =>
      setEditingLaneFor(active ? nodeId : null),
    [],
  );
  const handleEditNote = useCallback(
    (nodeId: string, active: boolean) =>
      setEditingNoteFor(active ? nodeId : null),
    [],
  );
  const handleRemoveCard = useCallback(
    (nodeId: string) => setConfirm({ kind: "remove-card", id: nodeId }),
    [],
  );
  const handleHoverChange = useCallback((nodeId: string | null) => {
    setHoverNodeId(nodeId);
  }, []);
  const handleConnectorStart = useCallback(
    (nodeId: string, side: HandleSide, e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      beginConnectorDrag(nodeId, side, e.clientX, e.clientY);
    },
    [beginConnectorDrag],
  );
  // Toggle between "preview" (inline file/iframe) and "card" (chip)
  // viewModes. Optimistic — flips the cached row immediately so the
  // toggle feels instant; the mutation's onSuccess re-syncs.
  const handleTogglePreview = useCallback(
    (nodeId: string, next: "preview" | "card") => {
      patchNode.mutate({ id: nodeId, viewMode: next });
      utils.canvas.hydrate.setData({ id: params.canvasId }, (curr) => {
        if (!curr) return curr;
        return {
          ...curr,
          nodes: curr.nodes.map((n) =>
            n.id === nodeId ? { ...n, viewMode: next } : n,
          ),
        };
      });
    },
    [patchNode, utils, params.canvasId],
  );
  const handlePatchLane = useCallback(
    (nodeId: string, lane: string) => {
      patchNodeMeta.mutate({
        id: nodeId,
        meta: { lane: lane.trim() ? lane.trim() : null },
      });
      utils.canvas.hydrate.setData({ id: params.canvasId }, (curr) => {
        if (!curr) return curr;
        return {
          ...curr,
          nodes: curr.nodes.map((n) => {
            if (n.id !== nodeId) return n;
            const nMeta =
              ((n as { meta?: Record<string, unknown> | null }).meta ?? {}) as Record<
                string,
                unknown
              >;
            const nextMeta: Record<string, unknown> = { ...nMeta };
            if (lane.trim()) {
              nextMeta.lane = lane.trim();
            } else {
              delete nextMeta.lane;
            }
            // Cast through unknown: tRPC's response shape uses
            // Prisma.JsonValue (union including arrays/null) while
            // we're storing a plain object — same wire shape, just
            // narrower at compile time.
            return { ...n, meta: nextMeta as unknown as typeof n.meta };
          }),
        };
      });
      setEditingLaneFor(null);
    },
    [patchNodeMeta, utils, params.canvasId],
  );

  // Sidebar resize — pointer-driven, writes width directly to the DOM during
  // the drag (refs only), then commits to React state + localStorage on
  // release so React doesn't re-render the whole canvas tree per mousemove.
  const onSidebarHandleDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const node = sidebarRef.current;
      if (!node) return;
      sidebarDragRef.current = {
        startX: e.clientX,
        startW: node.getBoundingClientRect().width,
      };
      setSidebarResizing(true);
      let rafId: number | null = null;
      let lastWidth = sidebarDragRef.current.startW;
      const onMove = (ev: MouseEvent) => {
        const start = sidebarDragRef.current;
        if (!start) return;
        const next = Math.min(
          SIDEBAR_MAX_WIDTH,
          Math.max(SIDEBAR_MIN_WIDTH, start.startW + (ev.clientX - start.startX)),
        );
        lastWidth = next;
        if (rafId != null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (sidebarRef.current) sidebarRef.current.style.width = `${lastWidth}px`;
        });
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (rafId != null) cancelAnimationFrame(rafId);
        sidebarDragRef.current = null;
        setSidebarResizing(false);
        const finalWidth = Math.round(lastWidth);
        setSidebarWidth(finalWidth);
        try {
          window.localStorage.setItem(sidebarStorageKey, String(finalWidth));
        } catch {
          /* ignore quota */
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarStorageKey],
  );

  if (isLoading) {
    return (
      <>
        <Topbar title="Canvas" />
        <div className="p-4">
          <SkeletonList rows={4} />
        </div>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <Topbar title="Canvas" />
        <div className="p-4">
          <EmptyState
            variant="page"
            title="Canvas not found"
            description="This canvas may have been archived or deleted."
          />
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title={data.canvas.name}
        subtitle={`Canvas · ${displayNodes.length} card${displayNodes.length === 1 ? "" : "s"} · ${(viewport.zoom * 100).toFixed(0)}%`}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => router.push(`/w/${ws.slug}/canvas`)}
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setOpenSidebar((v) => !v)}
              title="Toggle entity picker"
            >
              <Layers className="h-3.5 w-3.5" /> {openSidebar ? "Hide rail" : "Show rail"}
            </Button>
            {addNoteMut ? (
              <Button
                size="sm"
                variant="ghost"
                title="Add a sticky note at the viewport center"
                onClick={() => {
                  const { x, y } = surfaceToCanvas(
                    (surfaceRef.current?.clientWidth ?? 600) / 2,
                    (surfaceRef.current?.clientHeight ?? 400) / 2,
                  );
                  addNoteMut.mutate({ canvasId: params.canvasId, body: "New note", x, y });
                }}
                disabled={addNoteMut.isPending}
              >
                <StickyNote className="h-3.5 w-3.5" /> Note
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setViewport({ x: 0, y: 0, zoom: 1 })}
              title="Reset view"
            >
              <Maximize2 className="h-3.5 w-3.5" /> Reset
            </Button>
            <Button
              size="sm"
              variant="ghost"
              title={
                convertToPlanAvailable
                  ? "Convert this canvas to a new execution plan"
                  : "Convert-to-plan ships in a later release"
              }
              disabled={!convertToPlanMut || convertToPlanMut.isPending}
              onClick={() => {
                if (!convertToPlanMut) return;
                // Client-side dry-run preview — mirror the backend's
                // include/skip rules so the operator can confirm before
                // a plan row is created. Runs BEFORE opening the modal
                // so an empty canvas bails out with a toast.
                let stepCount = 0;
                const skipped: Array<{ targetType: string; reason: string }> = [];
                for (const n of displayNodes) {
                  if (n.targetType === "execution-step") {
                    stepCount++;
                  } else if (
                    n.targetType === "artifact" &&
                    ((n.meta as { kind?: string } | null)?.kind ?? "") === "NOTE"
                  ) {
                    stepCount++;
                  } else {
                    skipped.push({
                      targetType: n.targetType,
                      reason: "type not convertible to a plan step",
                    });
                  }
                }
                if (stepCount === 0) {
                  toast.error("Nothing convertible on this canvas — add steps or NOTE artifacts first.");
                  return;
                }
                setConfirm({ kind: "convert", stepCount, skipped });
              }}
            >
              <GitBranch className="h-3.5 w-3.5" />{" "}
              {convertToPlanMut?.isPending ? "Converting…" : "Convert to plan"}
            </Button>
            <Button size="sm" variant="ember" onClick={() => setOpenPicker(true)}>
              <Plus className="h-3.5 w-3.5" /> Add card
            </Button>
            <Button
              size="sm"
              variant="ghost"
              title="Canvas settings"
              onClick={() => setOpenSettings(true)}
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>
          </>
        }
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {openSidebar ? (
          <div
            ref={sidebarRef}
            className="relative flex shrink-0"
            style={{ width: sidebarWidth }}
          >
            <CanvasEntityRail canvasId={data.canvas.id} />
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              onMouseDown={onSidebarHandleDown}
              className={
                "absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-ember/40 " +
                (sidebarResizing ? "bg-ember/60" : "")
              }
            />
          </div>
        ) : null}
        <div
          ref={surfaceRef}
          className={
            "relative flex-1 select-none overflow-hidden bg-card/20 transition-shadow duration-200 " +
            (dropActive ? "ring-2 ring-ember/60 ring-inset" : "")
          }
          style={{
            cursor: panning ? "grabbing" : "grab",
            backgroundImage: viewPrefs.showGrid
              ? "radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px)"
              : undefined,
            backgroundSize: viewPrefs.showGrid
              ? `${20 * viewport.zoom}px ${20 * viewport.zoom}px`
              : undefined,
            backgroundPosition: viewPrefs.showGrid
              ? `${viewport.x}px ${viewport.y}px`
              : undefined,
          }}
          onMouseDown={onBackgroundMouseDown}
          onMouseMove={onSurfaceMouseMove}
          onWheel={onWheel}
          onDragOver={onSurfaceDragOver}
          onDragLeave={onSurfaceDragLeave}
          onDrop={onSurfaceDrop}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            }}
          >
            {/* Lane bands sit behind nodes. */}
            {lanes.map((lane) => (
              <LaneBand key={lane.name} lane={lane} />
            ))}
            {/* Shapes (Phase 2) sit BELOW edges + nodes by default. */}
            <CanvasShapes
              shapes={displayShapes}
              selectedIds={selectedShapeIds}
              onSelectShape={onSelectShape}
            />
            {/* Draft shape preview while drawing. */}
            <ShapeDraftPreview
              draftRef={shapeDraftRef}
              rev={shapeDraftRev}
              style={toolbarStyle}
            />
            {/* Rubber-band marquee while shift-dragging on background. */}
            <RubberBandPreview bandRef={rubberBandRef} rev={rubberBandRev} />
            {/* Edges sit between lane bands and node cards. */}
            <EdgesOverlay
              nodes={displayNodes}
              edges={edges}
              selectedEdgeId={selectedEdgeId}
              onSelectEdge={setSelectedEdgeId}
            />
            <ConnectorDraftLayer
              draftRef={connectorDraftRef}
              rev={connectorRev}
              nodes={displayNodes}
            />
            {displayNodes.length === 0 ? (
              <div
                className="absolute left-8 top-8 rounded-lg border border-dashed border-border bg-card/30 p-6 text-sm text-muted-foreground"
                style={{ width: 320 }}
              >
                Empty canvas. Drag in from the left rail, or click{" "}
                <span className="font-mono">Add card</span>. Drag background to pan;{" "}
                <span className="font-mono">⌘/Ctrl + wheel</span> to zoom.
              </div>
            ) : null}
            {displayNodes.map((node) => (
              <CanvasCard
                key={node.id}
                node={node}
                editingLane={editingLaneFor === node.id}
                editingNote={editingNoteFor === node.id}
                onEditLane={handleEditLane}
                onEditNote={handleEditNote}
                onMouseDown={onCardMouseDown}
                onResizeMouseDown={onResizeMouseDown}
                onRemove={handleRemoveCard}
                onPatchLane={handlePatchLane}
                onTogglePreview={handleTogglePreview}
                handlesAlwaysShown={activeTool === "connect"}
                hovered={hoverNodeId === node.id}
                onHoverChange={handleHoverChange}
                onConnectorStart={handleConnectorStart}
              />
            ))}
            {selectedEdgeId
              ? (() => {
                  const edge = edges.find((x) => x.id === selectedEdgeId);
                  if (!edge) return null;
                  const fromNode = displayNodes.find((n) => n.id === edge.fromNodeId);
                  const toNode = displayNodes.find((n) => n.id === edge.toNodeId);
                  if (!fromNode || !toNode) return null;
                  return (
                    <EdgeEditPanel
                      key={edge.id}
                      edge={edge}
                      fromNode={fromNode}
                      toNode={toNode}
                      onClose={() => setSelectedEdgeId(null)}
                      onRemove={() => {
                        removeEdge.mutate({ id: edge.id });
                        setSelectedEdgeId(null);
                      }}
                      onPatch={
                        edgePatchMut
                          ? (patch) => edgePatchMut.mutate({ id: edge.id, ...patch })
                          : null
                      }
                    />
                  );
                })()
              : null}
          </div>
          {/* Remote cursors — read from ref via cursorsRev so the rest
              of the tree doesn't repaint when peers move. */}
          {viewPrefs.presenceVisible ? (
            <RemoteCursorsLayer
              cursorsRef={remoteCursorsRef}
              viewport={viewport}
              rev={cursorsRev}
            />
          ) : null}
        </div>
      </div>
      <CanvasToolbar
        activeTool={activeTool}
        onSelectTool={setActiveTool}
        style={toolbarStyle}
        onChangeStyle={onChangeStyle}
        onGroup={onToolbarGroup}
        onUngroup={onToolbarUngroup}
        canGroup={canGroup}
        canUngroup={canUngroup}
        persistKey={ws.slug}
      />
      {openPicker && (
        <AddCardPicker
          canvasId={data.canvas.id}
          onClose={() => setOpenPicker(false)}
        />
      )}
      <CanvasSettingsModal
        open={openSettings}
        onOpenChange={setOpenSettings}
        canvasId={data.canvas.id}
        name={data.canvas.name}
        scopeType={data.canvas.scopeType ?? null}
        showGrid={viewPrefs.showGrid}
        snapToGrid={viewPrefs.snapToGrid}
        presenceVisible={viewPrefs.presenceVisible}
        onShowGridChange={setShowGrid}
        onSnapToGridChange={setSnapToGrid}
        onPresenceVisibleChange={setPresenceVisible}
        onArchived={() => router.push(`/w/${ws.slug}/canvas`)}
        onDeleted={() => router.push(`/w/${ws.slug}/canvas`)}
      />
      <Confirm
        open={confirm?.kind === "remove-card"}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title="Remove card?"
        description="The card will be removed from this canvas. The underlying entity isn't deleted."
        primaryLabel="Remove card"
        variant="destructive"
        loading={removeNode.isPending}
        onConfirm={() => {
          if (confirm?.kind !== "remove-card") return;
          const id = confirm.id;
          removeNode.mutate(
            { id },
            { onSettled: () => setConfirm(null) },
          );
        }}
      />
      <Confirm
        open={confirm?.kind === "convert"}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title="Convert canvas to plan?"
        description={
          confirm?.kind === "convert"
            ? `Create a new plan with ${confirm.stepCount} step${confirm.stepCount === 1 ? "" : "s"} from this canvas. ${
                confirm.skipped.length === 0
                  ? "No nodes will be skipped."
                  : `${confirm.skipped.length} node${confirm.skipped.length === 1 ? "" : "s"} will be skipped (${[
                      ...new Set(confirm.skipped.map((s) => s.targetType)),
                    ].join(", ")}).`
              }`
            : undefined
        }
        primaryLabel="Create plan"
        loading={convertToPlanMut?.isPending ?? false}
        onConfirm={() => {
          if (confirm?.kind !== "convert") return;
          if (!convertToPlanMut) return;
          convertToPlanMut.mutate({ canvasId: params.canvasId });
          setConfirm(null);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Draft shape preview — read from a ref so pointermove ticks don't re-render
// the parent. Renders nothing once the draft clears.
// ---------------------------------------------------------------------------

function ShapeDraftPreview({
  draftRef,
  rev: _rev,
  style,
}: {
  draftRef: React.MutableRefObject<ShapeDraft | null>;
  rev: number;
  style: StyleState;
}) {
  const draft = draftRef.current;
  if (!draft) return null;
  const { kind, startX, startY, endX, endY } = draft;
  const minX = Math.min(startX, endX);
  const minY = Math.min(startY, endY);
  const w = Math.abs(endX - startX);
  const h = Math.abs(endY - startY);
  const strokeColor = style.stroke;
  const strokeWidth = style.strokeWidth;
  if (kind === "box") {
    return (
      <div
        className="pointer-events-none absolute rounded-md"
        style={{
          left: minX,
          top: minY,
          width: w,
          height: h,
          border: `${strokeWidth}px dashed ${strokeColor}`,
        }}
      />
    );
  }
  if (kind === "ellipse") {
    return (
      <div
        className="pointer-events-none absolute"
        style={{
          left: minX,
          top: minY,
          width: w,
          height: h,
          border: `${strokeWidth}px dashed ${strokeColor}`,
          borderRadius: "9999px",
        }}
      />
    );
  }
  if (kind === "line" || kind === "arrow") {
    // SVG overlay so an arbitrary slope renders without rotation math.
    const padding = 8;
    const left = Math.min(startX, endX) - padding;
    const top = Math.min(startY, endY) - padding;
    const width = Math.abs(endX - startX) + padding * 2;
    const height = Math.abs(endY - startY) + padding * 2;
    return (
      <svg
        className="pointer-events-none absolute"
        style={{ left, top, width, height, overflow: "visible" }}
      >
        <line
          x1={startX - left}
          y1={startY - top}
          x2={endX - left}
          y2={endY - top}
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeDasharray="6 4"
          markerEnd={kind === "arrow" ? "url(#canvas-shape-arrow)" : undefined}
        />
      </svg>
    );
  }
  if (kind === "text") {
    return (
      <div
        className="pointer-events-none absolute rounded-md"
        style={{
          left: minX,
          top: minY,
          width: w,
          height: h,
          border: `${strokeWidth}px dashed ${strokeColor}`,
        }}
      />
    );
  }
  if (kind === "freehand") {
    const pts = draft.path.map(([dx, dy]) => [startX + dx, startY + dy] as [number, number]);
    if (pts.length === 0) return null;
    let minPX = Infinity;
    let minPY = Infinity;
    let maxPX = -Infinity;
    let maxPY = -Infinity;
    for (const [px, py] of pts) {
      if (px < minPX) minPX = px;
      if (py < minPY) minPY = py;
      if (px > maxPX) maxPX = px;
      if (py > maxPY) maxPY = py;
    }
    const padding = 8;
    const left = minPX - padding;
    const top = minPY - padding;
    const width = Math.max(1, maxPX - minPX) + padding * 2;
    const height = Math.max(1, maxPY - minPY) + padding * 2;
    const d = pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p[0] - left},${p[1] - top}`)
      .join(" ");
    return (
      <svg
        className="pointer-events-none absolute"
        style={{ left, top, width, height, overflow: "visible" }}
      >
        <path
          d={d}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return null;
}

function RubberBandPreview({
  bandRef,
  rev: _rev,
}: {
  bandRef: React.MutableRefObject<RubberBand | null>;
  rev: number;
}) {
  const band = bandRef.current;
  if (!band) return null;
  const left = Math.min(band.startX, band.endX);
  const top = Math.min(band.startY, band.endY);
  const width = Math.abs(band.endX - band.startX);
  const height = Math.abs(band.endY - band.startY);
  if (width < 1 && height < 1) return null;
  return (
    <div
      className="pointer-events-none absolute rounded-sm border border-ember/60 bg-ember/10"
      style={{ left, top, width, height }}
    />
  );
}

// ---------------------------------------------------------------------------
// Remote cursors layer — isolated subtree so cursor SSE ticks don't ripple
// through the rest of the canvas. Reads the cursor map from a ref, kicked
// by a `rev` counter from the parent.
// ---------------------------------------------------------------------------

function RemoteCursorsLayer({
  cursorsRef,
  viewport,
  rev: _rev,
}: {
  cursorsRef: React.MutableRefObject<Map<string, RemoteCursor>>;
  viewport: Viewport;
  rev: number;
}) {
  const cursors = [...cursorsRef.current.values()];
  return (
    <>
      {cursors.map((c) => (
        <div
          key={c.id}
          className="pointer-events-none absolute z-30"
          style={{
            transform: `translate(${c.x * viewport.zoom + viewport.x}px, ${c.y * viewport.zoom + viewport.y}px)`,
          }}
        >
          <div
            className="h-2 w-2 rounded-full shadow"
            style={{ backgroundColor: c.color }}
          />
          <div
            className="mt-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium text-card shadow"
            style={{ backgroundColor: c.color }}
          >
            {c.name}
          </div>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Lane band
// ---------------------------------------------------------------------------

type LaneBox = {
  name: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

function computeLanes(nodes: HydratedNode[]): LaneBox[] {
  const map = new Map<string, LaneBox>();
  for (const n of nodes) {
    const lane = (n.meta?.lane as string | undefined) ?? undefined;
    if (!lane) continue;
    const right = n.x + n.width;
    const bottom = n.y + n.height;
    const box = map.get(lane);
    if (!box) {
      map.set(lane, { name: lane, minX: n.x, minY: n.y, maxX: right, maxY: bottom });
    } else {
      box.minX = Math.min(box.minX, n.x);
      box.minY = Math.min(box.minY, n.y);
      box.maxX = Math.max(box.maxX, right);
      box.maxY = Math.max(box.maxY, bottom);
    }
  }
  return [...map.values()];
}

function LaneBand({ lane }: { lane: LaneBox }) {
  const padding = 16;
  const x = lane.minX - padding;
  const y = lane.minY - padding;
  const width = lane.maxX - lane.minX + padding * 2;
  const height = lane.maxY - lane.minY + padding * 2;
  return (
    <div
      className="pointer-events-none absolute rounded-lg border border-ember/15 bg-ember/[0.04]"
      style={{ left: x, top: y, width, height }}
    >
      <div className="absolute left-2 top-1 text-[10px] uppercase tracking-wider text-ember/80">
        {lane.name}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edges overlay — labeled arrows between node cards. Inside the transformed
// surface so it shares the same coordinate space as the cards; SVG sizing
// is computed from the node bounding box (with margin) so it covers them.
// ---------------------------------------------------------------------------

type EdgesOverlayProps = {
  nodes: HydratedNode[];
  edges: EdgeRow[];
  selectedEdgeId: string | null;
  onSelectEdge: (id: string | null) => void;
};

const EdgesOverlay = memo(function EdgesOverlay({
  nodes,
  edges,
  selectedEdgeId,
  onSelectEdge,
}: EdgesOverlayProps) {
  const nodeById = useMemo(() => {
    const m = new Map<string, HydratedNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  // Bounding box covering every node plus a margin for routed paths
  // that arc outside the immediate cluster.
  const bbox = useMemo(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    }
    const margin = 200;
    return {
      left: Math.floor(minX - margin),
      top: Math.floor(minY - margin),
      width: Math.ceil(maxX - minX + margin * 2),
      height: Math.ceil(maxY - minY + margin * 2),
    };
  }, [nodes]);

  // Hash for the obstacle set so per-edge memos can invalidate as a group
  // when any non-incident node moves.
  const obstaclesHash = useMemo(() => {
    const parts: string[] = [];
    for (const n of nodes) {
      parts.push(
        `${n.id}:${Math.round(n.x)}:${Math.round(n.y)}:${Math.round(n.width)}:${Math.round(n.height)}`,
      );
    }
    return parts.join("|");
  }, [nodes]);

  if (edges.length === 0) return null;

  const { left, top, width, height } = bbox;

  return (
    <svg
      className="absolute"
      style={{ left, top, width, height, pointerEvents: "none" }}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      <defs>
        <marker
          id="edge-arrow-ember"
          viewBox="0 -5 10 10"
          refX="9"
          refY="0"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,-4 L8,0 L0,4 Z" fill="hsl(var(--ember))" />
        </marker>
        <marker
          id="edge-arrow-muted"
          viewBox="0 -5 10 10"
          refX="9"
          refY="0"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,-4 L8,0 L0,4 Z" fill="hsl(var(--muted-foreground))" />
        </marker>
      </defs>
      {edges.map((e) => {
        const from = nodeById.get(e.fromNodeId);
        const to = nodeById.get(e.toNodeId);
        if (!from || !to) return null;
        return (
          <EdgePath
            key={e.id}
            edge={e}
            from={from}
            to={to}
            nodes={nodes}
            originX={left}
            originY={top}
            obstaclesHash={obstaclesHash}
            selected={selectedEdgeId === e.id}
            onSelectEdge={onSelectEdge}
          />
        );
      })}
    </svg>
  );
});

type EdgePathProps = {
  edge: EdgeRow;
  from: HydratedNode;
  to: HydratedNode;
  nodes: HydratedNode[];
  originX: number;
  originY: number;
  obstaclesHash: string;
  selected: boolean;
  onSelectEdge: (id: string | null) => void;
};

function geometricSides(
  from: HydratedNode,
  to: HydratedNode,
): { fromSide: HandleSide; toSide: HandleSide } {
  const fromCx = from.x + from.width / 2;
  const fromCy = from.y + from.height / 2;
  const toCx = to.x + to.width / 2;
  const toCy = to.y + to.height / 2;
  const dx = toCx - fromCx;
  const dy = toCy - fromCy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { fromSide: "right", toSide: "left" }
      : { fromSide: "left", toSide: "right" };
  }
  return dy >= 0
    ? { fromSide: "bottom", toSide: "top" }
    : { fromSide: "top", toSide: "bottom" };
}

function nodeToRect(n: HydratedNode): Rect {
  return { x: n.x, y: n.y, width: n.width, height: n.height };
}

function strokeForKind(kind: string | null): {
  stroke: string;
  dash?: string;
  marker: string;
} {
  switch (kind) {
    case "depends_on":
      return { stroke: "hsl(var(--ember))", marker: "url(#edge-arrow-ember)" };
    case "contains":
      return {
        stroke: "hsl(var(--muted-foreground))",
        dash: "4 4",
        marker: "url(#edge-arrow-muted)",
      };
    case "dashed":
      return {
        stroke: "hsl(var(--muted-foreground))",
        dash: "6 4",
        marker: "url(#edge-arrow-muted)",
      };
    case "dotted":
      return {
        stroke: "hsl(var(--muted-foreground))",
        dash: "2 4",
        marker: "url(#edge-arrow-muted)",
      };
    case "curved":
    case "solid":
    default:
      return { stroke: "hsl(var(--muted-foreground))", marker: "url(#edge-arrow-muted)" };
  }
}

const EdgePath = memo(
  function EdgePath({
    edge,
    from,
    to,
    nodes,
    originX,
    originY,
    selected,
    onSelectEdge,
  }: EdgePathProps) {
    const meta: EdgeMeta = (edge.meta as EdgeMeta | null) ?? {};
    const { fromSide, toSide } = (() => {
      if (meta.fromHandle && meta.toHandle) {
        return { fromSide: meta.fromHandle, toSide: meta.toHandle };
      }
      return geometricSides(from, to);
    })();
    const obstacles = useMemo(
      () => nodes.filter((n) => n.id !== from.id && n.id !== to.id).map(nodeToRect),
      [nodes, from.id, to.id],
    );

    const routed = useMemo(() => {
      if (edge.kind === "curved") {
        // Skip A* for the curved kind — just a straight cubic between
        // anchor points, no obstacle avoidance.
        return routeEdge({
          from: { rect: nodeToRect(from), handle: fromSide },
          to: { rect: nodeToRect(to), handle: toSide },
          obstacles: [],
        });
      }
      return routeEdge({
        from: { rect: nodeToRect(from), handle: fromSide },
        to: { rect: nodeToRect(to), handle: toSide },
        obstacles,
      });
    }, [edge.kind, from, to, fromSide, toSide, obstacles]);

    const style = strokeForKind(edge.kind);
    const ax = routed.anchors[0]!;
    const bx = routed.anchors[1]!;
    const mx = (ax.x + bx.x) / 2 - originX;
    const my = (ax.y + bx.y) / 2 - originY;
    const transformed = `translate(${-originX}, ${-originY})`;
    const baseWidth = selected ? 2.5 : 1.5;

    return (
      <g transform={transformed}>
        {/* Wide invisible hit-target so the edge is easy to click. */}
        <path
          d={routed.d}
          stroke="transparent"
          strokeWidth={14}
          fill="none"
          style={{ pointerEvents: "stroke", cursor: "pointer" }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onSelectEdge(edge.id);
          }}
        />
        <path
          d={routed.d}
          stroke={style.stroke}
          strokeWidth={baseWidth}
          strokeDasharray={style.dash}
          fill="none"
          markerEnd={style.marker}
          opacity={selected ? 1 : 0.65}
          style={{ pointerEvents: "none" }}
        />
        {edge.label ? (
          <g transform={`translate(${mx + originX}, ${my + originY})`}>
            <rect
              x={-Math.min(64, edge.label.length * 3 + 8)}
              y={-9}
              width={Math.min(128, edge.label.length * 6 + 16)}
              height={16}
              rx={4}
              fill="hsl(var(--card))"
              fillOpacity={0.9}
              stroke="hsl(var(--border))"
              style={{ pointerEvents: "none" }}
            />
            <text
              textAnchor="middle"
              dy="0.32em"
              fontSize={10}
              fill="hsl(var(--muted-foreground))"
              style={{ pointerEvents: "none" }}
            >
              {edge.label}
            </text>
          </g>
        ) : null}
      </g>
    );
  },
  (prev, next) =>
    prev.edge.id === next.edge.id &&
    prev.edge.label === next.edge.label &&
    prev.edge.kind === next.edge.kind &&
    prev.edge.meta === next.edge.meta &&
    prev.from.x === next.from.x &&
    prev.from.y === next.from.y &&
    prev.from.width === next.from.width &&
    prev.from.height === next.from.height &&
    prev.to.x === next.to.x &&
    prev.to.y === next.to.y &&
    prev.to.width === next.to.width &&
    prev.to.height === next.to.height &&
    prev.originX === next.originX &&
    prev.originY === next.originY &&
    prev.obstaclesHash === next.obstaclesHash &&
    prev.selected === next.selected &&
    prev.onSelectEdge === next.onSelectEdge,
);

// ---------------------------------------------------------------------------
// Connector draft layer — preview line that follows the cursor while
// dragging from a handle. Ref-driven so pointer events don't re-render the
// canvas; rev counter coalesces paints.
// ---------------------------------------------------------------------------

function ConnectorDraftLayer({
  draftRef,
  rev: _rev,
  nodes,
}: {
  draftRef: React.MutableRefObject<ConnectorDraft | null>;
  rev: number;
  nodes: HydratedNode[];
}) {
  const draft = draftRef.current;
  if (!draft) return null;
  const fromNode = nodes.find((n) => n.id === draft.fromNodeId);
  if (!fromNode) return null;
  const cursorRect: Rect = {
    x: draft.toX - 1,
    y: draft.toY - 1,
    width: 2,
    height: 2,
  };
  const toSide: HandleSide = closestSideForPoint(fromNode, draft.toX, draft.toY) === "left"
    ? "right"
    : "left";
  // We route from the fixed handle on the source to a tiny target rect at
  // the cursor. Pick the cursor "side" based on its position relative to
  // the source so the routed line approaches naturally.
  const routed = routeEdge({
    from: { rect: nodeToRect(fromNode), handle: draft.fromHandle },
    to: { rect: cursorRect, handle: toSide },
    obstacles: nodes.filter((n) => n.id !== fromNode.id).map(nodeToRect),
  });
  // Use a small SVG covering the bbox of from + cursor with padding.
  const minX = Math.min(fromNode.x, draft.toX) - 80;
  const minY = Math.min(fromNode.y, draft.toY) - 80;
  const maxX = Math.max(fromNode.x + fromNode.width, draft.toX) + 80;
  const maxY = Math.max(fromNode.y + fromNode.height, draft.toY) + 80;
  return (
    <svg
      className="pointer-events-none absolute"
      style={{ left: minX, top: minY, width: maxX - minX, height: maxY - minY }}
      width={maxX - minX}
      height={maxY - minY}
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
    >
      <path
        d={routed.d}
        fill="none"
        stroke="hsl(var(--ember))"
        strokeWidth={2}
        strokeDasharray="6 4"
        opacity={0.85}
      />
    </svg>
  );
}

function closestSideForPoint(
  node: { x: number; y: number; width: number; height: number },
  px: number,
  py: number,
): HandleSide {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const dx = px - cx;
  const dy = py - cy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? "right" : "left";
  }
  return dy >= 0 ? "bottom" : "top";
}

// ---------------------------------------------------------------------------
// Edge edit panel — floating editor anchored to an edge midpoint. Renders in
// canvas-space so it follows pan/zoom alongside the edges.
// ---------------------------------------------------------------------------

function EdgeEditPanel({
  edge,
  fromNode,
  toNode,
  onClose,
  onRemove,
  onPatch,
}: {
  edge: EdgeRow;
  fromNode: HydratedNode;
  toNode: HydratedNode;
  onClose: () => void;
  onRemove: () => void;
  onPatch:
    | ((patch: { label?: string | null; kind?: string | null; meta?: unknown }) => void)
    | null;
}) {
  const meta: EdgeMeta = (edge.meta as EdgeMeta | null) ?? {};
  const fromCenter = { x: fromNode.x + fromNode.width / 2, y: fromNode.y + fromNode.height / 2 };
  const toCenter = { x: toNode.x + toNode.width / 2, y: toNode.y + toNode.height / 2 };
  const mx = (fromCenter.x + toCenter.x) / 2;
  const my = (fromCenter.y + toCenter.y) / 2;

  const [draftLabel, setDraftLabel] = useState(edge.label ?? "");
  useEffect(() => {
    setDraftLabel(edge.label ?? "");
  }, [edge.label, edge.id]);

  // Debounce label commits so each keystroke doesn't fire a mutation.
  const lastCommittedRef = useRef(edge.label ?? "");
  useEffect(() => {
    if (!onPatch) return;
    const t = window.setTimeout(() => {
      const next = draftLabel.trim();
      const last = (lastCommittedRef.current ?? "").trim();
      if (next === last) return;
      lastCommittedRef.current = next;
      onPatch({ label: next.length ? next : null });
    }, 350);
    return () => window.clearTimeout(t);
  }, [draftLabel, onPatch]);

  const currentKind = edge.kind ?? "solid";

  const sideOptions: Array<{ value: HandleSide | "auto"; label: string }> = [
    { value: "auto", label: "auto" },
    { value: "top", label: "top" },
    { value: "right", label: "right" },
    { value: "bottom", label: "bottom" },
    { value: "left", label: "left" },
  ];

  const updateHandle = (which: "from" | "to", side: HandleSide | "auto") => {
    if (!onPatch) return;
    const nextMeta: EdgeMeta = { ...meta };
    if (which === "from") {
      if (side === "auto") delete nextMeta.fromHandle;
      else nextMeta.fromHandle = side;
    } else {
      if (side === "auto") delete nextMeta.toHandle;
      else nextMeta.toHandle = side;
    }
    onPatch({
      meta: Object.keys(nextMeta).length === 0 ? null : nextMeta,
    });
  };

  return (
    <div
      data-canvas-edge-panel
      className="absolute z-20 flex flex-col gap-1.5 rounded-lg border border-border bg-card/95 px-2 py-2 text-xs shadow-lg backdrop-blur-md"
      style={{ left: mx, top: my, transform: "translate(-50%, -50%)", width: 240 }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="text"
        value={draftLabel}
        placeholder="Edge label"
        onChange={(e) => setDraftLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        disabled={!onPatch}
        className="w-full rounded border border-border bg-card/40 px-1.5 py-0.5 text-xs disabled:opacity-50"
      />
      <div className="flex items-center gap-1" role="group" aria-label="Edge style">
        {EDGE_KIND_STYLES.map((k) => {
          const active = currentKind === k.kind;
          return (
            <button
              key={k.kind}
              type="button"
              disabled={!onPatch}
              onClick={() => onPatch?.({ kind: k.kind })}
              className={
                "flex-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide transition-colors disabled:opacity-50 " +
                (active
                  ? "border-ember bg-ember/15 text-ember"
                  : "border-border bg-card/40 text-muted-foreground hover:bg-subtle")
              }
              title={k.label}
            >
              {k.label.toLowerCase()}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-1">
        <label className="text-meta text-muted-foreground" htmlFor={`edge-from-${edge.id}`}>
          from
        </label>
        <select
          id={`edge-from-${edge.id}`}
          value={meta.fromHandle ?? "auto"}
          onChange={(e) => updateHandle("from", e.target.value as HandleSide | "auto")}
          disabled={!onPatch}
          className="flex-1 rounded border border-border bg-card/40 px-1 py-0.5 text-[10px] disabled:opacity-50"
        >
          {sideOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <label className="text-meta text-muted-foreground" htmlFor={`edge-to-${edge.id}`}>
          to
        </label>
        <select
          id={`edge-to-${edge.id}`}
          value={meta.toHandle ?? "auto"}
          onChange={(e) => updateHandle("to", e.target.value as HandleSide | "auto")}
          disabled={!onPatch}
          className="flex-1 rounded border border-border bg-card/40 px-1 py-0.5 text-[10px] disabled:opacity-50"
        >
          {sideOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-between gap-1 pt-0.5">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-border bg-card/40 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-subtle"
        >
          Close
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning hover:bg-warning/20"
          title="Delete edge"
        >
          <Trash2 className="h-3 w-3" /> Delete
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

type CanvasCardProps = {
  node: HydratedNode;
  editingLane: boolean;
  editingNote: boolean;
  onEditLane: (nodeId: string, active: boolean) => void;
  onEditNote: (nodeId: string, active: boolean) => void;
  onMouseDown: (e: React.MouseEvent, node: HydratedNode) => void;
  onResizeMouseDown: (e: React.MouseEvent, node: HydratedNode) => void;
  onRemove: (nodeId: string) => void;
  onPatchLane: (nodeId: string, lane: string) => void;
  onTogglePreview: (nodeId: string, next: "preview" | "card") => void;
  handlesAlwaysShown: boolean;
  hovered: boolean;
  onHoverChange: (nodeId: string | null) => void;
  onConnectorStart: (nodeId: string, side: HandleSide, e: React.MouseEvent) => void;
};

// `React.memo` with a shallow geometry/meta check — during a drag only the
// moving card's `node` reference changes (overrides on the rest are absent),
// so memoized siblings skip work entirely.
const CanvasCard = memo(
  function CanvasCard({
    node,
    editingLane,
    editingNote,
    onEditLane,
    onEditNote,
    onMouseDown,
    onResizeMouseDown,
    onRemove,
    onPatchLane,
    onTogglePreview,
    handlesAlwaysShown,
    hovered,
    onHoverChange,
    onConnectorStart,
  }: CanvasCardProps) {
    const isLive = node.viewMode === "live";
    const isRunning =
      !node.ref.missing &&
      ((node.ref.meta?.status as string | undefined) === "RUNNING" ||
        (node.ref.meta?.status as string | undefined) === "ACTIVE");
    const glow = isLive && isRunning ? "ring-2 ring-ember/60 animate-pulse" : "";
    const kind = (node.ref.meta?.kind as string | undefined) ?? null;
    const isNote = node.targetType === "artifact" && kind === "NOTE";

    // Which node types support the inline-preview toggle. Attachments
    // always do; non-NOTE artifacts do iff their body hydrated through.
    const artifactPreviewKind: CanvasPreviewKind | null =
      !node.ref.missing &&
      node.targetType === "artifact" &&
      !isNote
        ? canvasKindForArtifact(node.ref.meta ?? {})
        : null;
    const isAttachment = !node.ref.missing && node.targetType === "attachment";
    const previewSupported =
      isAttachment ||
      (artifactPreviewKind !== null && artifactPreviewKind !== "unsupported");
    const previewActive = previewSupported && node.viewMode === "preview";

    const tone = node.ref.missing
      ? "border-warning/40 bg-warning/5"
      : isNote
        ? "border-amber-500/20 bg-amber-500/10"
        : "border-border bg-card/80";

    let body: React.ReactNode;
    if (node.ref.missing) {
      body = <div className="text-sm font-medium">Missing {node.targetType}</div>;
    } else if (node.targetType === "execution-plan") {
      body = <ExecutionPlanCardBody node={node} live={isLive} />;
    } else if (node.targetType === "execution-step") {
      body = <ExecutionStepCardBody node={node} />;
    } else if (node.targetType === "chat-thread") {
      body = <ChatThreadCardBody node={node} live={isLive} />;
    } else if (isNote) {
      body = (
        <NoteCardBody
          node={node}
          editing={editingNote}
          onEditChange={(active) => onEditNote(node.id, active)}
        />
      );
    } else if (isAttachment && previewActive) {
      body = <AttachmentPreviewCardBody node={node} />;
    } else if (
      artifactPreviewKind &&
      artifactPreviewKind !== "unsupported" &&
      previewActive
    ) {
      body = (
        <ArtifactPreviewCardBody
          node={node}
          previewKind={artifactPreviewKind}
        />
      );
    } else {
      body = (
        <>
          <div className="text-meta uppercase tracking-wide text-muted-foreground">
            {node.targetType.replace("-", " ")}
            {node.ref.subLabel ? <span> · {node.ref.subLabel}</span> : null}
          </div>
          <div className="line-clamp-3 text-sm font-medium">{node.ref.label}</div>
        </>
      );
    }

    const showHandles = handlesAlwaysShown || hovered;
    return (
      <div
        data-canvas-card
        data-node-id={node.id}
        className={`absolute flex flex-col gap-1.5 rounded-lg border p-3 shadow-md transition-all duration-300 hover:shadow-lg ${tone} ${glow}`}
        style={{
          left: node.x,
          top: node.y,
          width: node.width,
          minHeight: node.height,
        }}
        onMouseDown={(e) => onMouseDown(e, node)}
        onMouseEnter={() => onHoverChange(node.id)}
        onMouseLeave={() => onHoverChange(null)}
      >
        {showHandles ? (
          <>
            <ConnectorHandle
              nodeId={node.id}
              side="top"
              onMouseDown={onConnectorStart}
            />
            <ConnectorHandle
              nodeId={node.id}
              side="right"
              onMouseDown={onConnectorStart}
            />
            <ConnectorHandle
              nodeId={node.id}
              side="bottom"
              onMouseDown={onConnectorStart}
            />
            <ConnectorHandle
              nodeId={node.id}
              side="left"
              onMouseDown={onConnectorStart}
            />
          </>
        ) : null}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">{body}</div>
          <div className="flex flex-col items-end gap-0.5">
            {previewSupported ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePreview(node.id, previewActive ? "card" : "preview");
                }}
                className="rounded-md p-1 text-muted-foreground hover:bg-subtle"
                title={previewActive ? "Collapse to chip" : "Show inline preview"}
              >
                {previewActive ? (
                  <Minimize2 className="h-3 w-3" />
                ) : (
                  <ImageIcon className="h-3 w-3" />
                )}
              </button>
            ) : null}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEditLane(node.id, !editingLane);
              }}
              className="rounded-md p-1 text-muted-foreground hover:bg-subtle"
              title="Move to lane"
            >
              <Layers className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(node.id);
              }}
              className="rounded-md p-1 text-muted-foreground hover:bg-subtle"
              title="Remove from canvas"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>
        {editingLane ? (
          <LaneEditor
            current={(node.meta?.lane as string | undefined) ?? ""}
            onCancel={() => onEditLane(node.id, false)}
            onSave={(lane) => onPatchLane(node.id, lane)}
          />
        ) : null}
        {node.ref.url && !isNote ? (
          <a
            href={node.ref.url}
            onMouseDown={(e) => e.stopPropagation()}
            className="mt-auto inline-flex items-center gap-1 text-meta text-ember hover:underline"
          >
            Open <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
        <button
          type="button"
          aria-label="Resize"
          title="Drag to resize"
          onMouseDown={(e) => onResizeMouseDown(e, node)}
          className="absolute bottom-0.5 right-0.5 h-3 w-3 cursor-nwse-resize rounded-sm bg-border/40 hover:bg-ember/40"
        />
      </div>
    );
  },
  (prev, next) =>
    prev.node.id === next.node.id &&
    prev.node.x === next.node.x &&
    prev.node.y === next.node.y &&
    prev.node.width === next.node.width &&
    prev.node.height === next.node.height &&
    prev.node.viewMode === next.node.viewMode &&
    // Reference-equal meta/ref is enough — hydrate returns fresh refs
    // only when the underlying entity actually changed.
    prev.node.meta === next.node.meta &&
    prev.node.ref === next.node.ref &&
    prev.editingLane === next.editingLane &&
    prev.editingNote === next.editingNote &&
    prev.handlesAlwaysShown === next.handlesAlwaysShown &&
    prev.hovered === next.hovered &&
    prev.onEditLane === next.onEditLane &&
    prev.onEditNote === next.onEditNote &&
    prev.onMouseDown === next.onMouseDown &&
    prev.onResizeMouseDown === next.onResizeMouseDown &&
    prev.onRemove === next.onRemove &&
    prev.onPatchLane === next.onPatchLane &&
    prev.onTogglePreview === next.onTogglePreview &&
    prev.onHoverChange === next.onHoverChange &&
    prev.onConnectorStart === next.onConnectorStart,
);

// ---------------------------------------------------------------------------
// Connector handle — small dot rendered on each card side. Mousedown starts
// a connector drag; the parent renders the preview line.
// ---------------------------------------------------------------------------

const ConnectorHandle = memo(function ConnectorHandle({
  nodeId,
  side,
  onMouseDown,
}: {
  nodeId: string;
  side: HandleSide;
  onMouseDown: (nodeId: string, side: HandleSide, e: React.MouseEvent) => void;
}) {
  const pos: React.CSSProperties = (() => {
    switch (side) {
      case "top":
        return { top: -5, left: "50%", transform: "translate(-50%, 0)" };
      case "right":
        return { top: "50%", right: -5, transform: "translate(0, -50%)" };
      case "bottom":
        return { bottom: -5, left: "50%", transform: "translate(-50%, 0)" };
      case "left":
        return { top: "50%", left: -5, transform: "translate(0, -50%)" };
    }
  })();
  return (
    <span
      data-canvas-handle
      role="button"
      aria-label={`Connector handle ${side}`}
      onMouseDown={(e) => onMouseDown(nodeId, side, e)}
      className="absolute h-2.5 w-2.5 cursor-crosshair rounded-full border border-foreground/30 bg-card/80 text-foreground/60 shadow-sm transition-colors hover:border-ember hover:bg-ember hover:text-ember"
      style={pos}
    />
  );
});

function LaneEditor({
  current,
  onCancel,
  onSave,
}: {
  current: string;
  onCancel: () => void;
  onSave: (lane: string) => void;
}) {
  const [value, setValue] = useState(current);
  return (
    <div
      className="flex items-center gap-1"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        autoFocus
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave(value.trim());
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Lane name"
        className="flex-1 rounded border border-border bg-card/40 px-1.5 py-0.5 text-xs"
      />
      <button
        type="button"
        onClick={() => onSave(value.trim())}
        className="rounded border border-ember/40 bg-ember/15 px-1.5 py-0.5 text-[10px] text-ember"
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => onSave("")}
        className="rounded border border-border bg-card/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
      >
        Clear
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-type bodies
// ---------------------------------------------------------------------------

function statusToneClasses(status: string | undefined): string {
  switch (status) {
    case "RUNNING":
      return "border-ember/40 bg-ember/15 text-ember";
    case "DONE":
    case "COMPLETED":
      return "border-success/40 bg-success/10 text-success";
    case "BLOCKED":
    case "CANCELED":
      return "border-warning/40 bg-warning/10 text-warning";
    case "REVIEW":
      return "border-ember/30 bg-ember/10 text-ember";
    case "READY":
    case "APPROVED":
      return "border-border bg-subtle text-foreground";
    default:
      return "border-border bg-card/40 text-muted-foreground";
  }
}

function StatusBadge({ status }: { status: string | undefined }) {
  if (!status) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${statusToneClasses(status)}`}
    >
      {status.toLowerCase()}
    </span>
  );
}

function ExecutionPlanCardBody({ node, live }: { node: HydratedNode; live: boolean }) {
  const meta = (node.ref.meta ?? {}) as {
    status?: string;
    stepCount?: number;
    doneSteps?: number;
    runningSteps?: number;
    progress?: number;
  };
  const total = meta.stepCount ?? 0;
  const done = meta.doneSteps ?? 0;
  const running = meta.runningSteps ?? 0;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-meta uppercase tracking-wide text-muted-foreground">Plan</span>
        <StatusBadge status={meta.status} />
      </div>
      <div className="line-clamp-2 text-sm font-medium">{node.ref.label}</div>
      <div className="flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-subtle">
          <div
            className="h-full rounded-full bg-ember/70 transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-meta tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
      </div>
      {live && running > 0 ? (
        <div className="inline-flex items-center gap-1.5 text-meta text-ember">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ember/60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ember" />
          </span>
          Running · {running} step{running === 1 ? "" : "s"}
        </div>
      ) : null}
    </div>
  );
}

function ExecutionStepCardBody({ node }: { node: HydratedNode }) {
  const meta = (node.ref.meta ?? {}) as {
    status?: string;
    position?: number;
    expectedOutput?: string | null;
    assignedAgent?: { name: string; profileKey: string } | null;
    assignedUser?: { name: string | null; email: string } | null;
  };
  const positionLabel =
    typeof meta.position === "number" ? `#${meta.position + 1}` : null;
  const assigneeLabel = meta.assignedAgent
    ? `@${meta.assignedAgent.profileKey}`
    : meta.assignedUser
      ? meta.assignedUser.name || meta.assignedUser.email
      : null;
  const assigneeIcon = meta.assignedAgent ? (
    <Bot className="h-3 w-3" />
  ) : meta.assignedUser ? (
    <UserIcon className="h-3 w-3" />
  ) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {positionLabel ? (
          <span className="rounded-full border border-border bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {positionLabel}
          </span>
        ) : null}
        <span className="text-meta uppercase tracking-wide text-muted-foreground">Step</span>
        <StatusBadge status={meta.status} />
      </div>
      <div className="line-clamp-2 text-sm font-medium">{node.ref.label}</div>
      {assigneeLabel ? (
        <div className="inline-flex items-center gap-1 text-meta text-muted-foreground">
          {assigneeIcon}
          <span className="truncate">{assigneeLabel}</span>
        </div>
      ) : null}
      {meta.expectedOutput ? (
        <p className="line-clamp-2 text-meta text-muted-foreground">{meta.expectedOutput}</p>
      ) : null}
    </div>
  );
}

function ChatThreadCardBody({ node, live }: { node: HydratedNode; live: boolean }) {
  const meta = (node.ref.meta ?? {}) as {
    agent?: { profileKey?: string; name?: string; avatar?: string | null };
    lastMessageAt?: string | Date | null;
    preview?: Array<{ id: string; role: string; body: string; createdAt: string | Date }>;
  };
  const profileKey = node.ref.subLabel?.replace(/^@/, "") ?? meta.agent?.profileKey;
  const previewFromMeta = meta.preview ?? [];
  const lastPreview = previewFromMeta[previewFromMeta.length - 1];
  const lastBody = lastPreview?.body;
  const lastAt = meta.lastMessageAt;
  // When `live` mode is on we fetch the freshest messages directly so the
  // card stays current as the thread receives replies. Falls back to the
  // hydrated `preview` snapshot for non-live cards.
  const threadDetail = trpc.chat.getThread.useQuery(
    { threadId: node.targetId },
    { enabled: live, staleTime: 15_000, refetchOnWindowFocus: false },
  );
  const recent = threadDetail.data?.messages?.slice(-3) ?? previewFromMeta;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <MessageCircle className="h-3 w-3 text-ember" />
        <span className="text-meta uppercase tracking-wide text-muted-foreground">
          Chat · @{profileKey}
        </span>
        {lastAt ? (
          <span className="ml-auto text-meta text-muted-foreground">
            {relativeTime(lastAt)}
          </span>
        ) : null}
      </div>
      <div className="line-clamp-2 text-sm font-medium">{node.ref.label}</div>
      {!live && lastBody ? (
        <p className="line-clamp-2 text-meta text-muted-foreground">{lastBody}</p>
      ) : null}
      {live && recent.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {recent.map((m) => (
            <li
              key={m.id}
              className={
                "rounded-md border px-2 py-1 text-[11px] leading-snug " +
                (m.role === "USER"
                  ? "border-ember/30 bg-ember/5"
                  : "border-border bg-card/60")
              }
            >
              <div className="line-clamp-2">{m.body}</div>
            </li>
          ))}
        </ul>
      ) : null}
      {node.ref.url ? (
        <a
          href={node.ref.url}
          onMouseDown={(e) => e.stopPropagation()}
          className="mt-auto inline-flex items-center gap-1 text-meta text-ember hover:underline"
        >
          Open chat <ExternalLink className="h-3 w-3" />
        </a>
      ) : null}
    </div>
  );
}

function NoteCardBody({
  node,
  editing,
  onEditChange,
}: {
  node: HydratedNode;
  editing: boolean;
  onEditChange: (active: boolean) => void;
}) {
  const utils = trpc.useUtils();
  // `artifact.update` exists today; we use it for inline note editing.
  const updateArtifactAny = (trpc as unknown as Record<string, unknown>).artifact as
    | Record<string, unknown>
    | undefined;
  const updateMutAny = (updateArtifactAny?.update as
    | {
        useMutation: (opts?: unknown) => {
          mutate: (input: { id: string; body: string }) => void;
          isPending: boolean;
        };
      }
    | undefined)?.useMutation({
    onSuccess: () => {
      utils.canvas.hydrate.invalidate();
      onEditChange(false);
    },
    onError: (e: { message: string }) => toast.error(e.message),
  });
  const summary = (node.ref.meta?.summary as string | undefined) ?? "";
  const body =
    typeof node.ref.meta?.body === "string"
      ? (node.ref.meta.body as string)
      : summary || node.ref.label;
  const [draft, setDraft] = useState(body);

  useEffect(() => {
    if (editing) setDraft(body);
  }, [editing, body]);

  if (editing && updateMutAny) {
    return (
      <div
        className="flex flex-col gap-1.5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={5}
          className="w-full rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-sm text-foreground"
        />
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => updateMutAny.mutate({ id: node.targetId, body: draft })}
            disabled={updateMutAny.isPending}
            className="rounded border border-ember/40 bg-ember/15 px-2 py-0.5 text-[10px] text-ember"
          >
            {updateMutAny.isPending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => onEditChange(false)}
            className="rounded border border-border bg-card/40 px-2 py-0.5 text-[10px] text-muted-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div
      className="flex flex-col gap-1.5"
      onDoubleClick={(e) => {
        if (!updateMutAny) return;
        e.stopPropagation();
        onEditChange(true);
      }}
    >
      <div className="flex items-center gap-1.5">
        <StickyNote className="h-3 w-3 text-amber-500/80" />
        <span className="text-meta uppercase tracking-wide text-amber-500/80">Note</span>
        {!updateMutAny ? (
          <span
            className="ml-auto text-[10px] text-muted-foreground"
            title="Read-only — artifact.update unavailable"
          >
            read-only
          </span>
        ) : null}
      </div>
      <div className="text-[0.78rem] leading-relaxed text-foreground">
        <ChatMarkdown body={body} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline preview bodies — attachments (lazy presigned URL fetch) and
// non-NOTE artifacts (body / bodyKind from hydration). Both render
// through the shared `CanvasPreview` component so the kind matrix stays
// in one place.
// ---------------------------------------------------------------------------

function AttachmentPreviewCardBody({ node }: { node: HydratedNode }) {
  const lightbox = useAttachmentLightbox();
  const meta = (node.ref.meta ?? {}) as {
    kind?: string;
    mimeType?: string;
    filename?: string;
    size?: number;
    externalUrl?: string | null;
  };
  const isLink = meta.kind === "LINK" || meta.mimeType === "text/url";
  // Lazy presigned URL — same query the lightbox uses, so hovering /
  // expanding the card hits the same 5-min staleTime cache. LINK rows
  // skip the call and route to `externalUrl` directly.
  const dl = trpc.attachment.getDownloadUrl.useQuery(
    { attachmentId: node.targetId },
    {
      enabled: !isLink,
      staleTime: 5 * 60_000,
      retry: false,
    },
  );
  const previewKind = canvasKindForAttachment(meta);
  const url = isLink ? meta.externalUrl ?? null : dl.data?.url ?? null;
  // Header — filename + mime chip. Padding mirrors the legacy card body.
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-meta uppercase tracking-wide text-muted-foreground">
          attachment
        </span>
        {meta.mimeType ? (
          <span className="truncate font-mono text-id text-muted-foreground">
            {meta.mimeType}
          </span>
        ) : null}
      </div>
      <div className="truncate text-filename text-foreground">
        {meta.filename ?? node.ref.label}
      </div>
      <CanvasPreview
        kind={previewKind}
        mimeType={meta.mimeType ?? null}
        filename={meta.filename ?? null}
        url={url}
        height={Math.max(120, node.height - 60)}
        onExpand={() => {
          if (isLink) {
            if (meta.externalUrl) {
              window.open(meta.externalUrl, "_blank", "noopener,noreferrer");
            }
            return;
          }
          // FILE rows open the existing lightbox — same source of truth
          // for keyboard paging and delete confirmation.
          lightbox.open({
            attachmentId: node.targetId,
            attachments: [
              {
                id: node.targetId,
                filename: meta.filename ?? node.ref.label,
                mimeType: meta.mimeType ?? "",
                size: meta.size ?? 0,
                kind: (meta.kind as "FILE" | "LINK" | undefined) ?? "FILE",
                externalUrl: meta.externalUrl ?? null,
              },
            ],
          });
        }}
      />
    </div>
  );
}

function ArtifactPreviewCardBody({
  node,
  previewKind,
}: {
  node: HydratedNode;
  previewKind: CanvasPreviewKind;
}) {
  const meta = (node.ref.meta ?? {}) as {
    kind?: string;
    body?: string;
    summary?: string;
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-meta uppercase tracking-wide text-muted-foreground">
          {(meta.kind ?? "artifact").toLowerCase()}
        </span>
        {node.ref.subLabel && node.ref.subLabel !== (meta.kind ?? "").toLowerCase() ? (
          <span className="truncate text-meta text-muted-foreground">
            {node.ref.subLabel}
          </span>
        ) : null}
      </div>
      <div className="truncate text-sm font-medium text-foreground">
        {node.ref.label}
      </div>
      <CanvasPreview
        kind={previewKind}
        body={meta.body ?? null}
        filename={node.ref.label}
        height={Math.max(120, node.height - 60)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddCardPicker (extended: chat-thread + agent tabs)
// ---------------------------------------------------------------------------

function AddCardPicker({
  canvasId,
  onClose,
}: {
  canvasId: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const ws = useWorkspace();
  const [tab, setTab] = useState<"issue" | "artifact" | "chat-thread" | "agent">("issue");

  const issues = trpc.issue.list.useQuery({ limit: 25 }, { enabled: tab === "issue" });
  const artifacts = trpc.artifact.list.useQuery(
    { limit: 25 },
    { enabled: tab === "artifact" },
  );
  const threads = trpc.chat.threads.useQuery(undefined, { enabled: tab === "chat-thread" });
  const agents = trpc.agent.list.useQuery({ includeArchived: false }, { enabled: tab === "agent" });

  const addNode = trpc.canvas.addNode.useMutation({
    onSuccess: () => {
      toast.success("Card added");
      utils.canvas.hydrate.invalidate({ id: canvasId });
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const addCard = (targetType: "issue" | "artifact" | "chat-thread" | "agent", targetId: string) => {
    // Mirror the drop-target default: artifact cards open in `preview`
    // so the operator immediately sees the rendered body / file.
    const viewMode = targetType === "artifact" ? "preview" : undefined;
    addNode.mutate({
      canvasId,
      targetType,
      targetId,
      x: 40 + Math.random() * 200,
      y: 40 + Math.random() * 200,
      width: 280,
      height: viewMode === "preview" ? 220 : 120,
      viewMode,
    });
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-md flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-medium">Add card</h2>
        <div className="flex gap-1.5">
          {(["issue", "artifact", "chat-thread", "agent"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md border px-2 py-1 text-xs transition-all duration-200 ${
                tab === t
                  ? "border-ember bg-ember/15 text-ember"
                  : "border-border bg-card/40 text-muted-foreground hover:bg-subtle"
              }`}
            >
              {t.replace("-", " ")}
            </button>
          ))}
        </div>
        <ul className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
          {tab === "issue" &&
            (issues.data?.items ?? []).map((row) => (
              <li key={row.id}>
                <button
                  onClick={() => addCard("issue", row.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-card/40 px-2 py-1.5 text-left transition-all duration-200 hover:border-ember/40"
                >
                  <span className="truncate text-sm">{row.title}</span>
                  <span className="font-mono text-id text-muted-foreground">
                    {ws.key}-{row.number}
                  </span>
                </button>
              </li>
            ))}
          {tab === "artifact" &&
            (artifacts.data?.items ?? []).map((row) => (
              <li key={row.id}>
                <button
                  onClick={() => addCard("artifact", row.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-card/40 px-2 py-1.5 text-left transition-all duration-200 hover:border-ember/40"
                >
                  <span className="truncate text-sm">{row.title}</span>
                  <span className="text-meta text-muted-foreground">
                    {row.type.toLowerCase()}
                  </span>
                </button>
              </li>
            ))}
          {tab === "chat-thread" &&
            (threads.data ?? []).map((row) => (
              <li key={row.id}>
                <button
                  onClick={() => addCard("chat-thread", row.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-card/40 px-2 py-1.5 text-left transition-all duration-200 hover:border-ember/40"
                >
                  <span className="truncate text-sm">
                    {row.title || row.topic || `Chat with @${row.agent.profileKey}`}
                  </span>
                  <span className="font-mono text-id text-muted-foreground">
                    @{row.agent.profileKey}
                  </span>
                </button>
              </li>
            ))}
          {tab === "agent" &&
            (agents.data ?? []).map((row) => (
              <li key={row.id}>
                <button
                  onClick={() => addCard("agent", row.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-card/40 px-2 py-1.5 text-left transition-all duration-200 hover:border-ember/40"
                >
                  <span className="truncate text-sm">{row.name}</span>
                  <span className="font-mono text-id text-muted-foreground">
                    @{row.profileKey}
                  </span>
                </button>
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entity rail — draggable list of issues / artifacts / chats / agents.
// ---------------------------------------------------------------------------

function CanvasEntityRail({ canvasId: _canvasId }: { canvasId: string }) {
  const ws = useWorkspace();
  const [tab, setTab] = useState<"issue" | "artifact" | "chat-thread" | "agent">("issue");
  const [query, setQuery] = useState("");

  const issues = trpc.issue.list.useQuery({ limit: 50 }, { enabled: tab === "issue" });
  const artifacts = trpc.artifact.list.useQuery({ limit: 50 }, { enabled: tab === "artifact" });
  const threads = trpc.chat.threads.useQuery(undefined, { enabled: tab === "chat-thread" });
  const agents = trpc.agent.list.useQuery({ includeArchived: false }, { enabled: tab === "agent" });

  const q = query.trim().toLowerCase();

  const items = (() => {
    if (tab === "issue") {
      return (issues.data?.items ?? [])
        .filter((r) => !q || r.title.toLowerCase().includes(q))
        .map((r) => ({
          id: r.id,
          label: r.title,
          sub: `${ws.key}-${r.number}`,
          type: "issue" as const,
        }));
    }
    if (tab === "artifact") {
      return (artifacts.data?.items ?? [])
        .filter((r) => !q || r.title.toLowerCase().includes(q))
        .map((r) => ({
          id: r.id,
          label: r.title,
          sub: r.type.toLowerCase(),
          type: "artifact" as const,
        }));
    }
    if (tab === "chat-thread") {
      return (threads.data ?? [])
        .filter(
          (r) =>
            !q ||
            (r.title ?? "").toLowerCase().includes(q) ||
            r.agent.profileKey.toLowerCase().includes(q),
        )
        .map((r) => ({
          id: r.id,
          label: r.title || r.topic || `Chat with @${r.agent.profileKey}`,
          sub: `@${r.agent.profileKey}`,
          type: "chat-thread" as const,
        }));
    }
    return (agents.data ?? [])
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.profileKey.toLowerCase().includes(q))
      .map((r) => ({
        id: r.id,
        label: r.name,
        sub: `@${r.profileKey}`,
        type: "agent" as const,
      }));
  })();

  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-r border-border bg-card/50">
      <div className="border-b border-border px-2 pb-2 pt-2.5">
        <div className="text-meta uppercase tracking-wider text-muted-foreground">
          Drag to canvas
        </div>
        <div className="mt-1.5 flex gap-1">
          {(["issue", "artifact", "chat-thread", "agent"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={
                "flex-1 rounded border px-1 py-0.5 text-[10px] uppercase tracking-wide transition-all duration-200 " +
                (tab === t
                  ? "border-ember bg-ember/15 text-ember"
                  : "border-border bg-card/40 text-muted-foreground hover:bg-subtle")
              }
            >
              {t === "chat-thread" ? "chat" : t}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="mt-1.5 w-full rounded border border-border bg-card/40 px-1.5 py-0.5 text-xs"
        />
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1.5">
        {items.map((it) => (
          <li key={it.id}>
            <RailDraggable item={it} />
          </li>
        ))}
        {items.length === 0 ? (
          <li className="px-2 py-3 text-meta text-muted-foreground">No results.</li>
        ) : null}
      </ul>
    </aside>
  );
}

function RailDraggable({
  item,
}: {
  item: { id: string; label: string; sub: string; type: "issue" | "artifact" | "chat-thread" | "agent" };
}) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(
          "application/x-forge-entity",
          JSON.stringify({ type: item.type, id: item.id }),
        );
      }}
      className="flex w-full flex-col items-start gap-px rounded-md border border-transparent px-2 py-1 text-left text-xs transition-all duration-200 hover:border-ember/40 hover:bg-subtle active:scale-[0.99]"
      title="Drag onto canvas"
    >
      <span className="truncate text-foreground">{item.label}</span>
      <span className="font-mono text-id text-muted-foreground">{item.sub}</span>
    </button>
  );
}
