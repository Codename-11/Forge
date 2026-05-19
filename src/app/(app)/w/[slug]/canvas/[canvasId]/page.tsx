"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Archive,
  ChevronLeft,
  ExternalLink,
  Maximize2,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

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

/**
 * Canvas viewer. Renders nodes as absolutely-positioned cards on a
 * pan/zoom surface. Cards are read-only displays of canonical entity
 * data fetched via the hydrate endpoint — clicking a card opens its
 * source route. Operators can drag cards to reposition (persisted via
 * canvas.patchNode) and add new cards from the right rail picker.
 *
 * Edges are persisted but not yet rendered visually; that's deferred
 * to the next viewer pass.
 */
export default function CanvasViewerPage() {
  const params = useParams<{ slug: string; canvasId: string }>();
  const router = useRouter();
  const ws = useWorkspace();
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.canvas.hydrate.useQuery({ id: params.canvasId });

  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [panning, setPanning] = useState(false);
  const panStart = useRef<{ vx: number; vy: number; mx: number; my: number } | null>(null);
  const dragNode = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const [openPicker, setOpenPicker] = useState(false);

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

  const setViewportMut = trpc.canvas.setViewport.useMutation({
    onError: (e) => toast.error(e.message),
  });

  const removeNode = trpc.canvas.removeNode.useMutation({
    onSuccess: () => utils.canvas.hydrate.invalidate({ id: params.canvasId }),
    onError: (e) => toast.error(e.message),
  });

  const archive = trpc.canvas.archive.useMutation({
    onSuccess: () => {
      toast.success("Canvas archived");
      router.push(`/w/${ws.slug}/canvas`);
    },
    onError: (e) => toast.error(e.message),
  });

  const nodes = useMemo(() => (data?.nodes ?? []) as HydratedNode[], [data?.nodes]);

  // -- Pan + zoom handlers --------------------------------------------

  const onBackgroundMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-canvas-card]")) return;
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

  // -- Card drag (move) ----------------------------------------------

  const onCardMouseDown = useCallback(
    (e: React.MouseEvent, node: HydratedNode) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      dragNode.current = {
        id: node.id,
        offsetX: e.clientX - node.x * viewport.zoom - viewport.x,
        offsetY: e.clientY - node.y * viewport.zoom - viewport.y,
      };
    },
    [viewport.x, viewport.y, viewport.zoom],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragNode.current) return;
      const { id, offsetX, offsetY } = dragNode.current;
      const newX = (e.clientX - viewport.x - offsetX) / viewport.zoom;
      const newY = (e.clientY - viewport.y - offsetY) / viewport.zoom;
      // Optimistically place the node by mutating the cached query.
      utils.canvas.hydrate.setData(
        { id: params.canvasId },
        (curr) => {
          if (!curr) return curr;
          return {
            ...curr,
            nodes: curr.nodes.map((n) =>
              n.id === id ? { ...n, x: newX, y: newY } : n,
            ),
          };
        },
      );
    };
    const onUp = () => {
      if (!dragNode.current) return;
      const { id } = dragNode.current;
      const moved = nodes.find((n) => n.id === id);
      if (moved) {
        patchNode.mutate({ id, x: moved.x, y: moved.y });
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
              onClick={() => setViewport({ x: 0, y: 0, zoom: 1 })}
              title="Reset view"
            >
              <Maximize2 className="h-3.5 w-3.5" /> Reset
            </Button>
            <Button size="sm" variant="ember" onClick={() => setOpenPicker(true)}>
              <Plus className="h-3.5 w-3.5" /> Add card
            </Button>
          </>
        }
      />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-card/20">
        <div
          className="absolute inset-0 select-none"
          style={{
            cursor: panning ? "grabbing" : "grab",
            backgroundImage:
              "radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px)",
            backgroundSize: `${20 * viewport.zoom}px ${20 * viewport.zoom}px`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          }}
          onMouseDown={onBackgroundMouseDown}
          onWheel={onWheel}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            }}
          >
            {nodes.length === 0 ? (
              <div
                className="absolute left-8 top-8 rounded-lg border border-dashed border-border bg-card/30 p-6 text-sm text-muted-foreground"
                style={{ width: 320 }}
              >
                Empty canvas. Click <span className="font-mono">Add card</span> to drop the first one.
                Drag the background to pan; <span className="font-mono">⌘/Ctrl + wheel</span> to zoom.
              </div>
            ) : null}
            {nodes.map((node) => (
              <CanvasCard
                key={node.id}
                node={node}
                onMouseDown={(e) => onCardMouseDown(e, node)}
                onRemove={() => {
                  if (window.confirm("Remove this card from the canvas?")) {
                    removeNode.mutate({ id: node.id });
                  }
                }}
              />
            ))}
          </div>
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

function CanvasCard({
  node,
  onMouseDown,
  onRemove,
}: {
  node: HydratedNode;
  onMouseDown: (e: React.MouseEvent) => void;
  onRemove: () => void;
}) {
  const tone = node.ref.missing
    ? "border-warning/40 bg-warning/5"
    : "border-border bg-card/80";
  return (
    <div
      data-canvas-card
      className={`absolute flex flex-col gap-1 rounded-lg border p-3 shadow-md ${tone}`}
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        minHeight: node.height,
      }}
      onMouseDown={onMouseDown}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-meta uppercase tracking-wide text-muted-foreground">
            {node.targetType.replace("-", " ")}
            {node.ref.subLabel ? <span> · {node.ref.subLabel}</span> : null}
          </div>
          <div className="line-clamp-3 text-sm font-medium">
            {node.ref.missing ? `Missing ${node.targetType}` : node.ref.label}
          </div>
        </div>
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
      {node.ref.url ? (
        <a
          href={node.ref.url}
          onMouseDown={(e) => e.stopPropagation()}
          className="mt-auto inline-flex items-center gap-1 text-meta text-ember hover:underline"
        >
          Open <ExternalLink className="h-3 w-3" />
        </a>
      ) : null}
    </div>
  );
}

function AddCardPicker({
  canvasId,
  onClose,
}: {
  canvasId: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const ws = useWorkspace();
  const [tab, setTab] = useState<"issue" | "artifact">("issue");

  const issues = trpc.issue.list.useQuery({ limit: 25 }, { enabled: tab === "issue" });
  const artifacts = trpc.artifact.list.useQuery(
    { limit: 25 },
    { enabled: tab === "artifact" },
  );

  const addNode = trpc.canvas.addNode.useMutation({
    onSuccess: () => {
      toast.success("Card added");
      utils.canvas.hydrate.invalidate({ id: canvasId });
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const addCard = (targetType: "issue" | "artifact", targetId: string) => {
    addNode.mutate({
      canvasId,
      targetType,
      targetId,
      x: 40 + Math.random() * 200,
      y: 40 + Math.random() * 200,
      width: 280,
      height: 100,
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
        <div className="flex gap-2">
          {(["issue", "artifact"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md border px-2 py-1 text-xs ${
                tab === t
                  ? "border-ember bg-ember/15 text-ember"
                  : "border-border bg-card/40 text-muted-foreground hover:bg-subtle"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <ul className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
          {tab === "issue" &&
            (issues.data?.items ?? []).map((row) => (
              <li key={row.id}>
                <button
                  onClick={() => addCard("issue", row.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-card/40 px-2 py-1.5 text-left hover:border-ember/40"
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
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-card/40 px-2 py-1.5 text-left hover:border-ember/40"
                >
                  <span className="truncate text-sm">{row.title}</span>
                  <span className="text-meta text-muted-foreground">
                    {row.type.toLowerCase()}
                  </span>
                </button>
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}
