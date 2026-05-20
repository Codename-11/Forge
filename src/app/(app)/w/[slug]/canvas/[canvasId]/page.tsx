"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Archive,
  ChevronLeft,
  ExternalLink,
  GitBranch,
  Layers,
  Maximize2,
  MessageCircle,
  Plus,
  StickyNote,
  Trash2,
  Bot,
  User as UserIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { useRealtime } from "@/hooks/use-realtime";
import { relativeTime } from "@/lib/utils";
import { ChatMarkdown } from "@/components/mission-control/chat-markdown";

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
  | { kind: "resize"; nodeId: string; startX: number; startY: number; startW: number; startH: number };

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
  const [dropActive, setDropActive] = useState(false);
  const [remoteCursors, setRemoteCursors] = useState<Map<string, RemoteCursor>>(new Map());
  const [editingLaneFor, setEditingLaneFor] = useState<string | null>(null);
  const [editingNoteFor, setEditingNoteFor] = useState<string | null>(null);

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

  const archive = trpc.canvas.archive.useMutation({
    onSuccess: () => {
      toast.success("Canvas archived");
      router.push(`/w/${ws.slug}/canvas`);
    },
    onError: (e) => toast.error(e.message),
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

  const nodes = useMemo(() => (data?.nodes ?? []) as HydratedNode[], [data?.nodes]);
  const edges = useMemo(
    () =>
      (data?.edges ?? []) as Array<{
        id: string;
        fromNodeId: string;
        toNodeId: string;
        label: string | null;
        kind: string | null;
      }>,
    [data?.edges],
  );

  // -- Pan + zoom handlers --------------------------------------------

  const onBackgroundMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-canvas-card]")) return;
    if (editingLaneFor || editingNoteFor) return;
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
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragNode.current;
      if (!drag) return;
      if (drag.kind === "node") {
        const { nodeId, offsetX, offsetY } = drag;
        const newX = (e.clientX - viewport.x - offsetX) / viewport.zoom;
        const newY = (e.clientY - viewport.y - offsetY) / viewport.zoom;
        utils.canvas.hydrate.setData({ id: params.canvasId }, (curr) => {
          if (!curr) return curr;
          return {
            ...curr,
            nodes: curr.nodes.map((n) => (n.id === nodeId ? { ...n, x: newX, y: newY } : n)),
          };
        });
      } else if (drag.kind === "resize") {
        const { nodeId, startX, startY, startW, startH } = drag;
        const dx = (e.clientX - startX) / viewport.zoom;
        const dy = (e.clientY - startY) / viewport.zoom;
        const w = Math.max(120, startW + dx);
        const h = Math.max(80, startH + dy);
        utils.canvas.hydrate.setData({ id: params.canvasId }, (curr) => {
          if (!curr) return curr;
          return {
            ...curr,
            nodes: curr.nodes.map((n) => (n.id === nodeId ? { ...n, width: w, height: h } : n)),
          };
        });
      }
    };
    const onUp = () => {
      const drag = dragNode.current;
      if (!drag) return;
      const moved = nodes.find((n) => n.id === drag.nodeId);
      if (moved) {
        if (drag.kind === "node") {
          patchNode.mutate({ id: drag.nodeId, x: moved.x, y: moved.y });
        } else {
          patchNode.mutate({ id: drag.nodeId, width: moved.width, height: moved.height });
        }
      }
      dragNode.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, viewport.x, viewport.y, viewport.zoom]);

  // -- Lanes ----------------------------------------------------------

  const lanes = useMemo(() => computeLanes(nodes), [nodes]);

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
      addNode.mutate({
        canvasId: params.canvasId,
        targetType: payload.type as "issue" | "artifact",
        targetId: payload.id,
        x,
        y,
        width: 280,
        height: 120,
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
      setRemoteCursors((prev) => {
        const next = new Map(prev);
        next.set(id, {
          id,
          name: payload.name ?? "Operator",
          color: colorForId(id),
          x: payload.x!,
          y: payload.y!,
          updatedAt: Date.now(),
        });
        return next;
      });
    },
    { subjectType: "canvas-presence" },
  );

  // Sweep stale cursors every second.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setRemoteCursors((prev) => {
        let mutated = false;
        const next = new Map(prev);
        for (const [id, c] of prev.entries()) {
          if (now - c.updatedAt > PRESENCE_STALE_MS) {
            next.delete(id);
            mutated = true;
          }
        }
        return mutated ? next : prev;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Throttled local cursor broadcast — uses the optional helper only.
  const presencePublishAny = canvasRouterAny?.broadcastPresence as
    | {
        useMutation: () => {
          mutate: (input: { canvasId: string; x: number; y: number }) => void;
        };
      }
    | undefined;
  const presencePublishMut = presencePublishAny?.useMutation();
  const lastPublishRef = useRef(0);
  const onSurfaceMouseMove = (e: React.MouseEvent) => {
    if (!presencePublishMut) return;
    const now = Date.now();
    if (now - lastPublishRef.current < 1000 / PRESENCE_PUBLISH_HZ) return;
    lastPublishRef.current = now;
    const { x, y } = surfaceToCanvas(e.clientX, e.clientY);
    try {
      presencePublishMut.mutate({ canvasId: params.canvasId, x, y });
    } catch {
      /* ignore */
    }
  };

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
        subtitle={`Canvas · ${nodes.length} card${nodes.length === 1 ? "" : "s"} · ${(viewport.zoom * 100).toFixed(0)}%`}
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
                // a plan row is created.
                let stepCount = 0;
                const skipped: Array<{ targetType: string; reason: string }> = [];
                for (const n of nodes) {
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
                const skippedLabel =
                  skipped.length === 0
                    ? "no nodes will be skipped"
                    : `${skipped.length} node${skipped.length === 1 ? "" : "s"} will be skipped (${[
                        ...new Set(skipped.map((s) => s.targetType)),
                      ].join(", ")})`;
                const ok = window.confirm(
                  `Create a new plan with ${stepCount} step${stepCount === 1 ? "" : "s"} from this canvas?\n\n${skippedLabel}.`,
                );
                if (!ok) return;
                convertToPlanMut.mutate({ canvasId: params.canvasId });
              }}
            >
              <GitBranch className="h-3.5 w-3.5" />{" "}
              {convertToPlanMut?.isPending ? "Converting…" : "Convert to plan"}
            </Button>
            <Button size="sm" variant="ember" onClick={() => setOpenPicker(true)}>
              <Plus className="h-3.5 w-3.5" /> Add card
            </Button>
          </>
        }
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {openSidebar ? (
          <CanvasEntityRail canvasId={data.canvas.id} />
        ) : null}
        <div
          ref={surfaceRef}
          className={
            "relative flex-1 select-none overflow-hidden bg-card/20 transition-shadow duration-200 " +
            (dropActive ? "ring-2 ring-ember/60 ring-inset" : "")
          }
          style={{
            cursor: panning ? "grabbing" : "grab",
            backgroundImage:
              "radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px)",
            backgroundSize: `${20 * viewport.zoom}px ${20 * viewport.zoom}px`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
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
            {/* Edges sit between lane bands and node cards. */}
            <EdgesOverlay nodes={nodes} edges={edges} />
            {nodes.length === 0 ? (
              <div
                className="absolute left-8 top-8 rounded-lg border border-dashed border-border bg-card/30 p-6 text-sm text-muted-foreground"
                style={{ width: 320 }}
              >
                Empty canvas. Drag in from the left rail, or click{" "}
                <span className="font-mono">Add card</span>. Drag background to pan;{" "}
                <span className="font-mono">⌘/Ctrl + wheel</span> to zoom.
              </div>
            ) : null}
            {nodes.map((node) => (
              <CanvasCard
                key={node.id}
                node={node}
                editingLane={editingLaneFor === node.id}
                editingNote={editingNoteFor === node.id}
                onEditLane={(active) => setEditingLaneFor(active ? node.id : null)}
                onEditNote={(active) => setEditingNoteFor(active ? node.id : null)}
                onMouseDown={(e) => onCardMouseDown(e, node)}
                onResizeMouseDown={(e) => onResizeMouseDown(e, node)}
                onRemove={() => {
                  if (window.confirm("Remove this card from the canvas?")) {
                    removeNode.mutate({ id: node.id });
                  }
                }}
                onPatchLane={(lane) => {
                  // Persist via canvas.patchNodeMeta (set lane=null to
                  // delete the key when the operator clears the field).
                  patchNodeMeta.mutate({
                    id: node.id,
                    meta: { lane: lane.trim() ? lane.trim() : null },
                  });
                  utils.canvas.hydrate.setData({ id: params.canvasId }, (curr) => {
                    if (!curr) return curr;
                    return {
                      ...curr,
                      nodes: curr.nodes.map((n) => {
                        if (n.id !== node.id) return n;
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
                }}
              />
            ))}
          </div>
          {/* Remote cursors */}
          {[...remoteCursors.values()].map((c) => (
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
        </div>
        <div className="pointer-events-none absolute bottom-3 right-3 z-10">
          <div className="pointer-events-auto flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="bg-card/80 backdrop-blur"
              onClick={() => {
                if (window.confirm("Archive this canvas?")) {
                  archive.mutate({ id: data.canvas.id });
                }
              }}
              disabled={archive.isPending}
            >
              <Archive className="h-3.5 w-3.5" /> Archive
            </Button>
          </div>
        </div>
      </div>
      {openPicker && (
        <AddCardPicker
          canvasId={data.canvas.id}
          onClose={() => setOpenPicker(false)}
        />
      )}
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

function EdgesOverlay({
  nodes,
  edges,
}: {
  nodes: HydratedNode[];
  edges: Array<{
    id: string;
    fromNodeId: string;
    toNodeId: string;
    label: string | null;
    kind: string | null;
  }>;
}) {
  const nodeById = useMemo(() => {
    const m = new Map<string, HydratedNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  if (edges.length === 0) return null;

  // Pick stroke + opacity by edge.kind so the timeline-style "depends_on"
  // chain stands out from the structural "contains" plumbing.
  const styleFor = (kind: string | null): { stroke: string; dash?: string; opacity: number } => {
    switch (kind) {
      case "depends_on":
        return { stroke: "var(--ember, #d97706)", opacity: 0.7 };
      case "contains":
        return { stroke: "var(--muted-foreground, #78716c)", dash: "4 4", opacity: 0.4 };
      default:
        return { stroke: "var(--muted-foreground, #78716c)", opacity: 0.55 };
    }
  };

  // Bounding box across nodes — used to size the SVG and to translate
  // it so the arrowheads stay aligned at any pan/zoom (the parent
  // already applies the transform; we just need a big-enough canvas
  // and the right origin).
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
  const margin = 80;
  const left = Math.floor(minX - margin);
  const top = Math.floor(minY - margin);
  const width = Math.ceil(maxX - minX + margin * 2);
  const height = Math.ceil(maxY - minY + margin * 2);

  return (
    <svg
      className="pointer-events-none absolute"
      style={{ left, top, width, height }}
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
          <path d="M0,-4 L8,0 L0,4 Z" fill="var(--ember, #d97706)" />
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
          <path d="M0,-4 L8,0 L0,4 Z" fill="var(--muted-foreground, #78716c)" />
        </marker>
      </defs>
      {edges.map((e) => {
        const from = nodeById.get(e.fromNodeId);
        const to = nodeById.get(e.toNodeId);
        if (!from || !to) return null;
        // Connect from the centers projected onto each node's nearest
        // border. Simpler than full ortho routing; good enough for v1.
        const fromCx = from.x + from.width / 2;
        const fromCy = from.y + from.height / 2;
        const toCx = to.x + to.width / 2;
        const toCy = to.y + to.height / 2;
        const dx = toCx - fromCx;
        const dy = toCy - fromCy;
        const fromEdge = projectToRect(fromCx, fromCy, from, dx, dy);
        const toEdge = projectToRect(toCx, toCy, to, -dx, -dy);
        const x1 = fromEdge.x - left;
        const y1 = fromEdge.y - top;
        const x2 = toEdge.x - left;
        const y2 = toEdge.y - top;
        const style = styleFor(e.kind);
        const marker =
          e.kind === "depends_on" ? "url(#edge-arrow-ember)" : "url(#edge-arrow-muted)";
        // Mid-point for the label.
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        return (
          <g key={e.id} opacity={style.opacity}>
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={style.stroke}
              strokeWidth={1.5}
              strokeDasharray={style.dash}
              markerEnd={marker}
            />
            {e.label && (
              <g transform={`translate(${mx}, ${my})`}>
                <rect
                  x={-Math.min(60, e.label.length * 3 + 8)}
                  y={-9}
                  width={Math.min(120, e.label.length * 6 + 16)}
                  height={16}
                  rx={4}
                  fill="var(--card, #fafaf9)"
                  fillOpacity={0.85}
                  stroke="var(--border, #d6d3d1)"
                />
                <text
                  textAnchor="middle"
                  dy="0.32em"
                  fontSize={10}
                  fill="var(--muted-foreground, #57534e)"
                >
                  {e.label}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function projectToRect(
  cx: number,
  cy: number,
  rect: { x: number; y: number; width: number; height: number },
  vx: number,
  vy: number,
): { x: number; y: number } {
  // Cast a ray from center along (vx,vy) and find where it hits the
  // rect's border. Returns the border point.
  if (vx === 0 && vy === 0) return { x: cx, y: cy };
  const hx = rect.width / 2;
  const hy = rect.height / 2;
  const tx = vx === 0 ? Infinity : (vx > 0 ? hx : -hx) / vx;
  const ty = vy === 0 ? Infinity : (vy > 0 ? hy : -hy) / vy;
  const t = Math.min(Math.abs(tx), Math.abs(ty));
  return { x: cx + vx * t, y: cy + vy * t };
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

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
}: {
  node: HydratedNode;
  editingLane: boolean;
  editingNote: boolean;
  onEditLane: (active: boolean) => void;
  onEditNote: (active: boolean) => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onResizeMouseDown: (e: React.MouseEvent) => void;
  onRemove: () => void;
  onPatchLane: (lane: string) => void;
}) {
  const isLive = node.viewMode === "live";
  const isRunning =
    !node.ref.missing &&
    ((node.ref.meta?.status as string | undefined) === "RUNNING" ||
      (node.ref.meta?.status as string | undefined) === "ACTIVE");
  const glow = isLive && isRunning ? "ring-2 ring-ember/60 animate-pulse" : "";
  const kind = (node.ref.meta?.kind as string | undefined) ?? null;
  const isNote = node.targetType === "artifact" && kind === "NOTE";

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
    body = <NoteCardBody node={node} editing={editingNote} onEditChange={onEditNote} />;
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

  return (
    <div
      data-canvas-card
      className={`absolute flex flex-col gap-1.5 rounded-lg border p-3 shadow-md transition-all duration-300 hover:shadow-lg ${tone} ${glow}`}
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        minHeight: node.height,
      }}
      onMouseDown={onMouseDown}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">{body}</div>
        <div className="flex flex-col items-end gap-0.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEditLane(!editingLane);
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
              onRemove();
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
          onCancel={() => onEditLane(false)}
          onSave={onPatchLane}
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
        onMouseDown={onResizeMouseDown}
        className="absolute bottom-0.5 right-0.5 h-3 w-3 cursor-nwse-resize rounded-sm bg-border/40 hover:bg-ember/40"
      />
    </div>
  );
}

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
    addNode.mutate({
      canvasId,
      targetType,
      targetId,
      x: 40 + Math.random() * 200,
      y: 40 + Math.random() * 200,
      width: 280,
      height: 120,
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
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card/50">
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
