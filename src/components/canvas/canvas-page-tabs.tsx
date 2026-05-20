"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X, Pencil } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import type { CanvasFrameRow } from "@/components/canvas/canvas-frames";

type CanvasPageTabsProps = {
  canvasId: string;
  frames: CanvasFrameRow[];
  activePageId: string | null;
};

/**
 * Tab strip for DESIGN canvases — one tab per top-level frame with
 * `isPage = true`, in `z` order. Click activates; `+` adds; right-click
 * opens a Rename / Delete menu. Mounted ABOVE the canvas viewport.
 */
export function CanvasPageTabs({
  canvasId,
  frames,
  activePageId,
}: CanvasPageTabsProps) {
  const utils = trpc.useUtils();
  const invalidate = () => utils.canvas.hydrate.invalidate({ id: canvasId });

  const pages = useMemo(
    () =>
      frames
        .filter((f) => f.isPage && f.parentFrameId === null && !f.hiddenAt)
        .sort((a, b) => a.z - b.z),
    [frames],
  );

  const canvasRouterAny = (trpc as unknown as Record<string, unknown>).canvas as
    | Record<string, unknown>
    | undefined;
  type PageAddInput = { canvasId: string; name: string };
  type PageActivateInput = { canvasId: string; frameId: string };
  type PageRemoveInput = { frameId: string };
  type FramePatchInput = { frameId: string; name?: string };
  type MutHook<TInput, TOutput> = {
    useMutation: (opts?: {
      onSuccess?: (data: TOutput, vars: TInput) => void;
      onError?: (e: { message: string }) => void;
    }) => {
      mutate: (input: TInput) => void;
      isPending: boolean;
    };
  };
  const pageAddAny = canvasRouterAny?.pageAdd as
    | MutHook<PageAddInput, { frameId: string }>
    | undefined;
  const pageRemoveAny = canvasRouterAny?.pageRemove as
    | MutHook<PageRemoveInput, { ok: true }>
    | undefined;
  const pageActivateAny = canvasRouterAny?.pageActivate as
    | MutHook<PageActivateInput, { ok: true }>
    | undefined;
  const framePatchAny = canvasRouterAny?.framePatch as
    | MutHook<FramePatchInput, { ok: true }>
    | undefined;

  const pageAdd = pageAddAny?.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const pageRemove = pageRemoveAny?.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const pageActivate = pageActivateAny?.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const framePatch = framePatchAny?.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e.message),
  });

  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!menuFor) return;
    const close = () => {
      setMenuFor(null);
      setMenuAt(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [menuFor]);

  useEffect(() => {
    if (renamingId && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [renamingId]);

  const commitRename = () => {
    if (!renamingId || !framePatch) return;
    const trimmed = renameValue.trim();
    if (trimmed.length === 0) {
      setRenamingId(null);
      return;
    }
    framePatch.mutate({ frameId: renamingId, name: trimmed });
    setRenamingId(null);
  };

  if (!pageAddAny || !pageActivateAny) {
    // Backend doesn't expose page procs (older server) — degrade to
    // a single-page surface; don't render the tab strip at all.
    return null;
  }

  return (
    <div
      className="flex items-center gap-1 border-b border-border bg-card/40 px-2 py-1"
      data-canvas-page-tabs
    >
      {pages.map((page) => {
        const active = page.id === activePageId;
        return (
          <div key={page.id} className="relative">
            {renamingId === page.id ? (
              <input
                ref={renameRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  else if (e.key === "Escape") setRenamingId(null);
                }}
                className="h-7 rounded-md border border-border bg-card px-2 text-meta text-foreground outline-none focus:border-ember/60"
                style={{ width: Math.max(80, renameValue.length * 8 + 24) }}
              />
            ) : (
              <button
                type="button"
                aria-pressed={active}
                onClick={() => {
                  if (active) return;
                  if (!pageActivate) return;
                  pageActivate.mutate({ canvasId, frameId: page.id });
                }}
                onDoubleClick={() => {
                  setRenamingId(page.id);
                  setRenameValue(page.name);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuFor(page.id);
                  setMenuAt({ x: e.clientX, y: e.clientY });
                }}
                className={cn(
                  "h-7 rounded-md px-3 text-meta transition-colors",
                  active
                    ? "bg-card text-foreground ring-1 ring-border"
                    : "text-muted-foreground hover:bg-subtle hover:text-foreground",
                )}
                title={`${page.name} — double-click to rename, right-click for more`}
              >
                {page.name}
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        title="Add page"
        aria-label="Add page"
        onClick={() => {
          if (!pageAdd) return;
          const nextNum = pages.length + 1;
          pageAdd.mutate({ canvasId, name: `Page ${nextNum}` });
        }}
        disabled={pageAdd?.isPending ?? false}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>

      {menuFor && menuAt
        ? (() => {
            const page = pages.find((p) => p.id === menuFor);
            if (!page) return null;
            return (
              <div
                role="menu"
                className="pointer-events-auto fixed z-50 min-w-[160px] rounded-md border border-border bg-card py-1 shadow-lg"
                style={{ left: menuAt.x, top: menuAt.y }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-meta text-foreground hover:bg-subtle"
                  onClick={() => {
                    setRenamingId(page.id);
                    setRenameValue(page.name);
                    setMenuFor(null);
                    setMenuAt(null);
                  }}
                >
                  <Pencil className="h-3 w-3" /> Rename
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-meta text-danger hover:bg-danger/10"
                  onClick={() => {
                    setConfirmingDelete(page.id);
                    setMenuFor(null);
                    setMenuAt(null);
                  }}
                  disabled={pages.length <= 1}
                  title={pages.length <= 1 ? "Can't delete the last page" : undefined}
                >
                  <X className="h-3 w-3" /> Delete page
                </button>
              </div>
            );
          })()
        : null}

      {confirmingDelete
        ? (() => {
            const page = pages.find((p) => p.id === confirmingDelete);
            if (!page) return null;
            return (
              <div
                role="dialog"
                aria-modal="true"
                className="fixed inset-0 z-50 flex items-center justify-center bg-background/50 backdrop-blur-sm"
                onClick={() => setConfirmingDelete(null)}
              >
                <div
                  className="w-[360px] rounded-lg border border-border bg-card p-4 shadow-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="text-sm font-medium text-foreground">
                    Delete &ldquo;{page.name}&rdquo;?
                  </div>
                  <div className="mt-1 text-meta text-muted-foreground">
                    All frames, nodes, and shapes on this page will be deleted.
                  </div>
                  <div className="mt-4 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      className="rounded-md px-3 py-1.5 text-meta text-muted-foreground hover:bg-subtle hover:text-foreground"
                      onClick={() => setConfirmingDelete(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="rounded-md bg-danger px-3 py-1.5 text-meta text-card hover:bg-danger/90"
                      onClick={() => {
                        if (!pageRemove) return;
                        pageRemove.mutate({ frameId: page.id });
                        setConfirmingDelete(null);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })()
        : null}
    </div>
  );
}
