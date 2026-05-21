"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ChevronLeft,
  ExternalLink,
  GitBranch,
  Image as ImageIcon,
  Layers,
  LayoutGrid,
  Maximize2,
  MessageCircle,
  Minimize2,
  Play,
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
  CanvasFrames,
  type CanvasFrameRow,
} from "@/components/canvas/canvas-frames";
import { CanvasPageTabs } from "@/components/canvas/canvas-page-tabs";
import { CanvasPresentation } from "@/components/canvas/canvas-presentation";
import {
  CanvasToolbar,
  DEFAULT_STYLE_STATE,
  type StyleState,
  type ToolKind,
} from "@/components/canvas/canvas-toolbar";
import { CanvasRightPanel } from "@/components/canvas/canvas-right-panel";
import { CanvasComponentInstances } from "@/components/canvas/canvas-component-instances";
import {
  CanvasSelectionInspector,
  type InspectorPatch,
  type InspectorSelection,
} from "@/components/canvas/canvas-selection-inspector";
import { computeSnap } from "@/lib/canvas-snap-guides";
import { useCanvasUndoStack } from "@/lib/canvas-undo";
import {
  CanvasEntityCreator,
  type EntityCreatorAnchor,
} from "@/components/canvas/canvas-entity-creator";
import {
  CanvasContextMenu,
  type ContextMenuItem,
} from "@/components/canvas/canvas-context-menu";
import {
  COMPONENT_DRAG_MIME,
  type ComponentDragPayload,
  type ComponentSelectionSnapshot,
} from "@/components/canvas/canvas-components-panel";
import type { LayerSelectionRef } from "@/components/canvas/canvas-layers-panel";
import { routeEdge, type HandleSide, type Rect } from "@/lib/canvas-routing";
import {
  easeOutCubic,
  lerpViewport,
  viewportsClose,
  computeFitViewport,
  prefersReducedMotion,
} from "@/lib/canvas-camera";
import { uploadAttachmentFile } from "@/components/attachments/attachment-upload-client";
import {
  parseAutoLayout,
  computeAutoLayout,
  type AutoLayoutChild,
} from "@/lib/canvas-auto-layout";

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

// Above this many shapes, the render list is culled to the visible viewport.
const VIRTUALIZE_THRESHOLD = 200;

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
    }
  | {
      kind: "frame-move";
      primaryFrameId: string;
      /** All frames to translate — primary + cascaded child frames. */
      frameIds: string[];
      /** Initial pointer-to-frame offset for the primary, in canvas space. */
      offsetX: number;
      offsetY: number;
      /** Initial (x, y) of every frame that moves; used to compute the delta. */
      frameOrigins: Record<string, { x: number; y: number }>;
      /** Children that follow the primary, by kind. Stored as relative
       * offsets from each child's origin so the live drag matches the
       * server-side cascade in framePatch. */
      childNodeIds: string[];
      childShapeIds: string[];
    };

type ShapeDraft = {
  // Allows "frame" so the same draw-gesture infrastructure can author
  // CanvasFrame rows; commit branches on `kind === "frame"` to call
  // frameAdd instead of shapeAdd.
  kind: ShapeKind | "frame";
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

type SelectedRef = {
  kind: "node" | "shape" | "frame" | "group" | "instance";
  id: string;
};

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

// Image MIME types we accept as canvas image shapes (subset of the storage
// allowlist that browsers can render inline).
const CANVAS_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

/** Read an image file's natural pixel size (best-effort). */
function readImageSize(file: File): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth || 240, h: img.naturalHeight || 180 });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image"));
    };
    img.src = url;
  });
}

function cursorForTool(tool: ToolKind, panning: boolean, draftingConnector: boolean): string {
  if (panning) return "grabbing";
  if (draftingConnector) return "crosshair";
  switch (tool) {
    case "select":
      return "default";
    case "pan":
      return "grab";
    case "connect":
    case "frame":
    case "box":
    case "ellipse":
    case "line":
    case "arrow":
    case "freehand":
    case "sticky":
      return "crosshair";
    case "text":
      return "text";
    case "comment-pin":
      return "help";
    case "stamp":
      return "copy";
    case "entity-create":
      return "crosshair";
    case "eraser":
      return "crosshair";
    default:
      return "default";
  }
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
  // Persist the dashboard view so the List/Canvas toggle round-trips
  // coherently when this is the user's personal canvas.
  const setDashboardViewMut = trpc.user.setDashboardView.useMutation();
  const utils = trpc.useUtils();
  const meQ = trpc.user.me.useQuery(undefined, { staleTime: 5 * 60_000 });
  const myUserId = meQ.data?.id ?? null;

  const { data, isLoading } = trpc.canvas.hydrate.useQuery({ id: params.canvasId });

  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  // Always-fresh mirror of viewport for RAF loops (camera tween, inertial
  // pan momentum) that can't depend on a captured-stale state closure.
  const viewportRef = useRef(viewport);
  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);
  const [panning, setPanning] = useState(false);
  const panStart = useRef<{ vx: number; vy: number; mx: number; my: number } | null>(null);
  // Inertial-pan + camera-tween RAF handles.
  const cameraRafRef = useRef<number | null>(null);
  const panMomentumRafRef = useRef<number | null>(null);
  // Velocity sampled during a drag-pan so release can fling with momentum.
  const panVelRef = useRef<{ x: number; y: number; t: number; vx: number; vy: number } | null>(null);
  const dragNode = useRef<DragPayload | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // Hidden file input backing the toolbar "Insert image" button.
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [openPicker, setOpenPicker] = useState(false);
  const [openSidebar, setOpenSidebar] = useState(true);
  const [openSettings, setOpenSettings] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [editingLaneFor, setEditingLaneFor] = useState<string | null>(null);
  const [editingNoteFor, setEditingNoteFor] = useState<string | null>(null);
  // Inline text-shape editor — set the moment a text shape is created
  // OR when one is double-clicked, cleared on commit / Esc / blur.
  const [editingShapeFor, setEditingShapeFor] = useState<string | null>(null);
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
  const selectedFrameIds = useMemo(
    () => new Set(selected.filter((s) => s.kind === "frame").map((s) => s.id)),
    [selected],
  );
  const selectedInstanceIds = useMemo(
    () => new Set(selected.filter((s) => s.kind === "instance").map((s) => s.id)),
    [selected],
  );
  const activeToolRef = useRef<ToolKind>(activeTool);
  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);

  // Inline entity-create popover anchor (W1.2). When set, the
  // `<CanvasEntityCreator>` mounts at this position; on commit it
  // calls `issue.create` / `note.create`, then we drop a CanvasNode
  // at the canvas-space anchor and return to Select.
  const [entityCreator, setEntityCreator] = useState<EntityCreatorAnchor | null>(null);

  // W3.3: right-click context menu. State holds viewport-space x/y +
  // the menu items the parent built for this hit target. Null = no
  // menu open.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

  // W2.1: tool sticky-lock. When true, draw tools don't auto-return
  // to Select after a single commit. Toggled by Shift+click on the
  // toolbar button. Indicator: ember dot on the active tool.
  const [stickyToolLock, setStickyToolLock] = useState(false);
  const stickyToolLockRef = useRef(stickyToolLock);
  useEffect(() => {
    stickyToolLockRef.current = stickyToolLock;
  }, [stickyToolLock]);

  // W2.1: space-to-pan. Holding Space temporarily flips any tool to
  // Pan; releasing restores the previous tool. Stored as a ref so the
  // global keyboard listener doesn't fight against React state churn.
  const spacePanPrevToolRef = useRef<ToolKind | null>(null);

  // W3.1: client-side undo / redo stack. Records pushed at mutation
  // commit sites (shape move, shape add, shape delete); ⌘Z / ⌘⇧Z
  // pop and re-run.
  const undoStack = useCanvasUndoStack(params.canvasId);

  // W3.2: in-memory clipboard for copy/paste. Cleared on canvas
  // change. Shapes only for v1; nodes/edges/frames can extend the
  // same pattern.
  const canvasClipboardRef = useRef<{
    shapes: Array<{
      kind: string;
      width: number | null;
      height: number | null;
      path: unknown;
      style: unknown;
      text: string | null;
      groupId: string | null;
      relX: number;
      relY: number;
    }>;
    /** Origin used to compute paste positions — the top-left of the
     *  selection bbox at copy time. */
    originX: number;
    originY: number;
  }>({ shapes: [], originX: 0, originY: 0 });
  const toolbarStyleRef = useRef<StyleState>(toolbarStyle);
  useEffect(() => {
    toolbarStyleRef.current = toolbarStyle;
  }, [toolbarStyle]);

  // Live drag overrides for shapes — mirrors the node `dragOverridesRef`
  // pattern. Keyed by shape id; value is delta in canvas-space.
  const shapeDragOverridesRef = useRef<Map<string, { dx: number; dy: number }>>(new Map());
  // Live drag overrides for frames — absolute (x, y) in canvas-space so the
  // CanvasFrames renderer can read them without recomputing the origin.
  const frameDragOverridesRef = useRef<Map<string, { x: number; y: number }>>(new Map());

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

  // Smart alignment guides + distance labels (W1.4). Populated by the
  // shape-move drag handler when there's exactly one shape in the
  // active drag set. Cleared on drag end. The SnapGuidesLayer reads it
  // via `dragRev` so it repaints in lock-step with drag updates.
  const snapGuidesRef = useRef<{
    guides: Array<{ axis: "x" | "y"; at: number; spanStart: number; spanEnd: number }>;
    labels: Array<{ x: number; y: number; value: number; axis: "x" | "y" }>;
    sizeLabel: { x: number; y: number; width: number; height: number } | null;
  }>({ guides: [], labels: [], sizeLabel: null });

  // W2.4: grid-snap target highlight. Set during drag when grid-snap
  // applies (and no smart-snap fired). Lets the operator see where the
  // grid is pulling them — a 1-cell-wide ember band on the row+column.
  const gridSnapHighlightRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

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

  // -- Camera motion: eased tween + inertial pan ----------------------
  // All "jump the camera somewhere" actions (fit, reset, fit-selection,
  // present-mode slide moves) route through animateViewportTo so the move
  // eases instead of snapping. Continuous gestures (wheel zoom/pan, drag)
  // stay instant and call cancelCameraMotion first.
  const cancelCameraMotion = useCallback(() => {
    if (cameraRafRef.current != null) {
      cancelAnimationFrame(cameraRafRef.current);
      cameraRafRef.current = null;
    }
    if (panMomentumRafRef.current != null) {
      cancelAnimationFrame(panMomentumRafRef.current);
      panMomentumRafRef.current = null;
    }
  }, []);

  const persistViewport = useCallback(
    (v: Viewport) => setViewportMut.mutate({ id: params.canvasId, viewport: v }),
    [params.canvasId, setViewportMut],
  );

  const animateViewportTo = useCallback(
    (target: Viewport, durationMs = 340) => {
      cancelCameraMotion();
      const start = viewportRef.current;
      if (prefersReducedMotion() || viewportsClose(start, target) || durationMs <= 0) {
        setViewport(target);
        persistViewport(target);
        return;
      }
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / durationMs);
        setViewport(lerpViewport(start, target, easeOutCubic(t)));
        if (t < 1) {
          cameraRafRef.current = requestAnimationFrame(step);
        } else {
          cameraRafRef.current = null;
          setViewport(target);
          persistViewport(target);
        }
      };
      cameraRafRef.current = requestAnimationFrame(step);
    },
    [cancelCameraMotion, persistViewport],
  );

  // Fling the canvas after a drag-pan release. Velocity is in viewport-px
  // per ms; friction decays it ~7%/frame (time-corrected) until it stalls.
  const startPanMomentum = useCallback(
    (vx0: number, vy0: number) => {
      cancelCameraMotion();
      if (prefersReducedMotion()) {
        persistViewport(viewportRef.current);
        return;
      }
      // Clamp absurd flings (fast trackpad whips) to keep it controllable.
      const cap = 3.5;
      let vx = Math.max(-cap, Math.min(cap, vx0));
      let vy = Math.max(-cap, Math.min(cap, vy0));
      let last = performance.now();
      const step = (now: number) => {
        const dt = Math.min(64, now - last);
        last = now;
        setViewport((v) => ({ ...v, x: v.x + vx * dt, y: v.y + vy * dt }));
        const decay = Math.pow(0.93, dt / 16);
        vx *= decay;
        vy *= decay;
        if (Math.hypot(vx, vy) > 0.02) {
          panMomentumRafRef.current = requestAnimationFrame(step);
        } else {
          panMomentumRafRef.current = null;
          persistViewport(viewportRef.current);
        }
      };
      panMomentumRafRef.current = requestAnimationFrame(step);
    },
    [cancelCameraMotion, persistViewport],
  );

  useEffect(() => cancelCameraMotion, [cancelCameraMotion]);

  const removeNode = trpc.canvas.removeNode.useMutation({
    onSuccess: () => utils.canvas.hydrate.invalidate({ id: params.canvasId }),
    onError: (e) => toast.error(e.message),
  });

  // Image-shape uploads ride the standard attachment flow (initUpload →
  // PUT → finalize) with targetType "canvas".
  const initUploadMut = trpc.attachment.initUpload.useMutation();
  const finalizeAttachmentMut = trpc.attachment.finalize.useMutation();

  const addNode = trpc.canvas.addNode.useMutation({
    onSuccess: () => {
      toast.success("Card added");
      utils.canvas.hydrate.invalidate({ id: params.canvasId });
    },
    onError: (e) => toast.error(e.message),
  });

  // Drop-from-components-panel → placement of a `CanvasComponentInstance`.
  // The right panel emits an `application/x-forge-canvas-component` mime
  // type; `onSurfaceDrop` reads it and calls into this mutation.
  const createInstance = trpc.canvas.instanceCreate.useMutation({
    onSuccess: () => {
      toast.success("Component placed");
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

  // -- Undoable shape create / delete (W3.1 expansion) ----------------
  // `createShape` adds a shape and records an undo entry so Cmd+Z removes
  // it; redo re-adds and re-captures the new row id. `removeShapeUndoable`
  // snapshots a shape before deleting so undo re-creates it. Both keep a
  // mutable id box because each redo/undo cycle mints a fresh server row.
  const recordShapeAdd = useCallback(
    (initialId: string, recreate: ShapeAddInput, describe: string) => {
      const box = { id: initialId };
      undoStack.push({
        describe,
        undoIt: () => {
          if (shapeRemoveMut && box.id) shapeRemoveMut.mutate({ id: box.id });
        },
        doIt: () => {
          if (!shapeAddMut) return;
          shapeAddMut
            .mutateAsync(recreate)
            .then((r: { id: string }) => {
              box.id = r.id;
            })
            .catch(() => {});
        },
      });
    },
    [undoStack, shapeAddMut, shapeRemoveMut],
  );

  const createShape = useCallback(
    async (input: ShapeAddInput, describe?: string): Promise<{ id: string } | null> => {
      if (!shapeAddMut) return null;
      try {
        const res = await shapeAddMut.mutateAsync(input);
        recordShapeAdd(res.id, input, describe ?? `add ${input.kind}`);
        return res;
      } catch {
        return null;
      }
    },
    [shapeAddMut, recordShapeAdd],
  );

  const removeShapeUndoable = useCallback(
    (shapeId: string) => {
      if (!shapeRemoveMut) return;
      const s = shapesRef.current.find((sh) => sh.id === shapeId);
      shapeRemoveMut.mutate({ id: shapeId });
      if (!s) return;
      // Snapshot for re-create. Drop server-managed fields.
      const recreate: ShapeAddInput = {
        canvasId: params.canvasId,
        kind: s.kind as ShapeAddInput["kind"],
        x: s.x,
        y: s.y,
      };
      if (s.width != null) recreate.width = s.width;
      if (s.height != null) recreate.height = s.height;
      if (s.path != null) recreate.path = s.path;
      if (s.style != null) recreate.style = s.style as Record<string, unknown>;
      if (s.text != null) recreate.text = s.text;
      if (s.groupId != null) recreate.groupId = s.groupId;
      const box = { id: shapeId };
      undoStack.push({
        describe: `delete ${s.kind}`,
        doIt: () => {
          if (shapeRemoveMut && box.id) shapeRemoveMut.mutate({ id: box.id });
        },
        undoIt: () => {
          if (!shapeAddMut) return;
          shapeAddMut
            .mutateAsync(recreate)
            .then((r: { id: string }) => {
              box.id = r.id;
            })
            .catch(() => {});
        },
      });
    },
    [shapeRemoveMut, shapeAddMut, undoStack, params.canvasId],
  );

  // Frame mutations — backend exposes flat frameAdd / framePatch. Probe
  // via the any-router so a stale server falls through gracefully.
  type FrameAddInput = {
    canvasId: string;
    parentFrameId?: string | null;
    name?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    isPage?: boolean;
  };
  type FramePatchInput = {
    frameId: string;
    name?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  type FrameRemoveInput = { frameId: string; reparentChildren?: boolean };
  const frameAddAny = canvasRouterAny?.frameAdd as
    | ShapeMutationHook<FrameAddInput, { id: string }>
    | undefined;
  const framePatchAny = canvasRouterAny?.framePatch as
    | ShapeMutationHook<FramePatchInput, { ok: true }>
    | undefined;
  const frameRemoveAny = canvasRouterAny?.frameRemove as
    | ShapeMutationHook<FrameRemoveInput, { ok: true }>
    | undefined;
  const frameAddMut = frameAddAny?.useMutation({
    onSuccess: () => invalidateHydrate(),
    onError: (e) => toast.error(e.message),
  });
  const framePatchMut = framePatchAny?.useMutation({
    onSuccess: () => invalidateHydrate(),
    onError: (e) => toast.error(e.message),
  });
  const frameRemoveMut = frameRemoveAny?.useMutation({
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

  // Frames from extended hydrate. `?? []` guards backends that haven't
  // run the unified-workspace migration yet.
  const frames = useMemo<CanvasFrameRow[]>(() => {
    const raw = (data as unknown as { frames?: unknown })?.frames;
    if (!Array.isArray(raw)) return [];
    return raw as CanvasFrameRow[];
  }, [data]);
  const framesRef = useRef<CanvasFrameRow[]>(frames);
  useEffect(() => {
    framesRef.current = frames;
  }, [frames]);
  const canvasKind = (data?.canvas as { kind?: string } | undefined)?.kind ?? null;
  const activePageId =
    (data?.canvas as { activePageId?: string | null } | undefined)?.activePageId ?? null;

  // Component instances on this canvas. v1 renders each as a lightweight
  // placeholder card; `instanceDetach` materialises them into raw rows.
  const componentInstances = useMemo<
    Array<{
      id: string;
      componentId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      hiddenAt: Date | string | null;
      lockedAt: Date | string | null;
      parentFrameId: string | null;
    }>
  >(() => {
    const raw = (data as unknown as { componentInstances?: unknown })
      ?.componentInstances;
    if (!Array.isArray(raw)) return [];
    return raw as Array<{
      id: string;
      componentId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      hiddenAt: Date | string | null;
      lockedAt: Date | string | null;
      parentFrameId: string | null;
    }>;
  }, [data]);

  // Component name lookup for the placeholder render. List request is
  // shared with the right panel via tRPC's query cache.
  const componentListQ = trpc.canvas.componentList.useQuery(
    { includeArchived: false },
    { staleTime: 60_000 },
  );
  const componentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of componentListQ.data?.items ?? []) m.set(c.id, c.name);
    return m;
  }, [componentListQ.data]);

  // Build a snapshot of the current selection for `componentCreate` in
  // the Components panel. Lazy — only called when the operator presses
  // the "Create from selection" button.
  const buildSelectionSnapshot = useCallback((): ComponentSelectionSnapshot | null => {
    const selNodeIds = new Set(
      selected.filter((s) => s.kind === "node").map((s) => s.id),
    );
    const selShapeIds = new Set(
      selected.filter((s) => s.kind === "shape").map((s) => s.id),
    );
    const rawNodes = (data?.nodes ?? []) as HydratedNode[];
    const rawShapes = ((data as unknown as { shapes?: CanvasShapeRow[] })?.shapes ?? []) as CanvasShapeRow[];
    const pickedNodes = rawNodes
      .filter((n) => selNodeIds.has(n.id))
      .map((n) => ({
        id: n.id,
        targetType: n.targetType,
        targetId: n.targetId,
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
      }));
    const pickedShapes = rawShapes
      .filter((s) => selShapeIds.has(s.id))
      .map((s) => ({ ...s }) as unknown as Record<string, unknown>);
    if (pickedNodes.length === 0 && pickedShapes.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of pickedNodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.width > maxX) maxX = n.x + n.width;
      if (n.y + n.height > maxY) maxY = n.y + n.height;
    }
    for (const s of pickedShapes) {
      const sx = typeof s.x === "number" ? (s.x as number) : 0;
      const sy = typeof s.y === "number" ? (s.y as number) : 0;
      const sw = typeof s.width === "number" ? (s.width as number) : 0;
      const sh = typeof s.height === "number" ? (s.height as number) : 0;
      if (sx < minX) minX = sx;
      if (sy < minY) minY = sy;
      if (sx + sw > maxX) maxX = sx + sw;
      if (sy + sh > maxY) maxY = sy + sh;
    }
    if (!Number.isFinite(minX)) {
      minX = 0;
      minY = 0;
      maxX = 1;
      maxY = 1;
    }
    return {
      nodes: pickedNodes,
      shapes: pickedShapes,
      bbox: {
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
      },
    };
  }, [selected, data]);

  // O(1) frame child + descendant index. Built once whenever
  // frames/nodes/shapes change. Replaces the O(frames²) while-loops
  // that used to live in `onFrameTitleMouseDown` (click latency) and
  // `activePageDescendantIds` (per-render cost on DESIGN canvases).
  //
  // `childFramesByParent` — direct-child frames keyed by parentFrameId.
  // `descendantsByFrame` — full transitive descendant set per frame.
  // `childNodesByFrame` / `childShapesByFrame` — direct child nodes /
  // shapes keyed by parentFrameId; used to assemble cascade drag sets.
  const frameChildIndex = useMemo(() => {
    const childFramesByParent = new Map<string, string[]>();
    const childNodesByFrame = new Map<string, string[]>();
    const childShapesByFrame = new Map<string, string[]>();
    for (const f of frames) {
      if (f.parentFrameId) {
        const arr = childFramesByParent.get(f.parentFrameId) ?? [];
        arr.push(f.id);
        childFramesByParent.set(f.parentFrameId, arr);
      }
    }
    for (const n of nodes) {
      const pid = (n as { parentFrameId?: string | null }).parentFrameId;
      if (!pid) continue;
      const arr = childNodesByFrame.get(pid) ?? [];
      arr.push(n.id);
      childNodesByFrame.set(pid, arr);
    }
    for (const s of shapes) {
      const pid = (s as { parentFrameId?: string | null }).parentFrameId;
      if (!pid) continue;
      const arr = childShapesByFrame.get(pid) ?? [];
      arr.push(s.id);
      childShapesByFrame.set(pid, arr);
    }
    // Transitive descendant set per frame via memoized DFS. We memo
    // per-frame so the index for a 50-frame canvas is O(N+E) not O(N²).
    const descendantsByFrame = new Map<string, Set<string>>();
    const visit = (fid: string): Set<string> => {
      const cached = descendantsByFrame.get(fid);
      if (cached) return cached;
      const out = new Set<string>();
      const stack: string[] = [...(childFramesByParent.get(fid) ?? [])];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (out.has(cur)) continue;
        out.add(cur);
        const kids = childFramesByParent.get(cur);
        if (kids) for (const k of kids) stack.push(k);
      }
      descendantsByFrame.set(fid, out);
      return out;
    };
    for (const f of frames) visit(f.id);
    return {
      childFramesByParent,
      childNodesByFrame,
      childShapesByFrame,
      descendantsByFrame,
    };
  }, [frames, nodes, shapes]);

  // Set of frame ids that descend from the active page (DESIGN canvases).
  // Children whose ancestor frame is anything else get filtered out so
  // multi-page canvases show one page's contents at a time. O(1) via
  // the precomputed descendant index — previously O(frames²) per render.
  const activePageDescendantIds = useMemo(() => {
    if (canvasKind !== "DESIGN" || !activePageId) return null;
    const descendants = frameChildIndex.descendantsByFrame.get(activePageId);
    const out = new Set<string>([activePageId]);
    if (descendants) for (const d of descendants) out.add(d);
    return out;
  }, [canvasKind, activePageId, frameChildIndex]);

  // Filter a parented row by the active page. Returns true if the row
  // should render. Free-floating rows (`parentFrameId == null`) are
  // hidden on DESIGN canvases — they belong on a page or nowhere.
  const isOnActivePage = useCallback(
    (parentFrameId: string | null): boolean => {
      if (!activePageDescendantIds) return true;
      if (parentFrameId == null) return false;
      return activePageDescendantIds.has(parentFrameId);
    },
    [activePageDescendantIds],
  );

  // Positions computed by frame auto-layout. For each frame whose
  // `autoLayout` JSON is set, we re-place its node/shape children so
  // they stack / row out per the spec (vertical/horizontal, gap,
  // padding, align, justify). Items override their stored (x, y) only
  // for render — the underlying row is left alone until a real
  // mutation (drag-to-reorder updates relative order via stored
  // positions, which `computeAutoLayout` sorts on).
  const autoLayoutPositions = useMemo(() => {
    const out = new Map<string, { x: number; y: number }>();
    if (frames.length === 0) return out;
    type Child = AutoLayoutChild;
    const childrenByFrame = new Map<string, Child[]>();
    const collect = (
      parentFrameId: string | null | undefined,
      id: string,
      x: number,
      y: number,
      width: number,
      height: number,
    ) => {
      if (!parentFrameId) return;
      const arr = childrenByFrame.get(parentFrameId) ?? [];
      arr.push({ id, x, y, width, height });
      childrenByFrame.set(parentFrameId, arr);
    };
    for (const n of nodes) {
      collect((n as { parentFrameId?: string | null }).parentFrameId, n.id, n.x, n.y, n.width, n.height);
    }
    for (const s of shapes) {
      const w = s.width ?? 0;
      const h = s.height ?? 0;
      if (w <= 0 || h <= 0) continue; // path shapes have no bounding box
      collect((s as { parentFrameId?: string | null }).parentFrameId, s.id, s.x, s.y, w, h);
    }
    for (const f of frames) {
      const spec = parseAutoLayout((f as { autoLayout?: unknown }).autoLayout);
      if (!spec) continue;
      const kids = childrenByFrame.get(f.id);
      if (!kids || kids.length === 0) continue;
      const positions = computeAutoLayout({ x: f.x, y: f.y, width: f.width, height: f.height }, spec, kids);
      for (const [id, pos] of positions) out.set(id, pos);
    }
    return out;
  }, [frames, nodes, shapes]);

  // Apply any active drag overrides on top of the server-hydrated nodes.
  // While no drag is active the override map is empty and the returned
  // array shares identity with `nodes` — so memoized children skip work.
  const displayNodes = useMemo(() => {
    const overrides = dragOverridesRef.current;
    const filtered = activePageDescendantIds
      ? nodes.filter((n) =>
          isOnActivePage(
            (n as { parentFrameId?: string | null }).parentFrameId ?? null,
          ),
        )
      : nodes;
    if (overrides.size === 0 && autoLayoutPositions.size === 0) return filtered;
    return filtered.map((n) => {
      const ov = overrides.get(n.id);
      const al = autoLayoutPositions.get(n.id);
      if (!ov && !al) return n;
      return {
        ...n,
        // Drag overrides win over auto-layout so a live drag still feels
        // direct; on drop the auto-layout sort kicks back in.
        x: ov?.x ?? al?.x ?? n.x,
        y: ov?.y ?? al?.y ?? n.y,
        width: ov?.width ?? n.width,
        height: ov?.height ?? n.height,
      };
    });
    // dragRev forces recomputation each rAF tick during a drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, dragRev, activePageDescendantIds, isOnActivePage, autoLayoutPositions]);

  // Apply shape-drag overrides (delta from origin) on top of hydrated shapes.
  const displayShapes = useMemo(() => {
    const overrides = shapeDragOverridesRef.current;
    const filtered = activePageDescendantIds
      ? shapes.filter((s) =>
          isOnActivePage(
            (s as { parentFrameId?: string | null }).parentFrameId ?? null,
          ),
        )
      : shapes;
    if (overrides.size === 0 && autoLayoutPositions.size === 0) return filtered;
    return filtered.map((s) => {
      const ov = overrides.get(s.id);
      const al = autoLayoutPositions.get(s.id);
      if (!ov && !al) return s;
      if (ov) return { ...s, x: s.x + ov.dx, y: s.y + ov.dy };
      if (al) return { ...s, x: al.x, y: al.y };
      return s;
    });
    // dragRev forces recomputation each rAF tick during a drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, dragRev, activePageDescendantIds, isOnActivePage, autoLayoutPositions]);

  // Viewport virtualization: above a threshold, only paint shapes whose
  // bbox intersects the visible canvas rect (plus a 1-screen margin) so a
  // 1000-shape board doesn't keep 1000 SVG nodes live. Recomputes only when
  // the viewport moves into a new coarse bucket (`cullSignature`), so
  // panning within the margin is free. Path-extent shapes (freehand / line
  // / arrow) carry their geometry in `path`, not w/h, so we never cull
  // those. Only the render list is culled — hit-testing, marquee, fit, and
  // the inspector all keep using the full `displayShapes`.
  const cullSignature = useMemo(() => {
    const bucket = 240;
    return `${Math.round(viewport.x / bucket)}:${Math.round(viewport.y / bucket)}:${viewport.zoom.toFixed(2)}`;
  }, [viewport]);
  const visibleShapes = useMemo(() => {
    if (displayShapes.length <= VIRTUALIZE_THRESHOLD) return displayShapes;
    const rect = surfaceRef.current?.getBoundingClientRect();
    const vw = rect?.width ?? 1200;
    const vh = rect?.height ?? 800;
    const z = viewport.zoom;
    const marginX = vw / z;
    const marginY = vh / z;
    const minX = -viewport.x / z - marginX;
    const minY = -viewport.y / z - marginY;
    const maxX = (vw - viewport.x) / z + marginX;
    const maxY = (vh - viewport.y) / z + marginY;
    return displayShapes.filter((s) => {
      if (s.kind === "freehand" || s.kind === "line" || s.kind === "arrow") return true;
      const w = s.width ?? 40;
      const h = s.height ?? 40;
      return s.x + w >= minX && s.x <= maxX && s.y + h >= minY && s.y <= maxY;
    });
    // Recompute on coarse viewport bucket changes only (reads live viewport).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayShapes, cullSignature]);

  // Frames render through the CanvasFrames component which honors
  // `overrides` directly; the displayFrames memo is here for symmetry
  // with the node/shape pipeline and so a future filter has a home.
  const displayFrames = useMemo(() => {
    // dragRev keeps this re-running during a frame drag so the
    // CanvasFrames child re-reads the overrides ref.
    void dragRev;
    return frames;
  }, [frames, dragRev]);

  // -- Presentation mode (frames as slides) --------------------------
  const [presenting, setPresenting] = useState(false);
  const [slideIndex, setSlideIndex] = useState(0);
  const presentingRef = useRef(false);
  useEffect(() => {
    presentingRef.current = presenting;
  }, [presenting]);
  // Slides = frames in reading order (top→bottom, then left→right).
  const presentationSlides = useMemo(
    () => [...displayFrames].sort((a, b) => a.y - b.y || a.x - b.x),
    [displayFrames],
  );
  const fitToFrame = useCallback(
    (f: CanvasFrameRow) => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      const v = computeFitViewport(
        [{ x: f.x, y: f.y, w: f.width, h: f.height }],
        { w: rect?.width ?? 800, h: rect?.height ?? 600 },
        { pad: 48, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM },
      );
      if (v) animateViewportTo(v, 460);
    },
    [animateViewportTo],
  );
  const gotoSlide = useCallback(
    (i: number) => {
      const n = presentationSlides.length;
      if (n === 0) return;
      const idx = Math.max(0, Math.min(n - 1, i));
      setSlideIndex(idx);
      fitToFrame(presentationSlides[idx]);
    },
    [presentationSlides, fitToFrame],
  );
  const enterPresentation = useCallback(() => {
    if (presentationSlides.length === 0) {
      toast.error("Add a frame to present — each frame becomes a slide.");
      return;
    }
    setPresenting(true);
    setSlideIndex(0);
    // Defer the first fit a frame so the overlay (and any layout) settles.
    requestAnimationFrame(() => fitToFrame(presentationSlides[0]));
  }, [presentationSlides, fitToFrame]);
  const exitPresentation = useCallback(() => setPresenting(false), []);

  // -- Floating selection inspector (W1.5) ---------------------------

  // Discriminated-union view of the current selection for the floating
  // inspector. We pick the first selected row to drive single-kind
  // surfaces; mixed/multi selections collapse to a count chip.
  const inspectorSelection = useMemo<InspectorSelection | null>(() => {
    if (selectedEdgeId) {
      const e = edges.find((x) => x.id === selectedEdgeId);
      if (!e) return null;
      return { kind: "edge", edgeId: e.id, edgeKind: (e as { kind?: string }).kind ?? "solid" };
    }
    if (selected.length === 0) return null;
    if (selected.length === 1) {
      const sel = selected[0]!;
      if (sel.kind === "shape") {
        const s = displayShapes.find((sh) => sh.id === sel.id);
        if (!s) return null;
        return { kind: "shape", shape: s };
      }
      if (sel.kind === "frame") {
        const f = displayFrames.find((ff) => ff.id === sel.id);
        if (!f) return null;
        return { kind: "frame", frame: f };
      }
      if (sel.kind === "node") {
        const n = displayNodes.find((nn) => nn.id === sel.id);
        if (!n) return null;
        return { kind: "node", node: { id: n.id, meta: n.meta } };
      }
    }
    return {
      kind: "multi",
      count: selected.length,
      kinds: new Set(selected.map((s) => s.kind)),
    };
  }, [selected, selectedEdgeId, edges, displayShapes, displayFrames, displayNodes]);

  // Selection bounding box, in **viewport** pixels. The inspector
  // floats above the bbox in pixel-space (NOT canvas-space) so its
  // size stays constant under zoom. We compute the canvas-space bbox
  // first, then apply the viewport transform.
  const inspectorBbox = useMemo(() => {
    if (!inspectorSelection) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const pushRect = (x: number, y: number, w: number, h: number) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    };
    if (inspectorSelection.kind === "shape") {
      const s = inspectorSelection.shape;
      pushRect(s.x, s.y, s.width ?? 0, s.height ?? 0);
    } else if (inspectorSelection.kind === "frame") {
      const f = inspectorSelection.frame;
      pushRect(f.x, f.y, f.width, f.height);
    } else if (inspectorSelection.kind === "node") {
      const n = displayNodes.find((nn) => nn.id === inspectorSelection.node.id);
      if (n) pushRect(n.x, n.y, n.width, n.height);
    } else if (inspectorSelection.kind === "edge") {
      const e = edges.find((x) => x.id === inspectorSelection.edgeId);
      if (!e) return null;
      const a = displayNodes.find((n) => n.id === e.fromNodeId);
      const b = displayNodes.find((n) => n.id === e.toNodeId);
      if (!a || !b) return null;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      pushRect(mx, my, 1, 1);
    } else if (inspectorSelection.kind === "multi") {
      for (const sel of selected) {
        if (sel.kind === "shape") {
          const s = displayShapes.find((sh) => sh.id === sel.id);
          if (s) pushRect(s.x, s.y, s.width ?? 0, s.height ?? 0);
        } else if (sel.kind === "frame") {
          const f = displayFrames.find((ff) => ff.id === sel.id);
          if (f) pushRect(f.x, f.y, f.width, f.height);
        } else if (sel.kind === "node") {
          const n = displayNodes.find((nn) => nn.id === sel.id);
          if (n) pushRect(n.x, n.y, n.width, n.height);
        }
      }
    }
    if (!Number.isFinite(minX)) return null;
    return {
      x: minX * viewport.zoom + viewport.x,
      y: minY * viewport.zoom + viewport.y,
      width: (maxX - minX) * viewport.zoom,
      height: (maxY - minY) * viewport.zoom,
    };
  }, [
    inspectorSelection,
    selected,
    displayShapes,
    displayFrames,
    displayNodes,
    edges,
    viewport.x,
    viewport.y,
    viewport.zoom,
  ]);

  const onInspectorPatch = useCallback(
    (p: InspectorPatch) => {
      if (p.kind === "shape" && shapePatchMut) {
        const current = shapesRef.current.find((s) => s.id === p.id);
        const currentStyle = (current?.style ?? {}) as Record<string, unknown>;
        const next: Record<string, unknown> = { ...currentStyle };
        if (p.patch.stroke !== undefined) next.stroke = p.patch.stroke;
        if (p.patch.fill !== undefined) next.fill = p.patch.fill;
        if (p.patch.strokeWidth !== undefined) next.strokeWidth = p.patch.strokeWidth;
        if (p.patch.opacity !== undefined) next.opacity = p.patch.opacity;
        if (p.patch.cornerRadius !== undefined) next.cornerRadius = p.patch.cornerRadius;
        if (p.patch.sketch !== undefined) next.sketch = p.patch.sketch;
        if (p.patch.arrowHead !== undefined) next.arrowHead = p.patch.arrowHead;
        if (p.patch.arrowTail !== undefined) next.arrowTail = p.patch.arrowTail;
        const styleChanged =
          p.patch.stroke !== undefined ||
          p.patch.fill !== undefined ||
          p.patch.strokeWidth !== undefined ||
          p.patch.opacity !== undefined ||
          p.patch.cornerRadius !== undefined ||
          p.patch.sketch !== undefined ||
          p.patch.arrowHead !== undefined ||
          p.patch.arrowTail !== undefined;
        if (styleChanged) shapePatchMut.mutate({ id: p.id, style: next });
        // lockedAt isn't on shapePatch; route through the dedicated
        // layer proc when it exists (added by the unified-workspace
        // wave). Fallback: ignore silently.
        if (p.patch.lockedAt !== undefined) {
          const layerSetLockedMut = (
            trpc.canvas as unknown as { layerSetLocked?: { useMutation: () => { mutate: (i: unknown) => void } } }
          ).layerSetLocked;
          // Best-effort — silently skip if the proc isn't wired.
          void layerSetLockedMut;
        }
        return;
      }
      if (p.kind === "frame" && framePatchMut) {
        const data: Record<string, unknown> = { frameId: p.frameId };
        if (p.patch.name !== undefined) data.name = p.patch.name;
        if (
          p.patch.autoLayoutDirection !== undefined ||
          p.patch.autoLayoutGap !== undefined ||
          p.patch.autoLayoutPadding !== undefined
        ) {
          const current = framesRef.current.find((f) => f.id === p.frameId);
          const layout = ((current as { autoLayout?: Record<string, unknown> } | undefined)?.autoLayout ?? {}) as Record<string, unknown>;
          const next: Record<string, unknown> = { ...layout };
          if (p.patch.autoLayoutDirection !== undefined) {
            if (p.patch.autoLayoutDirection === null) {
              data.autoLayout = null;
            } else {
              next.direction = p.patch.autoLayoutDirection;
            }
          }
          if (p.patch.autoLayoutGap !== undefined) next.gap = p.patch.autoLayoutGap;
          if (p.patch.autoLayoutPadding !== undefined) next.padding = p.patch.autoLayoutPadding;
          if (p.patch.autoLayoutDirection !== null) data.autoLayout = next;
        }
        framePatchMut.mutate(data as Parameters<typeof framePatchMut.mutate>[0]);
        return;
      }
      if (p.kind === "edge" && edgePatchMut) {
        edgePatchMut.mutate({ id: p.edgeId, ...(p.patch as Record<string, unknown>) } as Parameters<typeof edgePatchMut.mutate>[0]);
      }
    },
    [shapePatchMut, framePatchMut, edgePatchMut],
  );

  const onInspectorDelete = useCallback(() => {
    if (selectedEdgeId) {
      removeEdge.mutate({ id: selectedEdgeId });
      setSelectedEdgeId(null);
      return;
    }
    const frameIds = selected.filter((s) => s.kind === "frame").map((s) => s.id);
    if (frameIds.length > 0 && frameRemoveMut) {
      for (const fid of frameIds) frameRemoveMut.mutate({ frameId: fid, reparentChildren: true });
      setSelected((prev) => prev.filter((s) => s.kind !== "frame"));
      return;
    }
    const shapeIds = selected.filter((s) => s.kind === "shape").map((s) => s.id);
    if (shapeIds.length > 0 && shapeRemoveMut) {
      for (const id of shapeIds) removeShapeUndoable(id);
      setSelected((prev) => prev.filter((s) => s.kind !== "shape"));
    }
  }, [
    selected,
    selectedEdgeId,
    removeEdge,
    frameRemoveMut,
    shapeRemoveMut,
    removeShapeUndoable,
  ]);

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
    // Single-click drop tool — entity-create. Opens an inline popover
    // anchored to the click; commit fires issue.create / note.create
    // and drops a CanvasNode reference at the canvas-space position.
    if (tool === "entity-create") {
      const { x, y } = surfaceToCanvasRef.current?.(e.clientX, e.clientY) ?? { x: 0, y: 0 };
      setEntityCreator({
        viewportX: e.clientX - (surfaceRef.current?.getBoundingClientRect().left ?? 0),
        viewportY: e.clientY - (surfaceRef.current?.getBoundingClientRect().top ?? 0),
        canvasX: x,
        canvasY: y,
      });
      return;
    }
    // Single-click drop tools — comment-pin + stamp. No drag gesture;
    // just stamp the shape at click position and return to select.
    if (tool === "comment-pin" || tool === "stamp") {
      if (!shapeAddMut) return;
      const { x, y } = surfaceToCanvasRef.current?.(e.clientX, e.clientY) ?? { x: 0, y: 0 };
      if (tool === "comment-pin") {
        void createShape({
          canvasId: params.canvasId,
          kind: "comment-pin",
          x,
          y,
          width: 24,
          height: 24,
        });
      } else {
        const emoji = toolbarStyleRef.current.stampEmoji ?? "👍";
        void createShape({
          canvasId: params.canvasId,
          kind: "stamp",
          x,
          y,
          width: 48,
          height: 48,
          style: { emoji },
        });
      }
      if (!stickyToolLockRef.current) setActiveTool("select");
      return;
    }
    const drawKinds: ToolKind[] = [
      "box",
      "ellipse",
      "diamond",
      "arrow",
      "line",
      "text",
      "freehand",
      "frame",
      "sticky",
    ];
    if (drawKinds.includes(tool)) {
      // Begin a draw gesture. Convert pointer to canvas-space; the
      // pointer-move handler updates the draft ref and rAF-paints.
      const { x, y } = surfaceToCanvasRef.current?.(e.clientX, e.clientY) ?? { x: 0, y: 0 };
      shapeDraftRef.current = {
        kind: tool as ShapeKind | "frame",
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
    // Default: pan. Kill any in-flight tween/momentum so the grab is instant.
    cancelCameraMotion();
    panVelRef.current = null;
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
      const nx = vx + (e.clientX - mx);
      const ny = vy + (e.clientY - my);
      // Sample velocity (viewport-px / ms) so release can fling with momentum.
      const now = performance.now();
      const prev = panVelRef.current;
      if (prev) {
        const dt = Math.max(1, now - prev.t);
        panVelRef.current = {
          x: nx,
          y: ny,
          t: now,
          vx: (nx - prev.x) / dt,
          vy: (ny - prev.y) / dt,
        };
      } else {
        panVelRef.current = { x: nx, y: ny, t: now, vx: 0, vy: 0 };
      }
      setViewport((v) => ({ ...v, x: nx, y: ny }));
    };
    const onUp = () => {
      setPanning(false);
      panStart.current = null;
      const vel = panVelRef.current;
      panVelRef.current = null;
      // Fling only on a recent, fast-enough release; else just persist.
      if (vel && performance.now() - vel.t < 60 && Math.hypot(vel.vx, vel.vy) > 0.08) {
        startPanMomentum(vel.vx, vel.vy);
      } else {
        persistViewport(viewportRef.current);
      }
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
    // A manual wheel gesture overrides any running tween/fling.
    cancelCameraMotion();
    // Pinch-to-zoom on macOS trackpads arrives as a wheel event with
    // `ctrlKey` synthetically set by the browser, so the same branch
    // catches keyboard ⌘/Ctrl+wheel AND trackpad pinch. Plain wheel
    // falls through to a 2-axis pan so trackpads feel natural.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = surfaceRef.current?.getBoundingClientRect();
      const cx = rect ? e.clientX - rect.left : e.clientX;
      const cy = rect ? e.clientY - rect.top : e.clientY;
      // Smooth — deltaY for trackpad pinches is finer-grained than
      // mouse-wheel notches, so we scale rather than just step.
      const factor = Math.exp(-e.deltaY * 0.0015);
      setViewport((v) => {
        const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
        if (nextZoom === v.zoom) return v;
        // Anchor the zoom at the cursor — keep the canvas point under
        // the pointer stationary while zoom changes.
        const k = nextZoom / v.zoom;
        return {
          zoom: nextZoom,
          x: cx - (cx - v.x) * k,
          y: cy - (cy - v.y) * k,
        };
      });
      return;
    }
    // Plain wheel pans the canvas (matches trackpad two-finger drag).
    if (e.deltaX !== 0 || e.deltaY !== 0) {
      e.preventDefault();
      setViewport((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    }
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
        const primaryShape = shapesRef.current.find((s) => s.id === drag.primaryShapeId);
        if (!primaryShape) return;

        // Smart alignment guides — only when dragging exactly one shape
        // (otherwise the guides ambiguate). Snap wins over grid-snap if
        // both apply. We sample siblings sharing the same parent frame
        // (or all top-level shapes if the primary is unparented).
        let snapApplied = false;
        if (drag.shapeIds.length === 1) {
          const primaryParent =
            (primaryShape as { parentFrameId?: string | null }).parentFrameId ?? null;
          const w = primaryShape.width ?? 0;
          const h = primaryShape.height ?? 0;
          if (w > 0 && h > 0) {
            const sibs: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];
            for (const s of shapesRef.current) {
              if (s.id === drag.primaryShapeId) continue;
              const sp =
                (s as { parentFrameId?: string | null }).parentFrameId ?? null;
              if (sp !== primaryParent) continue;
              const sw = s.width ?? 0;
              const sh = s.height ?? 0;
              if (sw <= 0 || sh <= 0) continue;
              sibs.push({ id: s.id, x: s.x, y: s.y, width: sw, height: sh });
            }
            // Include nodes in the same frame so shapes snap to cards.
            for (const n of nodes) {
              const np = (n as { parentFrameId?: string | null }).parentFrameId ?? null;
              if (np !== primaryParent) continue;
              sibs.push({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height });
            }
            const snap = computeSnap(
              { x: targetX, y: targetY, width: w, height: h },
              sibs,
              viewport.zoom,
            );
            if (snap.guides.length > 0) {
              targetX = snap.bbox.x;
              targetY = snap.bbox.y;
              snapApplied = true;
              snapGuidesRef.current = {
                guides: snap.guides,
                labels: snap.labels,
                sizeLabel: snap.sizeLabel,
              };
            } else {
              snapGuidesRef.current = {
                guides: [],
                labels: [],
                sizeLabel: snap.sizeLabel,
              };
            }
          }
        }
        if (!snapApplied && snapToGridRef.current) {
          targetX = Math.round(targetX / GRID_SIZE_PX) * GRID_SIZE_PX;
          targetY = Math.round(targetY / GRID_SIZE_PX) * GRID_SIZE_PX;
          // W2.4: surface a visible row/column highlight at the snap
          // target so the operator sees where the grid is pulling.
          gridSnapHighlightRef.current = {
            x: targetX,
            y: targetY,
            w: primaryShape.width ?? 0,
            h: primaryShape.height ?? 0,
          };
        } else {
          gridSnapHighlightRef.current = null;
        }
        // dx/dy applied to every shape relative to its *initial* (x,y).
        const dx = targetX - primaryShape.x;
        const dy = targetY - primaryShape.y;
        const shapeOverrides = shapeDragOverridesRef.current;
        for (const id of drag.shapeIds) {
          shapeOverrides.set(id, { dx, dy });
        }
      } else if (drag.kind === "frame-move") {
        // Compute pointer position in canvas-space, derive the new
        // primary-frame origin from the captured offset, then apply
        // the same delta to every frame in the cascade AND every
        // direct child (node/shape) that lives inside one of those
        // frames. Mirrors the server-side framePatch cascade so the
        // optimistic move matches what the backend will produce.
        const pointerX = (e.clientX - viewport.x) / viewport.zoom;
        const pointerY = (e.clientY - viewport.y) / viewport.zoom;
        let newX = pointerX - drag.offsetX;
        let newY = pointerY - drag.offsetY;
        if (snapToGridRef.current) {
          newX = Math.round(newX / GRID_SIZE_PX) * GRID_SIZE_PX;
          newY = Math.round(newY / GRID_SIZE_PX) * GRID_SIZE_PX;
        }
        const origin = drag.frameOrigins[drag.primaryFrameId];
        if (!origin) return;
        const dx = newX - origin.x;
        const dy = newY - origin.y;
        const frameOverrides = frameDragOverridesRef.current;
        for (const fid of drag.frameIds) {
          const o = drag.frameOrigins[fid];
          if (!o) continue;
          frameOverrides.set(fid, { x: o.x + dx, y: o.y + dy });
        }
        // Children ride along — translate each by the same (dx, dy)
        // using the existing per-node/shape override maps so the live
        // paint reuses CanvasCard / CanvasShapes' memoized renderers.
        const nodeOverrides = dragOverridesRef.current;
        for (const nid of drag.childNodeIds) {
          const n = nodes.find((nn) => nn.id === nid);
          if (!n) continue;
          nodeOverrides.set(nid, {
            ...nodeOverrides.get(nid),
            x: n.x + dx,
            y: n.y + dy,
          });
        }
        const shapeOverrides = shapeDragOverridesRef.current;
        for (const sid of drag.childShapeIds) {
          shapeOverrides.set(sid, { dx, dy });
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
          // W3.1: record an undo entry. We capture the delta + the
          // affected ids; undoIt reverses the patch by negating dxdy.
          const { dx, dy } = primary;
          const ids = [...drag.shapeIds];
          undoStack.push({
            describe: `moved ${ids.length === 1 ? "shape" : `${ids.length} shapes`}`,
            doIt: () => {
              if (ids.length > 1 && shapeBulkPatchMut) {
                shapeBulkPatchMut.mutate({ ids, dxdy: { dx, dy } });
              } else if (shapePatchMut) {
                for (const id of ids) {
                  const s = shapesRef.current.find((sh) => sh.id === id);
                  if (!s) continue;
                  shapePatchMut.mutate({ id, x: s.x + dx, y: s.y + dy });
                }
              }
            },
            undoIt: () => {
              if (ids.length > 1 && shapeBulkPatchMut) {
                shapeBulkPatchMut.mutate({ ids, dxdy: { dx: -dx, dy: -dy } });
              } else if (shapePatchMut) {
                for (const id of ids) {
                  const s = shapesRef.current.find((sh) => sh.id === id);
                  if (!s) continue;
                  shapePatchMut.mutate({ id, x: s.x - dx, y: s.y - dy });
                }
              }
            },
          });
        }
        for (const id of drag.shapeIds) shapeOverrides.delete(id);
      } else if (drag.kind === "frame-move") {
        // Persist via framePatch — the server cascades the move to
        // every child node/shape/instance/frame in the same
        // transaction (see canvas.ts framePatch). So we only need
        // to commit the primary frame's new position; nested frames
        // also get patched individually because they have their own
        // children attached at a different parent — patching only
        // the primary would cascade once but leave nested frames
        // un-translated. Patch each frame in the cascade so the
        // server treats each frame's children correctly.
        const frameOverrides = frameDragOverridesRef.current;
        const primaryOv = frameOverrides.get(drag.primaryFrameId);
        if (
          primaryOv &&
          framePatchMut &&
          (primaryOv.x !== drag.frameOrigins[drag.primaryFrameId]?.x ||
            primaryOv.y !== drag.frameOrigins[drag.primaryFrameId]?.y)
        ) {
          // Patch only the primary frame — the server cascades to
          // all child rows (frames, nodes, shapes, instances) so
          // nested frames AND grand-children move correctly in
          // a single transaction.
          framePatchMut.mutate({
            frameId: drag.primaryFrameId,
            x: primaryOv.x,
            y: primaryOv.y,
          });
        }
        for (const id of drag.frameIds) frameOverrides.delete(id);
        for (const nid of drag.childNodeIds) dragOverridesRef.current.delete(nid);
        for (const sid of drag.childShapeIds) shapeDragOverridesRef.current.delete(sid);
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
      // Clear smart-guide state so the overlay disappears.
      snapGuidesRef.current = { guides: [], labels: [], sizeLabel: null };
      gridSnapHighlightRef.current = null;
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
  // W2.1: when the eraser tool is active, clicks delete the shape
  // instead of selecting it. Hold + drag continues to sweep-delete via
  // the shape's onMouseEnter handler (wired in canvas-shapes).
  const onSelectShape = useCallback(
    (id: string, event: React.MouseEvent) => {
      if (activeToolRef.current === "eraser" && shapeRemoveMut) {
        event.stopPropagation();
        removeShapeUndoable(id);
        return;
      }
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
    [selected, shapes, expandGroupedShapes, shapeRemoveMut, removeShapeUndoable, viewport.x, viewport.y, viewport.zoom],
  );

  // -- Frame selection + title-bar drag ------------------------------

  const onSelectFrame = useCallback(
    (id: string, event: React.MouseEvent) => {
      const additive = event.shiftKey;
      setSelected((prev) => {
        if (additive) {
          if (prev.some((s) => s.kind === "frame" && s.id === id)) {
            return prev.filter((s) => !(s.kind === "frame" && s.id === id));
          }
          return [...prev, { kind: "frame" as const, id }];
        }
        if (prev.some((s) => s.kind === "frame" && s.id === id)) return prev;
        return [{ kind: "frame" as const, id }];
      });
    },
    [],
  );

  // Begin a frame-move drag. Captures the primary frame's origin,
  // every nested child frame's origin (cascade), and the direct child
  // node / shape ids so the live drag translates everything in lock-
  // step. The server's framePatch cascades the persisted move via SQL;
  // we mirror it here for the optimistic preview.
  //
  // Cascade lookup is O(descendants), not O(frames²) — the diagnosed
  // root cause of the "frame click feels laggy" perception lived in
  // the previous nested while-loop. Pre-baked indices come from
  // `frameChildIndex` above.
  const onFrameTitleMouseDown = useCallback(
    (id: string, event: React.MouseEvent) => {
      if (event.button !== 0) return;
      const primary = framesRef.current.find((f) => f.id === id);
      if (!primary) return;
      if (primary.lockedAt) return;
      const descendants = frameChildIndex.descendantsByFrame.get(id);
      const cascade: string[] = [id];
      if (descendants) for (const d of descendants) cascade.push(d);
      const frameOrigins: Record<string, { x: number; y: number }> = {};
      for (const fid of cascade) {
        const f = framesRef.current.find((ff) => ff.id === fid);
        if (!f) continue;
        frameOrigins[fid] = { x: f.x, y: f.y };
      }
      const childNodeIds: string[] = [];
      const childShapeIds: string[] = [];
      for (const fid of cascade) {
        const ns = frameChildIndex.childNodesByFrame.get(fid);
        if (ns) for (const nid of ns) childNodeIds.push(nid);
        const ss = frameChildIndex.childShapesByFrame.get(fid);
        if (ss) for (const sid of ss) childShapeIds.push(sid);
      }
      const pointerX = (event.clientX - viewport.x) / viewport.zoom;
      const pointerY = (event.clientY - viewport.y) / viewport.zoom;
      dragNode.current = {
        kind: "frame-move",
        primaryFrameId: id,
        frameIds: cascade,
        offsetX: pointerX - primary.x,
        offsetY: pointerY - primary.y,
        frameOrigins,
        childNodeIds,
        childShapeIds,
      };
      draggingRef.current = true;
    },
    [frameChildIndex, viewport.x, viewport.y, viewport.zoom],
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
      if (draft) {
        const minSize = 4;
        const w = Math.abs(draft.endX - draft.startX);
        const h = Math.abs(draft.endY - draft.startY);
        const tool = draft.kind;
        if (tool === "frame") {
          if (frameAddMut && w >= minSize && h >= minSize) {
            const startX = Math.min(draft.startX, draft.endX);
            const startY = Math.min(draft.startY, draft.endY);
            frameAddMut.mutate({
              canvasId: params.canvasId,
              name: "Frame",
              x: startX,
              y: startY,
              width: w,
              height: h,
            });
          }
          shapeDraftRef.current = null;
          scheduleShapeDraftRender();
          if (!stickyToolLockRef.current) setActiveTool("select");
          return;
        }
        if (!shapeAddMut) {
          shapeDraftRef.current = null;
          scheduleShapeDraftRender();
          if (!stickyToolLockRef.current) setActiveTool("select");
          return;
        }
        if (tool === "freehand") {
          if (draft.path.length >= 2) {
            void createShape({
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
            void createShape({
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
          // For text, the drag defines the box. We drop the placeholder
          // body in and flip the new shape into inline edit mode the
          // instant it lands — the operator never sees a static "Text".
          const boxW = Math.max(120, w);
          const boxH = Math.max(40, h);
          const startX = Math.min(draft.startX, draft.endX);
          const startY = Math.min(draft.startY, draft.endY);
          createShape({
            canvasId: params.canvasId,
            kind: "text",
            x: startX,
            y: startY,
            width: boxW,
            height: boxH,
            text: "Text",
            style: { color: toolbarStyleRef.current.stroke, fontSize: 14 },
          }).then((res) => {
            if (res) setEditingShapeFor(res.id);
          });
        } else if (tool === "box" || tool === "ellipse" || tool === "diamond") {
          if (w >= minSize && h >= minSize) {
            const startX = Math.min(draft.startX, draft.endX);
            const startY = Math.min(draft.startY, draft.endY);
            void createShape({
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
                ...(toolbarStyleRef.current.sketch ? { sketch: true } : {}),
              },
            });
          }
        } else if (tool === "sticky") {
          // Single-click (no drag) drops a default-sized sticky at the
          // click point. Drag defines a custom bbox, snapped to a sane
          // minimum so the inline editor has room to breathe.
          const dragged = w >= minSize || h >= minSize;
          const stickyW = dragged ? Math.max(120, w) : 200;
          const stickyH = dragged ? Math.max(80, h) : 120;
          const startX = dragged ? Math.min(draft.startX, draft.endX) : draft.startX;
          const startY = dragged ? Math.min(draft.startY, draft.endY) : draft.startY;
          const paletteKey = toolbarStyleRef.current.stickyPalette ?? "sand";
          createShape({
            canvasId: params.canvasId,
            kind: "sticky",
            x: startX,
            y: startY,
            width: stickyW,
            height: stickyH,
            text: "",
            style: { fill: paletteKey, fontSize: 14 },
          }).then((res) => {
            // Drop straight into inline edit — same UX as the text tool.
            if (res) setEditingShapeFor(res.id);
          });
        }
        shapeDraftRef.current = null;
        scheduleShapeDraftRender();
        // Drop back to select after each draw so single-shot drawing
        // feels less stateful. Shift+click on the toolbar button locks
        // the tool sticky (W2.1) — when locked, skip the auto-return.
        if (!stickyToolLockRef.current) setActiveTool("select");
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
        for (const f of frames) {
          if (f.hiddenAt) continue;
          if (
            f.x + f.width >= minX &&
            f.x <= maxX &&
            f.y + f.height >= minY &&
            f.y <= maxY
          ) {
            hits.push({ kind: "frame", id: f.id });
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
  }, [nodes, shapes, frames, params.canvasId, shapeAddMut, frameAddMut, scheduleShapeDraftRender, createShape]);

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
      // Presentation mode owns the keyboard (handled in its own overlay).
      if (presentingRef.current) return;
      // Don't hijack typing.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.key === "Escape") {
        setActiveTool("select");
        shapeDraftRef.current = null;
        scheduleShapeDraftRender();
        if (connectorDraftRef.current) {
          connectorDraftRef.current = null;
          scheduleConnectorRender();
        }
        if (selectedEdgeId) setSelectedEdgeId(null);
        if (selected.length > 0) setSelected([]);
        return;
      }
      // W3.1: Cmd+Z / Cmd+Shift+Z undo / redo. Skip if focus is in a
      // text editor (Ctrl+Z is the editor's own undo).
      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
          return;
        }
        e.preventDefault();
        if (e.shiftKey) {
          const cmd = undoStack.redo();
          if (cmd) toast(`Redone: ${cmd.describe}`, { duration: 1500 });
        } else {
          const cmd = undoStack.undo();
          if (cmd) toast(`Undone: ${cmd.describe}`, { duration: 1500 });
        }
        return;
      }
      // F = frame tool, OR zoom-to-fit-frame when a frame is selected
      // (W3.4). If only frames are in the selection, F zooms; otherwise
      // it activates the frame tool. Shift+F always picks the tool.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        const selFrameIds = selected.filter((s) => s.kind === "frame").map((s) => s.id);
        if (selFrameIds.length > 0 && !e.shiftKey) {
          const rect = surfaceRef.current?.getBoundingClientRect();
          const viewW = rect?.width ?? 800;
          const viewH = rect?.height ?? 600;
          const targetFrames = displayFrames.filter((f) => selFrameIds.includes(f.id));
          if (targetFrames.length === 0) return;
          const minX = Math.min(...targetFrames.map((f) => f.x));
          const minY = Math.min(...targetFrames.map((f) => f.y));
          const maxX = Math.max(...targetFrames.map((f) => f.x + f.width));
          const maxY = Math.max(...targetFrames.map((f) => f.y + f.height));
          const pad = 80;
          const zoom = Math.min(
            (viewW - pad * 2) / (maxX - minX),
            (viewH - pad * 2) / (maxY - minY),
            MAX_ZOOM,
          );
          const safeZoom = Math.max(MIN_ZOOM, zoom);
          const next = {
            x: viewW / 2 - ((minX + maxX) / 2) * safeZoom,
            y: viewH / 2 - ((minY + maxY) / 2) * safeZoom,
            zoom: safeZoom,
          };
          animateViewportTo(next);
          return;
        }
        setActiveTool("frame");
        return;
      }
      // Shift+2 = zoom-to-fit-selection (any kind). Matches Figma's
      // shortcut for "fit selection to view".
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && (e.key === "@" || e.key === "2")) {
        e.preventDefault();
        const items: Array<{ x: number; y: number; w: number; h: number }> = [];
        for (const sel of selected) {
          if (sel.kind === "shape") {
            const s = displayShapes.find((sh) => sh.id === sel.id);
            if (s && s.width && s.height) items.push({ x: s.x, y: s.y, w: s.width, h: s.height });
          } else if (sel.kind === "frame") {
            const f = displayFrames.find((ff) => ff.id === sel.id);
            if (f) items.push({ x: f.x, y: f.y, w: f.width, h: f.height });
          } else if (sel.kind === "node") {
            const n = displayNodes.find((nn) => nn.id === sel.id);
            if (n) items.push({ x: n.x, y: n.y, w: n.width, h: n.height });
          }
        }
        if (items.length === 0) return;
        const rect = surfaceRef.current?.getBoundingClientRect();
        const viewW = rect?.width ?? 800;
        const viewH = rect?.height ?? 600;
        const minX = Math.min(...items.map((i) => i.x));
        const minY = Math.min(...items.map((i) => i.y));
        const maxX = Math.max(...items.map((i) => i.x + i.w));
        const maxY = Math.max(...items.map((i) => i.y + i.h));
        const pad = 80;
        const z = Math.min(
          (viewW - pad * 2) / Math.max(1, maxX - minX),
          (viewH - pad * 2) / Math.max(1, maxY - minY),
          MAX_ZOOM,
        );
        const safeZoom = Math.max(MIN_ZOOM, z);
        const next = {
          x: viewW / 2 - ((minX + maxX) / 2) * safeZoom,
          y: viewH / 2 - ((minY + maxY) / 2) * safeZoom,
          zoom: safeZoom,
        };
        animateViewportTo(next);
        return;
      }
      // S = sticky, M = comment-pin, Y = stamp. Same modifier guard as
      // F so they stay out of the way of platform shortcuts.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        setActiveTool("sticky");
        return;
      }
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "m" || e.key === "M")) {
        e.preventDefault();
        setActiveTool("comment-pin");
        return;
      }
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        setActiveTool("stamp");
        return;
      }
      // I = entity-create (issue / note inline composer).
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        setActiveTool("entity-create");
        return;
      }
      // +/- zoom in/out around viewport center. ⌘+ / ⌘- also work
      // (most browsers reserve these for page zoom, but inside the
      // canvas we want them to do canvas zoom).
      if (e.key === "+" || e.key === "=" || e.key === "-") {
        e.preventDefault();
        cancelCameraMotion();
        const direction = e.key === "-" ? -1 : 1;
        const rect = surfaceRef.current?.getBoundingClientRect();
        const cx = (rect?.width ?? 800) / 2;
        const cy = (rect?.height ?? 600) / 2;
        const factor = direction === 1 ? 1 + ZOOM_STEP : 1 - ZOOM_STEP;
        setViewport((v) => {
          const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
          if (nextZoom === v.zoom) return v;
          const k = nextZoom / v.zoom;
          return {
            zoom: nextZoom,
            x: cx - (cx - v.x) * k,
            y: cy - (cy - v.y) * k,
          };
        });
        return;
      }
      // Zoom shortcuts: 0 = reset to 100%, 1 = fit all content.
      if (!e.metaKey && !e.ctrlKey && (e.key === "0" || e.key === "1")) {
        const rect = surfaceRef.current?.getBoundingClientRect();
        const viewW = rect?.width ?? 800;
        const viewH = rect?.height ?? 600;
        if (e.key === "0") {
          e.preventDefault();
          animateViewportTo({ x: viewW / 2, y: viewH / 2, zoom: 1 });
          return;
        }
        // Fit: compute bbox of all content (nodes + shapes), pad, scale.
        const items: Array<{ x: number; y: number; w: number; h: number }> = [];
        for (const n of nodes) items.push({ x: n.x, y: n.y, w: n.width, h: n.height });
        for (const s of shapes) items.push({ x: s.x, y: s.y, w: s.width ?? 40, h: s.height ?? 40 });
        if (items.length === 0) return;
        const minX = Math.min(...items.map((i) => i.x));
        const minY = Math.min(...items.map((i) => i.y));
        const maxX = Math.max(...items.map((i) => i.x + i.w));
        const maxY = Math.max(...items.map((i) => i.y + i.h));
        const contentW = maxX - minX;
        const contentH = maxY - minY;
        const pad = 80;
        const zoom = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, Math.min((viewW - pad * 2) / contentW, (viewH - pad * 2) / contentH)),
        );
        const next = {
          x: viewW / 2 - (minX + contentW / 2) * zoom,
          y: viewH / 2 - (minY + contentH / 2) * zoom,
          zoom,
        };
        e.preventDefault();
        animateViewportTo(next);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedEdgeId) {
          e.preventDefault();
          removeEdge.mutate({ id: selectedEdgeId });
          setSelectedEdgeId(null);
          return;
        }
        const frameIds = selected.filter((s) => s.kind === "frame").map((s) => s.id);
        if (frameIds.length > 0 && frameRemoveMut) {
          e.preventDefault();
          for (const fid of frameIds) {
            frameRemoveMut.mutate({ frameId: fid, reparentChildren: true });
          }
          setSelected((prev) => prev.filter((s) => s.kind !== "frame"));
          return;
        }
        const shapeIds = selected.filter((s) => s.kind === "shape").map((s) => s.id);
        if (shapeIds.length === 0) return;
        if (!shapeRemoveMut) return;
        e.preventDefault();
        for (const id of shapeIds) removeShapeUndoable(id);
        setSelected((prev) => prev.filter((s) => s.kind !== "shape"));
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      // W3.2: Cmd+C copies selected shapes to the in-memory clipboard;
      // Cmd+V pastes at +20px offset. Cmd+D continues to duplicate
      // in-place (existing).
      if (mod && (e.key === "c" || e.key === "C")) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        const shapeIds = selected.filter((s) => s.kind === "shape").map((s) => s.id);
        if (shapeIds.length === 0) return;
        const picked = shapes.filter((s) => shapeIds.includes(s.id));
        if (picked.length === 0) return;
        e.preventDefault();
        const originX = Math.min(...picked.map((s) => s.x));
        const originY = Math.min(...picked.map((s) => s.y));
        canvasClipboardRef.current = {
          shapes: picked.map((s) => ({
            kind: s.kind,
            width: s.width ?? null,
            height: s.height ?? null,
            path: s.path ?? null,
            style: s.style ?? null,
            text: s.text ?? null,
            groupId: s.groupId ?? null,
            relX: s.x - originX,
            relY: s.y - originY,
          })),
          originX,
          originY,
        };
        toast(`Copied ${picked.length} shape${picked.length === 1 ? "" : "s"}`, {
          duration: 1200,
        });
        return;
      }
      if (mod && (e.key === "v" || e.key === "V")) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        const clip = canvasClipboardRef.current;
        if (clip.shapes.length === 0 || !shapeAddMut) return;
        e.preventDefault();
        const dx = 20;
        const dy = 20;
        for (const s of clip.shapes) {
          const dup: ShapeAddInput = {
            canvasId: params.canvasId,
            kind: s.kind as ShapeAddInput["kind"],
            x: clip.originX + s.relX + dx,
            y: clip.originY + s.relY + dy,
          };
          if (s.width != null) dup.width = s.width;
          if (s.height != null) dup.height = s.height;
          if (s.path != null) dup.path = s.path;
          if (s.style != null) dup.style = s.style as Record<string, unknown>;
          if (s.text != null) dup.text = s.text;
          if (s.groupId != null) dup.groupId = s.groupId;
          void createShape(dup, "paste");
        }
        // Shift the origin forward by the paste offset so a chain of
        // pastes cascades neatly rather than stacking on the same spot.
        canvasClipboardRef.current = {
          ...clip,
          originX: clip.originX + dx,
          originY: clip.originY + dy,
        };
        toast(`Pasted ${clip.shapes.length} shape${clip.shapes.length === 1 ? "" : "s"}`, {
          duration: 1200,
        });
        return;
      }
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
          void createShape(dup, "duplicate");
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
      // Cmd+A → select all visible on the active page (or active frame
      // when one is focused via the selection). Repeated cmd+a inside
      // an already-frame-scoped selection toggles to canvas-wide.
      if (mod && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        const focusedFrameId =
          selected.length === 1 && selected[0].kind === "frame" ? selected[0].id : null;
        const all: SelectedRef[] = [];
        if (focusedFrameId) {
          for (const n of nodes) {
            if ((n as { parentFrameId?: string | null }).parentFrameId === focusedFrameId) {
              all.push({ kind: "node", id: n.id });
            }
          }
          for (const s of shapes) {
            if ((s as { parentFrameId?: string | null }).parentFrameId === focusedFrameId) {
              all.push({ kind: "shape", id: s.id });
            }
          }
        } else {
          for (const n of displayNodes) all.push({ kind: "node", id: n.id });
          for (const s of displayShapes) all.push({ kind: "shape", id: s.id });
          for (const f of displayFrames) all.push({ kind: "frame", id: f.id });
        }
        setSelected(all);
        return;
      }
      // Arrow nudge — 1px (10px with shift). Skips when mod is held so
      // it doesn't fight browser-level scroll shortcuts.
      const isArrow =
        e.key === "ArrowLeft" || e.key === "ArrowRight" ||
        e.key === "ArrowUp"   || e.key === "ArrowDown";
      if (isArrow && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (selected.length === 0) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp"   ? -step : e.key === "ArrowDown"  ? step : 0;
        for (const sel of selected) {
          if (sel.kind === "node") {
            const n = nodes.find((x) => x.id === sel.id);
            if (n) patchNode.mutate({ id: n.id, x: n.x + dx, y: n.y + dy });
          } else if (sel.kind === "shape" && shapePatchMut) {
            const s = shapes.find((x) => x.id === sel.id);
            if (s) shapePatchMut.mutate({ id: s.id, x: s.x + dx, y: s.y + dy });
          } else if (sel.kind === "frame" && framePatchMut) {
            const f = frames.find((x) => x.id === sel.id);
            if (f) framePatchMut.mutate({ frameId: f.id, x: f.x + dx, y: f.y + dy });
          }
        }
        return;
      }
    };
    // W2.1: Space-to-pan. When held, flip whatever tool is active
    // into Pan; on release, restore. We track via a ref so we don't
    // fight the user pressing Space repeatedly.
    const onSpaceDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))
        return;
      if (spacePanPrevToolRef.current != null) return;
      spacePanPrevToolRef.current = activeToolRef.current;
      setActiveTool("pan");
      e.preventDefault();
    };
    const onSpaceUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const prev = spacePanPrevToolRef.current;
      if (prev == null) return;
      spacePanPrevToolRef.current = null;
      setActiveTool(prev);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onSpaceDown);
    window.addEventListener("keyup", onSpaceUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onSpaceDown);
      window.removeEventListener("keyup", onSpaceUp);
    };
  }, [
    selected,
    nodes,
    shapes,
    frames,
    displayNodes,
    displayShapes,
    displayFrames,
    shapeRemoveMut,
    shapeAddMut,
    shapeBulkPatchMut,
    shapePatchMut,
    frameRemoveMut,
    framePatchMut,
    patchNode,
    params.canvasId,
    scheduleShapeDraftRender,
    scheduleConnectorRender,
    selectedEdgeId,
    removeEdge,
    setViewportMut,
    animateViewportTo,
    cancelCameraMotion,
    createShape,
    removeShapeUndoable,
    undoStack,
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
        if (patch.sketch !== undefined) styleUpdate.sketch = patch.sketch;
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
    const types = e.dataTransfer.types;
    if (
      !types.includes("application/x-forge-entity") &&
      !types.includes(COMPONENT_DRAG_MIME) &&
      !types.includes("Files")
    )
      return;
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
    // Dropped image files → upload + place as image shapes (Excalidraw-style).
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) =>
      CANVAS_IMAGE_MIME.has(f.type),
    );
    if (files.length > 0) {
      const { x, y } = surfaceToCanvas(e.clientX, e.clientY);
      files.forEach((f, i) => void uploadImageAt(f, x + i * 24, y + i * 24));
      return;
    }
    // First check for a component-instance drop — these come from the
    // right panel's Components tab via `COMPONENT_DRAG_MIME`.
    const compRaw = e.dataTransfer.getData(COMPONENT_DRAG_MIME);
    if (compRaw) {
      try {
        const payload = JSON.parse(compRaw) as Partial<ComponentDragPayload>;
        if (!payload.componentId) return;
        const { x, y } = surfaceToCanvas(e.clientX, e.clientY);
        createInstance.mutate({
          canvasId: params.canvasId,
          componentId: payload.componentId,
          x,
          y,
          width: payload.defaultWidth,
          height: payload.defaultHeight,
        });
      } catch {
        /* ignore malformed drop */
      }
      return;
    }
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

  // Upload an image file and drop it as an `image` shape at the given
  // canvas-space point. Shared by paste, file-drop, and the toolbar picker.
  const uploadImageAt = useCallback(
    async (file: File, canvasX: number, canvasY: number) => {
      if (!shapeAddMut) return;
      if (!CANVAS_IMAGE_MIME.has(file.type)) {
        toast.error("Unsupported image type.");
        return;
      }
      if (file.size > 25 * 1024 * 1024) {
        toast.error("Image exceeds the 25 MB limit.");
        return;
      }
      const dims = await readImageSize(file).catch(() => ({ w: 240, h: 180 }));
      // Cap the initial placed size so huge photos don't dominate the canvas.
      const maxDim = 480;
      const scale = Math.min(1, maxDim / Math.max(dims.w, dims.h));
      const width = Math.max(24, Math.round(dims.w * scale));
      const height = Math.max(24, Math.round(dims.h * scale));
      const toastId = toast.loading("Uploading image…");
      try {
        const { attachmentId } = await uploadAttachmentFile({
          file,
          targetType: "canvas",
          targetId: params.canvasId,
          initUpload: (i) => initUploadMut.mutateAsync(i),
          finalize: (i) => finalizeAttachmentMut.mutateAsync(i),
        });
        await createShape(
          {
            canvasId: params.canvasId,
            kind: "image",
            x: canvasX - width / 2,
            y: canvasY - height / 2,
            width,
            height,
            style: { attachmentId },
          },
          "add image",
        );
        utils.canvas.hydrate.invalidate({ id: params.canvasId });
        toast.success("Image added", { id: toastId });
      } catch (err) {
        toast.error((err as Error)?.message || "Image upload failed", { id: toastId });
      }
    },
    [shapeAddMut, createShape, params.canvasId, initUploadMut, finalizeAttachmentMut, utils],
  );

  // Paste an image from the clipboard → drop it at the viewport center.
  // Skips when focus is in a text field so it doesn't fight normal paste.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) imageFiles.push(f);
        }
      }
      if (imageFiles.length === 0) return;
      e.preventDefault();
      const rect = surfaceRef.current?.getBoundingClientRect();
      const center = surfaceToCanvas(
        (rect?.left ?? 0) + (rect?.width ?? 800) / 2,
        (rect?.top ?? 0) + (rect?.height ?? 600) / 2,
      );
      imageFiles.forEach((f, i) => void uploadImageAt(f, center.x + i * 24, center.y + i * 24));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [uploadImageAt, surfaceToCanvas]);

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
  //
  // Bursts of remote events (e.g. a peer dragging, or an agent dropping a
  // dozen shapes via bulkAddShapes) used to fire one full refetch *each*,
  // which flashes the whole canvas. We coalesce them into at most one
  // refetch per window so collaborative edits land smoothly. (True
  // element-level patching would need richer event payloads — tracked
  // separately; memoized cards already keep unchanged rows from
  // repainting on the refetch.)
  const hydrateInvalidateTimer = useRef<number | null>(null);
  const scheduleHydrateInvalidate = useCallback(() => {
    if (hydrateInvalidateTimer.current != null) return;
    hydrateInvalidateTimer.current = window.setTimeout(() => {
      hydrateInvalidateTimer.current = null;
      utils.canvas.hydrate.invalidate({ id: params.canvasId });
    }, 220);
  }, [utils, params.canvasId]);
  useEffect(
    () => () => {
      if (hydrateInvalidateTimer.current != null) {
        clearTimeout(hydrateInvalidateTimer.current);
        hydrateInvalidateTimer.current = null;
      }
    },
    [],
  );
  useRealtime(
    () => {
      if (draggingRef.current) return;
      scheduleHydrateInvalidate();
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
            {canvasKind === "PERSONAL" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDashboardViewMut.mutate({ view: "list" });
                  router.push(`/w/${ws.slug}/dashboard`);
                }}
                title="Back to the dashboard (List view)"
              >
                <LayoutGrid className="h-3.5 w-3.5" /> Dashboard
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setOpenSidebar((v) => !v)}
              title="Toggle entity picker"
            >
              <Layers className="h-3.5 w-3.5" /> {openSidebar ? "Hide rail" : "Show rail"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={enterPresentation}
              title={
                presentationSlides.length > 0
                  ? `Present ${presentationSlides.length} frame${presentationSlides.length === 1 ? "" : "s"} as slides`
                  : "Add a frame to present"
              }
              disabled={presentationSlides.length === 0}
            >
              <Play className="h-3.5 w-3.5" /> Present
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
              onClick={() => animateViewportTo({ x: 0, y: 0, zoom: 1 })}
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
      {canvasKind === "DESIGN" ? (
        <CanvasPageTabs
          canvasId={data.canvas.id}
          frames={frames}
          activePageId={activePageId}
        />
      ) : null}
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
            cursor: cursorForTool(activeTool, panning, connectorDraftRef.current != null),
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
          onContextMenu={(e) => {
            // W3.3: right-click anywhere on the surface opens a
            // context-aware menu. We branch on whether the click landed
            // on a shape (data-canvas-shape) vs background.
            const target = e.target as HTMLElement | null;
            const shapeEl = target?.closest("[data-canvas-shape]") as HTMLElement | null;
            const cardEl = target?.closest("[data-canvas-card]") as HTMLElement | null;
            const rect = surfaceRef.current?.getBoundingClientRect();
            const vx = e.clientX - (rect?.left ?? 0);
            const vy = e.clientY - (rect?.top ?? 0);
            const items: ContextMenuItem[] = [];
            if (shapeEl) {
              const shapeId = shapeEl.getAttribute("data-canvas-shape");
              if (shapeId) {
                items.push({
                  kind: "action",
                  label: "Duplicate",
                  shortcut: "⌘D",
                  onClick: () => {
                    const s = shapesRef.current.find((sh) => sh.id === shapeId);
                    if (!s || !shapeAddMut) return;
                    const dup: ShapeAddInput = {
                      canvasId: params.canvasId,
                      kind: s.kind,
                      x: s.x + 20,
                      y: s.y + 20,
                    };
                    if (s.width != null) dup.width = s.width;
                    if (s.height != null) dup.height = s.height;
                    if (s.path != null) dup.path = s.path;
                    if (s.style != null) dup.style = s.style as Record<string, unknown>;
                    if (s.text != null) dup.text = s.text;
                    if (s.groupId != null) dup.groupId = s.groupId;
                    void createShape(dup, "duplicate");
                  },
                });
                items.push({ kind: "separator" });
                items.push({
                  kind: "action",
                  label: "Delete",
                  shortcut: "⌫",
                  danger: true,
                  onClick: () => {
                    removeShapeUndoable(shapeId);
                  },
                });
              }
            } else if (cardEl) {
              const nodeId = cardEl.getAttribute("data-canvas-card");
              if (nodeId) {
                items.push({
                  kind: "action",
                  label: "Remove from canvas",
                  danger: true,
                  onClick: () => {
                    handleRemoveCard(nodeId);
                  },
                });
              }
            } else {
              // Background — drop in paste / new-issue / new-note / reset.
              const { x, y } = surfaceToCanvasRef.current?.(e.clientX, e.clientY) ?? {
                x: 0,
                y: 0,
              };
              const clip = canvasClipboardRef.current;
              items.push({
                kind: "action",
                label: `Paste${clip.shapes.length > 0 ? ` (${clip.shapes.length})` : ""}`,
                shortcut: "⌘V",
                disabled: clip.shapes.length === 0,
                onClick: () => {
                  // Re-use the keyboard paste path by simulating the
                  // body — but here we paste *at the cursor* rather
                  // than at the +20 offset.
                  if (!shapeAddMut) return;
                  for (const s of clip.shapes) {
                    const dup: ShapeAddInput = {
                      canvasId: params.canvasId,
                      kind: s.kind as ShapeAddInput["kind"],
                      x: x + s.relX,
                      y: y + s.relY,
                    };
                    if (s.width != null) dup.width = s.width;
                    if (s.height != null) dup.height = s.height;
                    if (s.path != null) dup.path = s.path;
                    if (s.style != null) dup.style = s.style as Record<string, unknown>;
                    if (s.text != null) dup.text = s.text;
                    if (s.groupId != null) dup.groupId = s.groupId;
                    void createShape(dup, "paste");
                  }
                },
              });
              items.push({ kind: "separator" });
              items.push({
                kind: "action",
                label: "New issue here",
                shortcut: "I",
                onClick: () => {
                  setEntityCreator({ viewportX: vx, viewportY: vy, canvasX: x, canvasY: y });
                },
              });
              items.push({
                kind: "action",
                label: "New note here",
                onClick: () => {
                  setEntityCreator({ viewportX: vx, viewportY: vy, canvasX: x, canvasY: y });
                },
              });
              items.push({ kind: "separator" });
              items.push({
                kind: "action",
                label: "Reset view",
                shortcut: "0",
                onClick: () => {
                  const r = surfaceRef.current?.getBoundingClientRect();
                  const viewW = r?.width ?? 800;
                  const viewH = r?.height ?? 600;
                  animateViewportTo({ x: viewW / 2, y: viewH / 2, zoom: 1 });
                },
              });
            }
            if (items.length === 0) return;
            e.preventDefault();
            setContextMenu({ x: vx, y: vy, items });
          }}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
              willChange: "transform",
            }}
          >
            {/* Frames sit at the very back so children render over them. */}
            <CanvasFrames
              frames={displayFrames}
              selectedFrameIds={selectedFrameIds}
              onSelectFrame={onSelectFrame}
              onFrameTitleMouseDown={onFrameTitleMouseDown}
              overrides={frameDragOverridesRef.current}
              activePageId={activePageId}
              canvasKind={canvasKind}
            />
            {/* Lane bands sit behind nodes. */}
            {lanes.map((lane) => (
              <LaneBand key={lane.name} lane={lane} />
            ))}
            {/* Shapes (Phase 2) sit BELOW edges + nodes by default.
                `visibleShapes` is `displayShapes` culled to the viewport
                once the board crosses VIRTUALIZE_THRESHOLD. */}
            <CanvasShapes
              shapes={visibleShapes}
              selectedIds={selectedShapeIds}
              onSelectShape={onSelectShape}
              editingShapeId={editingShapeFor}
              onTextShapeEditStart={(id) => setEditingShapeFor(id)}
              onTextShapeEditEnd={() => setEditingShapeFor(null)}
              onTextShapeSave={(id, text) => {
                if (shapePatchMut) {
                  shapePatchMut.mutate({ id, text });
                }
              }}
            />
            {/* Draft shape preview while drawing. */}
            <ShapeDraftPreview
              draftRef={shapeDraftRef}
              rev={shapeDraftRev}
              style={toolbarStyle}
            />
            {/* Rubber-band marquee while shift-dragging on background.
                Live hit count displayed alongside the rect (W2.3). */}
            <RubberBandPreview
              bandRef={rubberBandRef}
              rev={rubberBandRev}
              nodes={displayNodes}
              shapes={displayShapes}
              frames={displayFrames}
            />
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
            <CanvasComponentInstances
              instances={componentInstances}
              componentNameById={componentNameById}
              selectedIds={selectedInstanceIds}
              onSelect={(id, e) => {
                const additive = e.shiftKey || e.metaKey || e.ctrlKey;
                setSelected((prev) => {
                  if (additive) {
                    const has = prev.some(
                      (s) => s.kind === "instance" && s.id === id,
                    );
                    return has
                      ? prev.filter((s) => !(s.kind === "instance" && s.id === id))
                      : [...prev, { kind: "instance", id }];
                  }
                  return [{ kind: "instance", id }];
                });
              }}
            />
            {/* Smart alignment guides + size label (W1.4). Lives inside
                the scaling transform so the line positions track canvas
                coordinates; readers re-mount on dragRev. Grid-snap
                highlight (W2.4) is fed from the same drag handler. */}
            <SnapGuidesLayer
              guidesRef={snapGuidesRef}
              gridHighlightRef={gridSnapHighlightRef}
              rev={dragRev}
              zoom={viewport.zoom}
            />
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
          {/* Floating selection inspector (W1.5) — mounts in
              viewport-space (sibling of the scaling transform div) so
              its UI stays a constant pixel size regardless of zoom. */}
          {inspectorSelection && inspectorBbox && (
            <CanvasSelectionInspector
              selection={inspectorSelection}
              bbox={inspectorBbox}
              onPatch={onInspectorPatch}
              onDelete={onInspectorDelete}
            />
          )}
          {/* Right-click context menu (W3.3). */}
          {contextMenu && (
            <CanvasContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              items={contextMenu.items}
              onDismiss={() => setContextMenu(null)}
            />
          )}
          {/* Inline entity-create popover (W1.2). Mounts at the
              click site, dispatches issue.create / note.create, then
              drops a CanvasNode at the canvas-space anchor. */}
          {entityCreator && (
            <CanvasEntityCreator
              anchor={entityCreator}
              onClose={() => {
                setEntityCreator(null);
                setActiveTool("select");
              }}
              onCreated={(e) => {
                addNode.mutate({
                  canvasId: params.canvasId,
                  targetType: e.kind === "issue" ? "issue" : "note",
                  targetId: e.id,
                  x: e.canvasX,
                  y: e.canvasY,
                  width: 280,
                  height: 120,
                });
                setEntityCreator(null);
                setActiveTool("select");
              }}
            />
          )}
        </div>
        <CanvasRightPanel
          slug={ws.slug}
          canvasId={data.canvas.id}
          data={data}
          selected={selected as LayerSelectionRef[]}
          onSelect={(refs) => setSelected(refs as SelectedRef[])}
          selectionCount={selected.length}
          buildSelectionSnapshot={buildSelectionSnapshot}
        />
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
        stickyLocked={stickyToolLock}
        onToggleStickyLock={() => setStickyToolLock((v) => !v)}
        onInsertImage={() => imageInputRef.current?.click()}
      />
      {presenting ? (
        <CanvasPresentation
          total={presentationSlides.length}
          index={slideIndex}
          slideName={presentationSlides[slideIndex]?.name ?? null}
          onPrev={() => gotoSlide(slideIndex - 1)}
          onNext={() => gotoSlide(slideIndex + 1)}
          onGoto={gotoSlide}
          onExit={exitPresentation}
        />
      ) : null}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          const rect = surfaceRef.current?.getBoundingClientRect();
          const center = surfaceToCanvas(
            (rect?.left ?? 0) + (rect?.width ?? 800) / 2,
            (rect?.top ?? 0) + (rect?.height ?? 600) / 2,
          );
          files.forEach((f, i) => void uploadImageAt(f, center.x + i * 24, center.y + i * 24));
          e.target.value = "";
        }}
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
  if (kind === "frame") {
    // Distinct from `box` — frame draft uses the foreground token so
    // it reads as a structural region rather than a stroked shape.
    return (
      <div
        className="pointer-events-none absolute"
        style={{
          left: minX,
          top: minY,
          width: w,
          height: h,
          border: "1px dashed hsl(var(--foreground) / 0.5)",
          background: "hsl(var(--card) / 0.2)",
        }}
      />
    );
  }
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
  if (kind === "diamond") {
    return (
      <svg
        className="pointer-events-none absolute"
        style={{ left: minX, top: minY, width: Math.max(1, w), height: Math.max(1, h), overflow: "visible" }}
      >
        <polygon
          points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeDasharray="6 4"
        />
      </svg>
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
  if (kind === "sticky") {
    // Filled preview using the active sticky palette, so the operator
    // sees the color they're about to drop while dragging the bbox.
    const paletteKey = style.stickyPalette ?? "sand";
    const cssVar = `--sticky-${paletteKey}`;
    return (
      <div
        className="pointer-events-none absolute rounded-md shadow-md"
        style={{
          left: minX,
          top: minY,
          width: Math.max(20, w),
          height: Math.max(20, h),
          background: `hsl(var(${cssVar}) / 0.6)`,
          border: `1px dashed hsl(var(${cssVar}))`,
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
  nodes,
  shapes,
  frames,
}: {
  bandRef: React.MutableRefObject<RubberBand | null>;
  rev: number;
  nodes: HydratedNode[];
  shapes: CanvasShapeRow[];
  frames: CanvasFrameRow[];
}) {
  const band = bandRef.current;
  if (!band) return null;
  const left = Math.min(band.startX, band.endX);
  const top = Math.min(band.startY, band.endY);
  const width = Math.abs(band.endX - band.startX);
  const height = Math.abs(band.endY - band.startY);
  if (width < 1 && height < 1) return null;
  // Live AABB hit count (W2.3). Mirrors the mouseup handler so the
  // badge matches the eventual selection 1:1.
  let count = 0;
  const right = left + width;
  const bottom = top + height;
  const hits = (x: number, y: number, w: number, h: number) =>
    !(x + w < left || x > right || y + h < top || y > bottom);
  for (const n of nodes) if (hits(n.x, n.y, n.width, n.height)) count++;
  for (const s of shapes) {
    const sw = s.width ?? 0;
    const sh = s.height ?? 0;
    if (sw > 0 && sh > 0 && hits(s.x, s.y, sw, sh)) count++;
  }
  for (const f of frames) if (hits(f.x, f.y, f.width, f.height)) count++;
  return (
    <>
      <div
        className="pointer-events-none absolute rounded-sm border border-ember/60 bg-ember/10"
        style={{ left, top, width, height }}
      />
      {count > 0 && (
        <div
          className="pointer-events-none absolute rounded bg-ember px-1.5 py-0.5 font-mono text-[0.6875rem] text-ember-foreground shadow"
          style={{ left: right + 6, top }}
        >
          {count}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Smart alignment guides overlay (W1.4). Pure SVG. Reads from a ref so
// drag-move can mutate without re-rendering this component until the
// `rev` counter ticks. Sits inside the scaling transform so coordinates
// are in canvas-space; line stroke is scaled inverse to zoom so guides
// stay 1px in viewport pixels regardless of zoom.
// ---------------------------------------------------------------------------

function SnapGuidesLayer({
  guidesRef,
  gridHighlightRef,
  rev: _rev,
  zoom,
}: {
  guidesRef: React.MutableRefObject<{
    guides: Array<{ axis: "x" | "y"; at: number; spanStart: number; spanEnd: number }>;
    labels: Array<{ x: number; y: number; value: number; axis: "x" | "y" }>;
    sizeLabel: { x: number; y: number; width: number; height: number } | null;
  }>;
  gridHighlightRef?: React.MutableRefObject<{ x: number; y: number; w: number; h: number } | null>;
  rev: number;
  zoom: number;
}) {
  const state = guidesRef.current;
  const gridHighlight = gridHighlightRef?.current ?? null;
  if (state.guides.length === 0 && !state.sizeLabel && !gridHighlight) return null;
  const stroke = 1 / Math.max(0.01, zoom);
  const labelScale = 1 / Math.max(0.01, zoom);
  return (
    <svg
      className="pointer-events-none absolute left-0 top-0"
      style={{ overflow: "visible" }}
      width={1}
      height={1}
    >
      {gridHighlight && (
        <>
          {/* Row highlight (horizontal band) */}
          <rect
            x={-100000}
            y={gridHighlight.y}
            width={200000}
            height={Math.max(1, gridHighlight.h)}
            fill="hsl(var(--ember) / 0.06)"
          />
          {/* Column highlight (vertical band) */}
          <rect
            x={gridHighlight.x}
            y={-100000}
            width={Math.max(1, gridHighlight.w)}
            height={200000}
            fill="hsl(var(--ember) / 0.06)"
          />
        </>
      )}
      {state.guides.map((g, i) =>
        g.axis === "x" ? (
          <line
            key={`g${i}`}
            x1={g.at}
            x2={g.at}
            y1={g.spanStart}
            y2={g.spanEnd}
            stroke="hsl(var(--ember))"
            strokeWidth={stroke}
            strokeDasharray={`${4 * stroke} ${4 * stroke}`}
            opacity={0.85}
          />
        ) : (
          <line
            key={`g${i}`}
            x1={g.spanStart}
            x2={g.spanEnd}
            y1={g.at}
            y2={g.at}
            stroke="hsl(var(--ember))"
            strokeWidth={stroke}
            strokeDasharray={`${4 * stroke} ${4 * stroke}`}
            opacity={0.85}
          />
        ),
      )}
      {state.labels.map((l, i) => (
        <g key={`l${i}`} transform={`translate(${l.x}, ${l.y}) scale(${labelScale})`}>
          <rect x={-14} y={-7} width={28} height={14} rx={2} fill="hsl(var(--ember))" />
          <text
            x={0}
            y={3}
            fill="hsl(var(--ember-foreground))"
            fontSize={10}
            fontFamily="ui-monospace, monospace"
            textAnchor="middle"
          >
            {Math.round(l.value)}
          </text>
        </g>
      ))}
      {state.sizeLabel && (
        <g
          transform={`translate(${state.sizeLabel.x}, ${state.sizeLabel.y}) scale(${labelScale})`}
        >
          <rect x={-30} y={-7} width={60} height={14} rx={2} fill="hsl(var(--foreground) / 0.85)" />
          <text
            x={0}
            y={3}
            fill="hsl(var(--background))"
            fontSize={10}
            fontFamily="ui-monospace, monospace"
            textAnchor="middle"
          >
            {Math.round(state.sizeLabel.width)} × {Math.round(state.sizeLabel.height)}
          </text>
        </g>
      )}
    </svg>
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
  rev,
}: {
  cursorsRef: React.MutableRefObject<Map<string, RemoteCursor>>;
  viewport: Viewport;
  rev: number;
}) {
  // Remote cursors arrive at ~10Hz, which looks steppy if rendered raw.
  // We keep a display position per peer and ease it toward the latest
  // target every frame, so peer cursors glide instead of teleporting.
  const displayRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const rafRef = useRef<number | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const loop = () => {
      const targets = cursorsRef.current;
      const disp = displayRef.current;
      // Drop display entries for peers that went stale.
      for (const id of [...disp.keys()]) if (!targets.has(id)) disp.delete(id);
      let moving = false;
      for (const [id, c] of targets) {
        const d = disp.get(id) ?? { x: c.x, y: c.y };
        const dx = c.x - d.x;
        const dy = c.y - d.y;
        if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
          disp.set(id, { x: c.x, y: c.y });
        } else {
          disp.set(id, { x: d.x + dx * 0.28, y: d.y + dy * 0.28 });
          moving = true;
        }
      }
      setTick((t) => t + 1);
      // Settle: stop the loop once everything has converged; it restarts
      // when a fresh packet bumps `rev` (this effect re-runs).
      if (moving) {
        rafRef.current = requestAnimationFrame(loop);
      } else {
        rafRef.current = null;
      }
    };
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [cursorsRef, rev]);

  const cursors = [...cursorsRef.current.values()];
  return (
    <>
      {cursors.map((c) => {
        const d = displayRef.current.get(c.id) ?? { x: c.x, y: c.y };
        return (
          <div
            key={c.id}
            className="pointer-events-none absolute z-30"
            style={{
              transform: `translate(${d.x * viewport.zoom + viewport.x}px, ${d.y * viewport.zoom + viewport.y}px)`,
              willChange: "transform",
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
        );
      })}
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
  // Anchor on the source handle, render a cheap straight line to the
  // cursor while the operator drags. Orthogonal A* routing happens only
  // on drop — paying for obstacle avoidance every pointer-move is the
  // main source of "drawing node flows is delayed".
  const anchor = handleAnchorForRect(nodeToRect(fromNode), draft.fromHandle);
  const ax = anchor.x;
  const ay = anchor.y;
  const bx = draft.toX;
  const by = draft.toY;
  const minX = Math.min(ax, bx) - 16;
  const minY = Math.min(ay, by) - 16;
  const maxX = Math.max(ax, bx) + 16;
  const maxY = Math.max(ay, by) + 16;
  // Subtle quadratic so the line eases away from the source handle —
  // visual hint of direction without the cost of orthogonal routing.
  const cpx =
    draft.fromHandle === "left" ? ax - 40
    : draft.fromHandle === "right" ? ax + 40
    : ax;
  const cpy =
    draft.fromHandle === "top" ? ay - 40
    : draft.fromHandle === "bottom" ? ay + 40
    : ay;
  return (
    <svg
      className="pointer-events-none absolute"
      style={{ left: minX, top: minY, width: maxX - minX, height: maxY - minY }}
      width={maxX - minX}
      height={maxY - minY}
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
    >
      <path
        d={`M ${ax} ${ay} Q ${cpx} ${cpy} ${bx} ${by}`}
        fill="none"
        stroke="hsl(var(--ember))"
        strokeWidth={2}
        strokeDasharray="6 4"
        opacity={0.85}
      />
      <circle cx={bx} cy={by} r={4} fill="hsl(var(--ember))" opacity={0.85} />
    </svg>
  );
}

function handleAnchorForRect(rect: Rect, side: HandleSide): { x: number; y: number } {
  switch (side) {
    case "left":   return { x: rect.x,                 y: rect.y + rect.height / 2 };
    case "right":  return { x: rect.x + rect.width,    y: rect.y + rect.height / 2 };
    case "top":    return { x: rect.x + rect.width / 2, y: rect.y };
    case "bottom": return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
  }
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
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              updateMutAny.mutate({ id: node.targetId, body: draft });
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(body);
              onEditChange(false);
            }
          }}
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
            onClick={() => {
              setDraft(body);
              onEditChange(false);
            }}
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
        <div className="mt-1.5 grid grid-cols-2 gap-1">
          {(["issue", "artifact", "chat-thread", "agent"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={
                "min-w-0 truncate rounded border px-1 py-0.5 text-[10px] uppercase tracking-wide transition-all duration-200 " +
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

