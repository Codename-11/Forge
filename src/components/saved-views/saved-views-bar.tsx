"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, BookmarkPlus, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Confirm, QuickForm } from "@/components/ui/modal";
import { PinButton } from "@/components/pins/pin-button";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import {
  filtersEqual,
  isEmptyFilters,
  safeParseFilters,
  type SavedViewFilters,
} from "@/lib/saved-view-filters";

/**
 * Saved-views row for /issues. Renders below the quick-filter bar.
 *
 * Visual contract: saved views are **rounded outline** chips, distinct
 * from the **square solid** quick-filter chips that sit above. Active
 * (currently-applied) view is rendered with a filled ember tint to
 * mirror the chip-active treatment, but keeps the pill shape so the
 * row never visually blurs into the quick-filter bar.
 *
 * Drag-to-reorder uses the same HTML5 DnD pattern as the initiative
 * list (see `initiatives/page.tsx`) so muscle memory carries over.
 *
 * "Save current filters" lives at the end of the row, separated by a
 * thin rule, so it doesn't compete with view chips for selection.
 */
export function SavedViewsBar({
  currentFilters,
  activeViewId,
  onApply,
  onCreate,
}: {
  currentFilters: SavedViewFilters;
  activeViewId: string | null;
  onApply: (id: string | null, filters: SavedViewFilters) => void;
  onCreate: () => void;
}) {
  const utils = trpc.useUtils();
  const ws = useMaybeWorkspace();
  const { data: views } = trpc.savedView.list.useQuery();

  const update = trpc.savedView.update.useMutation({
    onSuccess: () => {
      utils.savedView.list.invalidate();
      toast.success("View updated.");
    },
    onError: (e) => toast.error(e.message),
  });

  const remove = trpc.savedView.delete.useMutation({
    onSuccess: () => {
      utils.savedView.list.invalidate();
      toast.success("View deleted.");
    },
    onError: (e) => toast.error(e.message),
  });

  const reorder = trpc.savedView.reorder.useMutation({
    onMutate: async ({ ids }) => {
      await utils.savedView.list.cancel();
      const prev = utils.savedView.list.getData();
      utils.savedView.list.setData(undefined, (old) => {
        if (!old) return old;
        const byId = new Map(old.map((v) => [v.id, v]));
        const next = ids.map((id) => byId.get(id)!).filter(Boolean);
        for (const v of old) if (!ids.includes(v.id)) next.push(v);
        return next.map((v, i) => ({ ...v, orderIndex: i }));
      });
      return { prev };
    },
    onError: (_e, _i, ctx) => {
      if (ctx?.prev) utils.savedView.list.setData(undefined, ctx.prev);
      toast.error("Reorder failed.");
    },
    onSettled: () => utils.savedView.list.invalidate(),
  });

  // Drag state — local only; persisted via reorder.mutate on drop.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // Per-view popover (rename / update / delete).
  const [menuId, setMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuId) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuId(null);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuId]);

  // Rename dialog state.
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  // Confirm-delete state.
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  function onDragStart(id: string) {
    setDraggingId(id);
  }
  function onDrop(targetId: string) {
    if (!draggingId || draggingId === targetId || !views) {
      setDraggingId(null);
      setOverId(null);
      return;
    }
    const ids = views.map((v) => v.id);
    const from = ids.indexOf(draggingId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    setDraggingId(null);
    setOverId(null);
    reorder.mutate({ ids: next });
  }

  const hasViews = (views?.length ?? 0) > 0;
  const filtersDirty = !isEmptyFilters(currentFilters);

  // Quick-save: when the current filters match an existing saved view
  // exactly, surface "Save changes" (overwrite) + "New view" (clone)
  // inline. When they don't match, fall through to "Save view" only.
  // The match check is order-independent and ignores the stored
  // sortKey, since the saved-view bar doesn't track sort yet.
  const matchedView = useMemo(() => {
    if (!filtersDirty || !views) return null;
    return views.find((v) => filtersEqual(safeParseFilters(v.filters), currentFilters)) ?? null;
  }, [views, currentFilters, filtersDirty]);

  // Avoid dedicating a permanent toolbar row to an empty-state sentence.
  // The row appears as soon as there is a saved view or something useful
  // to save.
  if (!hasViews && !filtersDirty) return null;

  return (
    <>
      <div className="flex min-h-[1.75rem] flex-wrap items-center gap-1.5">
        {!hasViews ? (
          <span className="text-meta italic text-muted-foreground">
            No saved views yet — apply some filters and save them.
          </span>
        ) : (
          <ul
            className="flex flex-wrap items-center gap-1.5"
            onDragOver={(e) => e.preventDefault()}
          >
            {views!.map((v) => {
              const isActive = activeViewId === v.id;
              const isDragTarget = overId === v.id && draggingId !== v.id;
              return (
                <li key={v.id}>
                  <div className="relative inline-flex items-center">
                    <button
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        onDragStart(v.id);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setOverId(v.id);
                      }}
                      onDragLeave={() => setOverId((o) => (o === v.id ? null : o))}
                      onDrop={(e) => {
                        e.preventDefault();
                        onDrop(v.id);
                      }}
                      onClick={() => onApply(v.id, safeParseFilters(v.filters))}
                      className={cn(
                        "focus-ring inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 transition-colors",
                        "text-meta",
                        isActive
                          ? "border-ember/60 bg-ember/15 text-foreground"
                          : "border-border/80 bg-transparent text-muted-foreground hover:border-ember/40 hover:bg-subtle/40 hover:text-foreground",
                        isDragTarget && "ring-1 ring-ember/40",
                      )}
                      title="Click to apply · drag to reorder"
                    >
                      <Bookmark
                        className={cn("h-3 w-3", isActive ? "fill-ember/60 text-ember" : "")}
                        aria-hidden
                      />
                      <span className="max-w-[160px] truncate">{v.name}</span>
                    </button>
                    {/* Phase 1A: per-workspace pin toggle. Lives between
                        the chip body and the ⋯ menu so it's discoverable
                        without expanding the menu. Skipped when the
                        workspace context isn't available (e.g. SSR
                        previews). */}
                    {ws && (
                      <PinButton
                        targetType="SAVED_VIEW"
                        targetId={v.id}
                        workspaceId={ws.id}
                        className="ml-0.5 h-6 w-5 rounded-full"
                      />
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuId((id) => (id === v.id ? null : v.id));
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenuId(v.id);
                      }}
                      className="focus-ring ml-0.5 inline-flex h-6 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-subtle/60 hover:text-foreground"
                      aria-label={`Options for ${v.name}`}
                    >
                      <MoreHorizontal className="h-3 w-3" aria-hidden />
                    </button>

                    {menuId === v.id && (
                      <div
                        ref={menuRef}
                        className="absolute left-0 top-[calc(100%+4px)] z-30 w-48 overflow-hidden rounded-md border border-border bg-card shadow-lg"
                      >
                        <ul className="py-1 text-xs">
                          <li>
                            <button
                              type="button"
                              className="block w-full px-3 py-1.5 text-left hover:bg-subtle"
                              onClick={() => {
                                setMenuId(null);
                                setRenameTarget({ id: v.id, name: v.name });
                              }}
                            >
                              Rename
                            </button>
                          </li>
                          <li>
                            <button
                              type="button"
                              className="block w-full px-3 py-1.5 text-left hover:bg-subtle disabled:opacity-50"
                              disabled={!filtersDirty}
                              onClick={() => {
                                setMenuId(null);
                                update.mutate({
                                  id: v.id,
                                  filters: currentFilters,
                                });
                              }}
                              title={
                                filtersDirty
                                  ? "Replace this view's filters with the current selection"
                                  : "Apply some filters first"
                              }
                            >
                              Update with current filters
                            </button>
                          </li>
                          <li className="my-1 border-t border-border" />
                          <li>
                            <button
                              type="button"
                              className="block w-full px-3 py-1.5 text-left text-foreground hover:bg-ember/10"
                              onClick={() => {
                                setMenuId(null);
                                setDeleteTarget({ id: v.id, name: v.name });
                              }}
                            >
                              Delete
                            </button>
                          </li>
                        </ul>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Save-as buttons at the end of the row. Two modes:
            - filtersDirty + matchedView: "Save changes" overwrites
              the matched view, "New view" forks. The matched view's
              name is shown as a small label so the operator knows
              what they'd be saving over.
            - filtersDirty + no match: single "Save view" button.
            - !filtersDirty: disabled "Save view" button. */}
        {hasViews && <span className="mx-1 h-4 w-px bg-border/60" aria-hidden />}
        {filtersDirty && matchedView ? (
          <>
            <span
              className="text-meta inline-flex items-center gap-1 rounded-full border border-ember/30 bg-ember/10 px-2.5 py-0.5 text-foreground"
              title={`Current filters match the saved view "${matchedView.name}".`}
            >
              <Bookmark className="h-3 w-3 fill-ember/60 text-ember" aria-hidden />
              <span className="max-w-[140px] truncate">{matchedView.name}</span>
            </span>
            <button
              type="button"
              onClick={() =>
                update.mutate({
                  id: matchedView.id,
                  filters: currentFilters,
                })
              }
              className="focus-ring text-meta inline-flex h-6 items-center gap-1 rounded-full border border-ember/40 px-2.5 text-foreground hover:bg-ember/10"
              title={`Overwrite "${matchedView.name}" with the current filters.`}
              disabled={update.isPending}
            >
              <Bookmark className="h-3 w-3" aria-hidden />
              Save changes
            </button>
            <button
              type="button"
              onClick={onCreate}
              className="focus-ring text-meta inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-ember/40 px-2.5 text-foreground hover:bg-ember/10"
              title="Save the current filters as a brand-new view."
            >
              <BookmarkPlus className="h-3 w-3" aria-hidden />
              New view
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onCreate}
            disabled={!filtersDirty}
            className={cn(
              "focus-ring text-meta inline-flex h-6 items-center gap-1 rounded-full border border-dashed px-2.5",
              filtersDirty
                ? "border-ember/40 text-foreground hover:bg-ember/10"
                : "cursor-not-allowed border-border/60 text-muted-foreground/60",
            )}
            title={filtersDirty ? "Save the current filters as a view" : "Apply some filters first"}
          >
            <BookmarkPlus className="h-3 w-3" aria-hidden />
            Save view
          </button>
        )}
      </div>

      {renameTarget && (
        <RenameDialog
          target={renameTarget}
          onClose={() => setRenameTarget(null)}
          onSubmit={async (name) => {
            await update.mutateAsync({ id: renameTarget.id, name });
          }}
        />
      )}

      <Confirm
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        variant="destructive"
        title={deleteTarget ? `Delete view "${deleteTarget.name}"?` : "Delete view?"}
        description="The filters are detached, but no issues are touched."
        primaryLabel="Delete"
        loading={remove.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return;
          await remove.mutateAsync({ id: deleteTarget.id });
          if (activeViewId === deleteTarget.id) onApply(null, {});
          setDeleteTarget(null);
        }}
      />
    </>
  );
}

/**
 * Tiny rename dialog — single-field text input. Submits via QuickForm
 * for consistent ⏎ / ⎋ behavior with the rest of the modal layer.
 */
function RenameDialog({
  target,
  onClose,
  onSubmit,
}: {
  target: { id: string; name: string };
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(target.name);
  return (
    <QuickForm
      open={true}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Rename view"
      primaryLabel="Save"
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) return { error: "Name is required." };
        if (trimmed === target.name) {
          onClose();
          return;
        }
        try {
          await onSubmit(trimmed);
        } catch (err) {
          return {
            error: err instanceof Error ? err.message : "Save failed.",
          };
        }
      }}
    >
      <QuickForm.Field label="Name" required>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </QuickForm.Field>
    </QuickForm>
  );
}

/**
 * Save-current-filters-as-new-view dialog. Renders standalone so the
 * caller can mount it conditionally.
 */
export function SaveViewDialog({
  open,
  onClose,
  filters,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  filters: SavedViewFilters;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const utils = trpc.useUtils();
  const create = trpc.savedView.create.useMutation({
    onSuccess: ({ id }) => {
      utils.savedView.list.invalidate();
      toast.success("View saved.");
      setName("");
      onCreated(id);
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const filterCount = useMemo(() => activeFilterCount(filters), [filters]);

  return (
    <QuickForm
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Save current filters as view"
      description={
        filterCount === 0
          ? "No filters are active — nothing to save."
          : `${filterCount} filter${filterCount === 1 ? "" : "s"} will be captured.`
      }
      primaryLabel="Save view"
      loading={create.isPending}
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) return { error: "Name is required." };
        if (filterCount === 0) {
          return { error: "Apply at least one filter before saving." };
        }
        try {
          await create.mutateAsync({ name: trimmed, filters });
        } catch (err) {
          return {
            error: err instanceof Error ? err.message : "Save failed.",
          };
        }
      }}
    >
      <QuickForm.Field label="Name" required>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder="e.g. My triage queue"
        />
      </QuickForm.Field>
    </QuickForm>
  );
}

function activeFilterCount(f: SavedViewFilters): number {
  let n = 0;
  for (const v of Object.values(f)) {
    if (Array.isArray(v) && v.length > 0) n++;
    else if (typeof v === "boolean" && v) n++;
    else if (typeof v === "string" && v) n++;
  }
  return n;
}
