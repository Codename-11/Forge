"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Archive, ArchiveRestore, Sparkles, Folder } from "lucide-react";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { IssueList } from "@/components/issue-list";
import { IssueBoard } from "@/components/issue-board";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { DensityProvider, EmptyState, Kbd, useDensity, useSetDensity } from "@/components/ui";
import { ViewToggle, useViewPref } from "@/components/view-toggle";
import {
  CycleFilterChip,
  InitiativeFilterChip,
  ProjectFilterChip,
  type CycleFilter,
  type InitiativeFilter,
  type ProjectFilter,
} from "@/components/saved-views/filter-chips";
import { GroupChip, IssueFacetChips, SortChip } from "@/components/saved-views/facet-chips";
import { QuickFilterChips } from "@/components/saved-views/quick-filter-chips";
import { SavedViewsBar, SaveViewDialog } from "@/components/saved-views/saved-views-bar";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";
import {
  doneStatusIds,
  filtersEqual,
  isEmptyFilters,
  ISSUE_GROUP_VALUES,
  ISSUE_SORT_VALUES,
  resolveIncludeDone,
  safeParseFilters,
  type IssueGroupBy,
  type IssueSort,
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

  // -- URL state --------------------------------------------------------
  // The issues view encodes its full state in the URL, so a filtered list
  // is shareable, bookmarkable, refresh-safe, and Back/Forward works:
  //   ?view=<id>          saved view (its filters are authoritative)
  //   ?f=<json>           ad-hoc SavedViewFilters blob (when no view pinned)
  //   ?q=<text>           search query
  //   ?sort= / ?group=    per-user view prefs (localStorage seeds default)
  //   ?dueOn=YYYY-MM-DD    transient Today-widget deep link
  const viewIdFromUrl = searchParams?.get("view") ?? null;
  const fParam = searchParams?.get("f") ?? null;
  const dueOnFromUrl = searchParams?.get("dueOn") ?? null;
  const showArchived = searchParams?.get("archived") === "1";
  // Reject a malformed or calendar-invalid ?dueOn (e.g. 2026-13-45, which
  // passes the shape regex but rolls over) before it reaches the chip/query.
  const dueOn = dueOnFromUrl && isRealDateString(dueOnFromUrl) ? dueOnFromUrl : null;

  // Sort + group: localStorage seeds the per-user default; a URL param (a
  // shared link, or Back/Forward) overrides it.
  const [sortPref, setSortPref] = useStoredPref<IssueSort>(
    "forge:issues:sort",
    "priority",
    ISSUE_SORT_VALUES,
  );
  const [groupPref, setGroupPref] = useStoredPref<IssueGroupBy>(
    "forge:issues:group",
    "status",
    ISSUE_GROUP_VALUES,
  );
  const sortParam = searchParams?.get("sort");
  const groupParam = searchParams?.get("group");
  const sort: IssueSort = (ISSUE_SORT_VALUES as readonly string[]).includes(sortParam ?? "")
    ? (sortParam as IssueSort)
    : sortPref;
  const groupBy: IssueGroupBy = (ISSUE_GROUP_VALUES as readonly string[]).includes(groupParam ?? "")
    ? (groupParam as IssueGroupBy)
    : groupPref;

  // Filters + query hydrate from the URL on first render; the effect below
  // re-syncs them on Back/Forward. (Query isn't pulled back from the URL
  // post-mount so live typing isn't clobbered by our own ?q= write.)
  const [filters, setFilters] = useState<SavedViewFilters>(() =>
    fParam ? safeParseFilters(safeJsonParse(fParam)) : {},
  );
  const [query, setQuery] = useState(() => searchParams?.get("q") ?? "");
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  const { data: wsCount, isLoading: wsLoading } = trpc.workspace.current.useQuery();
  const { data: me } = trpc.user.me.useQuery();
  const { data: views } = trpc.savedView.list.useQuery();
  const key = wsCount?.key ?? ws.key;

  // Canonical URL writer. Every mutation routes through here, building the
  // full search string from explicit values — so two writers can't race on
  // a stale `searchParams` snapshot (the old double-replace "Clear filters"
  // bug that re-introduced ?view= and snapped filters back).
  const buildSearch = useCallback(
    (s: {
      filters: SavedViewFilters;
      query: string;
      sort: IssueSort;
      group: IssueGroupBy;
      view: string | null;
      dueOn: string | null;
      archived: boolean;
    }) => {
      const p = new URLSearchParams();
      if (s.view) p.set("view", s.view);
      else if (!isEmptyFilters(s.filters)) p.set("f", JSON.stringify(s.filters));
      if (s.query.trim()) p.set("q", s.query.trim());
      if (s.sort !== "priority") p.set("sort", s.sort);
      if (s.group !== "status") p.set("group", s.group);
      if (s.dueOn) p.set("dueOn", s.dueOn);
      if (s.archived) p.set("archived", "1");
      return p.toString();
    },
    [],
  );
  const commit = useCallback(
    (
      next: Partial<{
        filters: SavedViewFilters;
        query: string;
        sort: IssueSort;
        group: IssueGroupBy;
        view: string | null;
        dueOn: string | null;
        archived: boolean;
      }>,
      opts?: { push?: boolean },
    ) => {
      const qs = buildSearch({
        filters: next.filters ?? filters,
        query: next.query ?? query,
        sort: next.sort ?? sort,
        group: next.group ?? groupBy,
        view: next.view !== undefined ? next.view : (activeViewId ?? viewIdFromUrl),
        dueOn: next.dueOn !== undefined ? next.dueOn : dueOn,
        archived: next.archived ?? showArchived,
      });
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (opts?.push) router.push(url);
      else router.replace(url);
    },
    [
      buildSearch,
      filters,
      query,
      sort,
      groupBy,
      activeViewId,
      viewIdFromUrl,
      dueOn,
      showArchived,
      pathname,
      router,
    ],
  );

  // Debounce the search box; only the debounced value reaches the query.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);
  const searchPending = query.trim() !== debouncedQuery.trim();
  // Reflect the debounced search into ?q=, skipping the mount value so the
  // URL isn't rewritten before a ?view= has resolved.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    commit({ query: debouncedQuery });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  // Hydrate filters/view FROM the URL on mount and Back/Forward. Equality
  // guards keep this from looping against the writers above.
  useEffect(() => {
    if (viewIdFromUrl) {
      if (!views) return; // resolve once the saved-view list arrives
      const match = views.find((v) => v.id === viewIdFromUrl);
      if (match) {
        setActiveViewId(match.id);
        const vf = safeParseFilters(match.filters);
        setFilters((prev) => (filtersEqual(prev, vf) ? prev : vf));
      } else {
        // Unknown / foreign view id — strip it with a single replace.
        setActiveViewId(null);
        commit({ view: null });
      }
      return;
    }
    setActiveViewId(null);
    const urlFilters = fParam ? safeParseFilters(safeJsonParse(fParam)) : {};
    setFilters((prev) => (filtersEqual(prev, urlFilters) ? prev : urlFilters));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fParam, viewIdFromUrl, views?.length]);

  // Project / Cycle / initiative chip state derives from `filters`.
  const projectId: ProjectFilter = filters.withoutProject
    ? null
    : (filters.projectIds?.[0] ?? undefined);
  const cycleId: CycleFilter = filters.withoutCycle ? null : (filters.cycleIds?.[0] ?? undefined);
  const initiativeId: InitiativeFilter = filters.withoutInitiative
    ? null
    : (filters.initiativeIds?.[0] ?? undefined);

  function setProjectId(v: ProjectFilter) {
    onChangeFilters({
      ...filters,
      projectIds: typeof v === "string" ? [v] : undefined,
      withoutProject: v === null ? true : undefined,
    });
  }

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

  const setSort = (v: IssueSort) => {
    setSortPref(v);
    commit({ sort: v });
  };
  const setGroupBy = (v: IssueGroupBy) => {
    setGroupPref(v);
    commit({ group: v });
  };

  /**
   * A direct user-edit of the filters drops the active saved view (we no
   * longer represent it exactly) and pushes a history entry so Back undoes
   * the change. Re-clicking the view chip restores it.
   */
  function onChangeFilters(next: SavedViewFilters) {
    setFilters(next);
    setActiveViewId(null);
    commit({ filters: next, view: null }, { push: true });
  }

  function applyView(id: string | null, applied: SavedViewFilters) {
    setFilters(applied);
    setActiveViewId(id);
    commit({ filters: applied, view: id }, { push: true });
  }

  function clearAllFilters() {
    setFilters({});
    setQuery("");
    setDebouncedQuery("");
    setActiveViewId(null);
    // One URL write that drops filters, query, view AND dueOn together —
    // the old two-call clear read a stale snapshot and could re-add ?view=.
    commit({ filters: {}, query: "", view: null, dueOn: null }, { push: true });
  }

  function clearDueOn() {
    commit({ dueOn: null });
  }

  function setShowArchived(archived: boolean) {
    commit({ archived }, { push: true });
  }

  const hasFilters = !isEmptyFilters(filters) || !!query || !!dueOn;
  const isWorkspaceEmpty = !showArchived && !!wsCount && wsCount._count.issues === 0 && !hasFilters;

  // The query object we pass down. `query` is kept separate from the
  // saved-view filter blob (it's not persisted with views by default to
  // avoid stale string searches in saved tabs).
  const issueQueryFilters: SavedViewFilters = useMemo(
    () => ({ ...filters, query: debouncedQuery || undefined }),
    [filters, debouncedQuery],
  );

  // Honest header count. Tracks what the current view actually shows
  // instead of a raw workspace total (which over-counts soft-deleted +
  // done + snoozed). The board includes done; the list applies the same
  // effective includeDone as IssueList. Shares `issue.count`, so it can't
  // drift from the list's own where-clause.
  const { data: statuses } = trpc.status.list.useQuery();
  const doneIds = useMemo(() => doneStatusIds(statuses ?? []), [statuses]);
  const countIncludeDone =
    showArchived || view === "board" ? true : resolveIncludeDone(issueQueryFilters, false, doneIds);
  const { data: countData } = trpc.issue.count.useQuery({
    ...issueQueryFilters,
    includeDone: countIncludeDone,
    dueOn: dueOn ?? undefined,
    archived: showArchived,
  });

  const activeView = activeViewId && views ? views.find((v) => v.id === activeViewId) : null;

  return (
    <DensityProvider>
      <Topbar
        title={showArchived ? "Archived issues" : "All issues"}
        subtitle={
          countData
            ? `${countData.count} ${hasFilters ? "matching" : showArchived ? "archived" : "issues"}`
            : !showArchived && wsCount
              ? `${wsCount._count.issues} issues`
              : undefined
        }
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            {/* Search applies to both list and board (the query is folded
                into the shared filter blob). Density only affects list rows,
                so it stays list-only — otherwise a board could be silently
                filtered by a search term with no visible input to clear. */}
            {!isWorkspaceEmpty && (
              <div className="relative">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search…"
                  className="h-8 w-[min(44vw,12rem)] pr-7 text-xs sm:h-7 sm:w-48"
                />
                {searchPending && (
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                    <Spinner size="sm" />
                  </span>
                )}
              </div>
            )}
            {(showArchived || view === "list") && !isWorkspaceEmpty && <DensityToggle />}
            {!showArchived && !isWorkspaceEmpty && <ViewToggle value={view} onChange={setView} />}
            <Button
              variant={showArchived ? "outline" : "ghost"}
              size="sm"
              onClick={() => setShowArchived(!showArchived)}
              title={showArchived ? "Return to active issues" : "View archived issues"}
            >
              {showArchived ? (
                <ArchiveRestore className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Archive className="h-3.5 w-3.5" aria-hidden />
              )}
              {showArchived ? "Active" : "Archive"}
            </Button>
          </div>
        }
      />

      {!isWorkspaceEmpty && (
        <div className="space-y-2 border-b border-border bg-card/20 px-3 py-2.5 sm:px-5">
          {/* Quick filters — non-saved built-ins. */}
          <QuickFilterChips filters={filters} onChange={onChangeFilters} meId={me?.id} />

          {/* Saved views — user-defined, persisted, reorderable. */}
          <SavedViewsBar
            currentFilters={filters}
            activeViewId={activeViewId}
            onApply={applyView}
            onCreate={() => setSaveOpen(true)}
          />

          {/* Facet chips (multi-select, projected onto saved-view array
              fields) + Sprint/Initiative (single-pick). Sort — and Group,
              list view only — are pinned right. */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <IssueFacetChips filters={filters} onChange={onChangeFilters} />
            <ProjectFilterChip value={projectId} onChange={setProjectId} />
            <CycleFilterChip value={cycleId} onChange={setCycleId} />
            <InitiativeFilterChip value={initiativeId} onChange={setInitiativeId} />
            {dueOn && <DueOnChip dueOn={dueOn} onClear={clearDueOn} />}
            {hasFilters && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="text-meta text-muted-foreground hover:text-foreground"
              >
                Clear filters
              </button>
            )}
            <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
              {view === "list" && <GroupChip value={groupBy} onChange={setGroupBy} />}
              <SortChip value={sort} onChange={setSort} />
            </div>
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
        ) : showArchived || view === "list" ? (
          <div className="h-full overflow-y-auto">
            <IssueList
              workspaceKey={key}
              extraFilters={issueQueryFilters}
              sort={sort}
              groupBy={groupBy}
              dueOn={dueOn ?? undefined}
              archived={showArchived}
              emptyOverride={
                showArchived && !hasFilters ? (
                  <ArchivedEmptyState onReturn={() => setShowArchived(false)} />
                ) : hasFilters ? (
                  <FilteredEmptyState
                    activeViewName={activeView?.name ?? null}
                    onClear={clearAllFilters}
                  />
                ) : undefined
              }
            />
          </div>
        ) : (
          <IssueBoard
            workspaceKey={key}
            extraFilters={issueQueryFilters}
            sort={sort}
            dueOn={dueOn ?? undefined}
            emptyOverride={
              hasFilters ? (
                <FilteredEmptyState
                  activeViewName={activeView?.name ?? null}
                  onClear={clearAllFilters}
                />
              ) : undefined
            }
          />
        )}
      </div>

      <SaveViewDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        filters={filters}
        onCreated={(id) => applyView(id, filters)}
      />
    </DensityProvider>
  );
}

function ArchivedEmptyState({ onReturn }: { onReturn: () => void }) {
  return (
    <div className="flex h-60 items-center justify-center">
      <EmptyState
        variant="section"
        icon={<Archive />}
        title="Archive is empty"
        description="Archived issues stay here until you restore them."
        action={
          <Button variant="outline" size="sm" onClick={onReturn}>
            Back to active issues
          </Button>
        }
      />
    </div>
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
                The view <span className="font-medium text-foreground">{activeViewName}</span> has
                no matches right now.{" "}
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
function DueOnChip({ dueOn, onClear }: { dueOn: string; onClear: () => void }) {
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
    <span className="text-meta inline-flex items-center gap-1 rounded-md border border-ember/40 bg-ember/10 px-2 py-0.5 text-ember">
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
 * True when `s` is a real `YYYY-MM-DD` calendar date. Mirrors the server's
 * `dueOn` refine — shape regex plus a round-trip check so `2026-13-45`
 * (which `Date.UTC` would silently roll to 2027-02-14) is rejected.
 */
/** Parse a JSON string, falling back to `{}` so a hand-edited `?f=` never throws. */
function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function isRealDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * localStorage-backed string preference, validated against an allow-list
 * so a hand-edited / stale value can't poison the query. Mirrors
 * `useViewPref` but generic over the value union (used for sort + group).
 */
function useStoredPref<T extends string>(key: string, fallback: T, allowed: readonly T[]) {
  const [val, setVal] = useState<T>(fallback);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored && (allowed as readonly string[]).includes(stored)) {
        setVal(stored as T);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const update = (v: T) => {
    setVal(v);
    try {
      window.localStorage.setItem(key, v);
    } catch {}
  };
  return [val, update] as const;
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
