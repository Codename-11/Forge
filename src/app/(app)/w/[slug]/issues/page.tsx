"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Sparkles, Folder } from "lucide-react";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { IssueList } from "@/components/issue-list";
import { IssueBoard } from "@/components/issue-board";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  DensityProvider,
  EmptyState,
  Kbd,
  useDensity,
  useSetDensity,
} from "@/components/ui";
import { ViewToggle, useViewPref } from "@/components/view-toggle";
import {
  CycleFilterChip,
  InitiativeFilterChip,
  type CycleFilter,
  type InitiativeFilter,
} from "@/components/saved-views/filter-chips";
import { QuickFilterChips } from "@/components/saved-views/quick-filter-chips";
import {
  SavedViewsBar,
  SaveViewDialog,
} from "@/components/saved-views/saved-views-bar";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";
import {
  isEmptyFilters,
  safeParseFilters,
  type SavedViewFilters,
} from "@/lib/saved-view-filters";

/**
 * Issues triage surface.
 *
 * Layout (top → bottom):
 *   Topbar          — title + search + density + view toggle
 *   Quick filters   — built-in toggle chips (Unassigned, My backlog, Blocked,
 *                     Recently updated). Always visible; not persisted.
 *   Saved views     — user-created views; click to apply, drag to reorder,
 *                     menu to rename/update/delete. End: "Save view".
 *   Sprint / Initiative chips + Clear filters
 *   Issue list / board
 *
 * Filter state is unified into a single `SavedViewFilters` object that's
 * the source of truth for the query and the saved-view payload. The
 * Sprint and Initiative chip selectors are projected onto the array
 * fields (`cycleIds[0]` / `initiativeIds[0]`) so a saved view captures
 * them faithfully.
 */
export default function IssuesPage() {
  const ws = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [view, setView] = useViewPref("issues");
  const [query, setQuery] = useState("");
  // Debounced mirror of `query` — only this value reaches the list
  // query, so typing doesn't fire a request per keystroke. `query`
  // itself drives the input + the `hasFilters` chip immediately.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);
  const searchPending = query.trim() !== debouncedQuery.trim();
  const [filters, setFilters] = useState<SavedViewFilters>({});
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  const { data: wsCount, isLoading: wsLoading } =
    trpc.workspace.current.useQuery();
  const { data: me } = trpc.user.me.useQuery();
  const { data: views } = trpc.savedView.list.useQuery();
  const key = wsCount?.key ?? ws.key;

  // -- URL sync ---------------------------------------------------------
  // `?view=<id>` deep links land here, then resolve to filters when the
  // saved-view list arrives. Mismatches (deleted view, wrong workspace)
  // silently fall back to a clean state.
  // `?dueOn=YYYY-MM-DD` is a transient filter (Today widget week-peek
  // deep-link); not part of saved views, lives only in the URL + chip.
  const viewIdFromUrl = searchParams?.get("view") ?? null;
  const dueOnFromUrl = searchParams?.get("dueOn") ?? null;
  // Validate the URL value before threading it into the query. A
  // malformed `?dueOn=foo` shouldn't hit the server.
  const dueOn =
    dueOnFromUrl && /^\d{4}-\d{2}-\d{2}$/.test(dueOnFromUrl)
      ? dueOnFromUrl
      : null;
  useEffect(() => {
    if (!viewIdFromUrl) {
      setActiveViewId(null);
      return;
    }
    if (!views) return;
    const match = views.find((v) => v.id === viewIdFromUrl);
    if (match) {
      setActiveViewId(match.id);
      setFilters(safeParseFilters(match.filters));
    } else {
      // Unknown view id — strip from URL.
      setActiveViewId(null);
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.delete("view");
      const q = params.toString();
      router.replace(q ? `${pathname}?${q}` : pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewIdFromUrl, views?.length]);

  // Cycle / initiative chip state derives from `filters`.
  const cycleId: CycleFilter = filters.withoutCycle
    ? null
    : (filters.cycleIds?.[0] ?? undefined);
  const initiativeId: InitiativeFilter = filters.withoutInitiative
    ? null
    : (filters.initiativeIds?.[0] ?? undefined);

  function setCycleId(v: CycleFilter) {
    onChangeFilters({
      ...filters,
      cycleIds: typeof v === "string" ? [v] : undefined,
      withoutCycle: v === null ? true : undefined,
    });
  }
  function setInitiativeId(v: InitiativeFilter) {
    onChangeFilters({
      ...filters,
      initiativeIds: typeof v === "string" ? [v] : undefined,
      withoutInitiative: v === null ? true : undefined,
    });
  }

  /**
   * Any direct user-edit of the filters drops the active-view selection
   * (we no longer represent the saved view exactly). Re-clicking the
   * view chip restores it.
   */
  function onChangeFilters(next: SavedViewFilters) {
    setFilters(next);
    if (activeViewId) {
      setActiveViewId(null);
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.delete("view");
      const q = params.toString();
      router.replace(q ? `${pathname}?${q}` : pathname);
    }
  }

  function applyView(id: string | null, applied: SavedViewFilters) {
    setFilters(applied);
    setActiveViewId(id);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (id) params.set("view", id);
    else params.delete("view");
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname);
  }

  function clearAllFilters() {
    setFilters({});
    setQuery("");
    setDebouncedQuery("");
    if (activeViewId) {
      setActiveViewId(null);
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.delete("view");
      const q = params.toString();
      router.replace(q ? `${pathname}?${q}` : pathname);
    }
  }

  function clearDueOn() {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.delete("dueOn");
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname);
  }

  const hasFilters = !isEmptyFilters(filters) || !!query || !!dueOn;
  const isWorkspaceEmpty =
    !!wsCount && wsCount._count.issues === 0 && !hasFilters;

  // The query object we pass down. `query` is kept separate from the
  // saved-view filter blob (it's not persisted with views by default to
  // avoid stale string searches in saved tabs).
  const issueQueryFilters: SavedViewFilters = useMemo(
    () => ({ ...filters, query: debouncedQuery || undefined }),
    [filters, debouncedQuery],
  );

  const activeView =
    activeViewId && views ? views.find((v) => v.id === activeViewId) : null;

  return (
    <DensityProvider>
      <Topbar
        title="All issues"
        subtitle={wsCount ? `${wsCount._count.issues} total` : undefined}
        actions={
          <div className="flex items-center gap-2">
            {view === "list" && !isWorkspaceEmpty && (
              <>
                <div className="relative">
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search…"
                    className="h-7 w-48 pr-7 text-xs"
                  />
                  {searchPending && (
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                      <Spinner size="sm" />
                    </span>
                  )}
                </div>
                <DensityToggle />
              </>
            )}
            {!isWorkspaceEmpty && (
              <ViewToggle value={view} onChange={setView} />
            )}
          </div>
        }
      />

      {!isWorkspaceEmpty && (
        <div className="space-y-2 border-b border-border bg-card/20 px-5 py-2.5">
          {/* Quick filters — non-saved built-ins. */}
          <QuickFilterChips
            filters={filters}
            onChange={onChangeFilters}
            meId={me?.id}
          />

          {/* Saved views — user-defined, persisted, reorderable. */}
          <SavedViewsBar
            currentFilters={filters}
            activeViewId={activeViewId}
            onApply={applyView}
            onCreate={() => setSaveOpen(true)}
          />

          {/* Sprint + Initiative selectors — single-pick today, projected
              onto the saved-view array fields under the hood. */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <CycleFilterChip value={cycleId} onChange={setCycleId} />
            <InitiativeFilterChip
              value={initiativeId}
              onChange={setInitiativeId}
            />
            {dueOn && <DueOnChip dueOn={dueOn} onClear={clearDueOn} />}
            {hasFilters && (
              <button
                type="button"
                onClick={() => {
                  clearAllFilters();
                  if (dueOn) clearDueOn();
                }}
                className="text-meta text-muted-foreground hover:text-foreground"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {wsLoading ? null : isWorkspaceEmpty ? (
          <div className="flex h-full items-center justify-center px-6">
            <EmptyState
              variant="page"
              icon={<Sparkles />}
              title="No issues yet"
              description={
                <span>
                  Create your first issue with <Kbd>⇧C</Kbd>, or{" "}
                  <Link
                    href={`/w/${ws.slug}/projects`}
                    className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:text-ember hover:underline"
                  >
                    <Folder className="h-3 w-3" aria-hidden />
                    browse projects
                  </Link>{" "}
                  to find one that needs work.
                </span>
              }
              action={
                <Button data-quick-create variant="ember" size="sm">
                  New issue
                </Button>
              }
            />
          </div>
        ) : view === "list" ? (
          <div className="h-full overflow-y-auto">
            <IssueList
              workspaceKey={key}
              extraFilters={issueQueryFilters}
              dueOn={dueOn ?? undefined}
              emptyOverride={
                hasFilters ? (
                  <FilteredEmptyState
                    activeViewName={activeView?.name ?? null}
                    onClear={() => {
                      clearAllFilters();
                      if (dueOn) clearDueOn();
                    }}
                  />
                ) : undefined
              }
            />
          </div>
        ) : (
          <IssueBoard workspaceKey={key} extraFilters={issueQueryFilters} />
        )}
      </div>

      <SaveViewDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        filters={filters}
        onCreated={(id) => {
          setActiveViewId(id);
          const params = new URLSearchParams(searchParams?.toString() ?? "");
          params.set("view", id);
          router.replace(`${pathname}?${params.toString()}`);
        }}
      />
    </DensityProvider>
  );
}

/**
 * Inline empty-state shown inside the list when the user's filters
 * have narrowed to zero matches. Distinct from the workspace-empty
 * state above (which prompts creation).
 */
function FilteredEmptyState({
  activeViewName,
  onClear,
}: {
  activeViewName: string | null;
  onClear: () => void;
}) {
  return (
    <div className="flex h-60 items-center justify-center">
      <EmptyState
        variant="section"
        icon={<Sparkles />}
        title="No issues match this view"
        description={
          <span>
            {activeViewName ? (
              <>
                The view{" "}
                <span className="font-medium text-foreground">
                  {activeViewName}
                </span>{" "}
                has no matches right now.{" "}
              </>
            ) : (
              "Your active filters returned nothing. "
            )}
            <button
              type="button"
              onClick={onClear}
              className="text-foreground underline-offset-2 hover:text-ember hover:underline"
            >
              Clear filters
            </button>{" "}
            to see all issues.
          </span>
        }
      />
    </div>
  );
}

/**
 * Dismissible "Due on …" chip. Surfaced when the page is opened from
 * the Today widget's week-peek deep-link (`?dueOn=YYYY-MM-DD`). The X
 * removes the URL param without disturbing other filters.
 */
function DueOnChip({
  dueOn,
  onClear,
}: {
  dueOn: string;
  onClear: () => void;
}) {
  // Parse the YYYY-MM-DD as UTC midnight to avoid timezone surprises
  // when displaying "May 4" in the chip.
  const [y, m, d] = dueOn.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const label = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-ember/40 bg-ember/10 px-2 py-0.5 text-meta text-ember">
      Due on {label}
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear due-on filter"
        className="focus-ring -mr-0.5 ml-0.5 rounded p-0.5 hover:bg-ember/20"
      >
        <span aria-hidden>×</span>
      </button>
    </span>
  );
}

/**
 * Two-state density picker. Lives in the issues toolbar — density only
 * makes sense for the list view, so we render it beside the search input
 * inside the list-view branch.
 */
function DensityToggle() {
  const density = useDensity();
  const setDensity = useSetDensity();
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5 text-[0.6875rem]">
      <button
        type="button"
        onClick={() => setDensity("comfortable")}
        className={cn(
          "focus-ring rounded px-1.5 py-0.5",
          density === "comfortable"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
        title="Comfortable rows"
      >
        Cozy
      </button>
      <button
        type="button"
        onClick={() => setDensity("compact")}
        className={cn(
          "focus-ring rounded px-1.5 py-0.5",
          density === "compact"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
        title="Compact rows"
      >
        Compact
      </button>
    </div>
  );
}
