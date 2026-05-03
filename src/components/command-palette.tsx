"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  Plus,
  ArrowRight,
  CircleDot,
  FolderKanban,
  Target,
  CalendarRange,
  Bot,
  Settings,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import {
  EntitySearchResult,
  type EntitySearchResultData,
} from "@/components/palette/entity-search-result";
import { RecentItemsRail } from "@/components/palette/recent-items-rail";
import { useHotkey } from "@/lib/keyboard";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

/**
 * Phase 1C — Command palette modal. Opens on Cmd/Ctrl+K from anywhere
 * inside the workspace shell. Three states:
 *
 *   1. Empty input — render Pinned + Recent rails, then a small Actions
 *      list. The rails reuse `<RecentItemsRail />`. Pinned uses
 *      `pin.listAll({ workspaceId: null })` (cross-workspace strip
 *      semantic — matches the legacy `<PinsStrip />`).
 *
 *   2. Non-empty input — debounce 150ms, hit `commandPalette.search`
 *      with `workspaceId: currentWorkspaceId`, render type-grouped
 *      sections via `<EntitySearchResult />`. The query also filters
 *      a static action list (e.g. "Create issue '{q}'").
 *
 *   3. No matches — show "Create issue '{q}'" affordance that calls
 *      `issue.create` and navigates to the new issue.
 *
 * Keyboard nav (↑/↓/Enter) walks all visible rows. Esc closes.
 *
 * The `data-command-palette` global click trigger (existing pattern)
 * is preserved so the topbar/sidebar buttons keep working.
 */

type StaticAction = {
  id: string;
  label: string;
  hint?: string;
  Icon: React.ComponentType<{ className?: string }>;
  run: () => void;
};

type FlatRow =
  | { kind: "entity"; key: string; data: EntitySearchResultData; run: () => void; workspaceLabel?: string }
  | { kind: "action"; key: string; action: StaticAction }
  | { kind: "create"; key: string; run: () => void; query: string };

const SEARCH_DEBOUNCE_MS = 150;

export function CommandPalette() {
  const router = useRouter();
  const ws = useMaybeWorkspace();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Cmd/Ctrl+K toggles. The hook respects input focus, but treats
  // cmd/ctrl combos as always-active (which is what we want — palette
  // open/close from inside any input).
  useHotkey("cmd+k", () => setOpen((x) => !x));

  // Legacy hook: any element with `data-command-palette` opens us.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("[data-command-palette]")) setOpen(true);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  // Reset state on close. Autofocus on open is handled by the input's
  // `autoFocus` prop + Dialog mounting it fresh.
  useEffect(() => {
    if (!open) {
      setRawQuery("");
      setDebouncedQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  // Debounce search query. 150ms feels snappy without blasting the
  // server on every keystroke.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setDebouncedQuery(rawQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [rawQuery, open]);

  const wsPath = (p: string) => (ws ? `/w/${ws.slug}${p}` : p);

  // ----------------------------------------------------------------- Queries
  const searchQ = trpc.commandPalette.search.useQuery(
    { query: debouncedQuery, workspaceId: ws?.id, limit: 6 },
    {
      enabled: open && debouncedQuery.length > 0,
      staleTime: 30_000,
    },
  );

  // Recents are workspace-scoped; the rail comes alive only when
  // we have a workspace (we always do inside the shell, but the
  // hook is still gated on `enabled`).
  const recentsQ = trpc.recentItem.list.useQuery(
    { limit: 6 },
    { enabled: open && !!ws, staleTime: 30_000 },
  );

  // Pins — cross-workspace strip semantic (`workspaceId: null`).
  // Matches `<PinsStrip />`. Kept simple per the brief; switching to
  // current-ws-scoped is a one-line change.
  const pinsQ = trpc.pin.listAll.useQuery(
    { workspaceId: null },
    { enabled: open, staleTime: 30_000 },
  );

  // ---------------------------------------------------------- Static actions
  const staticActions: StaticAction[] = useMemo(() => {
    const wsScoped: StaticAction[] = ws
      ? [
          {
            id: "act:new-issue",
            label: "Create new issue",
            hint: "Shift+C",
            Icon: Plus,
            run: () => {
              setOpen(false);
              // Trigger the existing QuickCreate via its data-attribute hook.
              // Synthesizes a click on a hidden button so the overlay opens.
              const synthetic = document.createElement("button");
              synthetic.setAttribute("data-quick-create", "");
              synthetic.style.display = "none";
              document.body.appendChild(synthetic);
              synthetic.click();
              synthetic.remove();
            },
          },
          {
            id: "act:go-issues",
            label: "Go to Issues",
            Icon: CircleDot,
            run: () => router.push(wsPath("/issues")),
          },
          {
            id: "act:go-projects",
            label: "Go to Projects",
            Icon: FolderKanban,
            run: () => router.push(wsPath("/projects")),
          },
          {
            id: "act:go-initiatives",
            label: "Go to Initiatives",
            Icon: Target,
            run: () => router.push(wsPath("/initiatives")),
          },
          {
            id: "act:go-cycles",
            label: "Go to Sprints",
            Icon: CalendarRange,
            run: () => router.push(wsPath("/cycles")),
          },
          {
            id: "act:go-agents",
            label: "Go to Agents",
            Icon: Bot,
            run: () => router.push(wsPath("/agents")),
          },
          {
            id: "act:go-settings",
            label: "Open settings",
            Icon: Settings,
            run: () => router.push(wsPath("/settings")),
          },
        ]
      : [];
    return wsScoped;
    // wsPath closes over ws.slug; including ws.slug captures it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.slug, router]);

  // ---------------------------------------------------- "Create issue" mut
  const createIssueM = trpc.issue.create.useMutation({
    onSuccess: (issue) => {
      toast.success(`Created ${issue.id.slice(0, 8)}.`);
      utils.issue.list.invalidate();
      setOpen(false);
      if (ws) router.push(`/w/${ws.slug}/issues/${issue.id}`);
    },
    onError: (e) => toast.error(e.message),
  });

  // -------------------------------------------------------- Row construction
  const queryActive = debouncedQuery.length > 0;

  // Helper: per-entity Enter handler. Closes the palette and pushes to
  // the right route based on the result's discriminator.
  const navigateToEntity = (data: EntitySearchResultData, workspaceSlug: string) => {
    setOpen(false);
    switch (data.kind) {
      case "issue":
        router.push(`/w/${workspaceSlug}/issues/${data.id}`);
        return;
      case "project":
        router.push(`/w/${workspaceSlug}/projects/${data.id}`);
        return;
      case "initiative":
        router.push(`/w/${workspaceSlug}/initiatives/${data.slug}`);
        return;
      case "savedView":
        router.push(`/w/${workspaceSlug}/issues?view=${data.id}`);
        return;
      case "cycle":
        router.push(`/w/${workspaceSlug}/cycles/${data.id}`);
        return;
      case "agent":
        router.push(`/w/${workspaceSlug}/agents/${data.profileKey}`);
        return;
    }
  };

  // Helper for pin/recent rail clicks — both rails share dispatch logic.
  // The rail's `onSelect` hands us the full HydratedPin; we route on
  // `target.targetType` and use the target's own workspace slug when
  // present (so cross-workspace pins still navigate to the right tenant).
  const dispatchPin = (
    p: { target: { targetType: string; id: string; slug?: string; profileKey?: string; workspaceSlug?: string } | null },
    fallbackSlug: string,
  ) => {
    setOpen(false);
    const t = p.target;
    if (!t) return;
    const slug = t.workspaceSlug ?? fallbackSlug;
    switch (t.targetType) {
      case "ISSUE":
        router.push(`/w/${slug}/issues/${t.id}`);
        return;
      case "PROJECT":
        router.push(`/w/${slug}/projects/${t.id}`);
        return;
      case "INITIATIVE":
        router.push(`/w/${slug}/initiatives/${t.slug}`);
        return;
      case "SAVED_VIEW":
        router.push(`/w/${slug}/issues?view=${t.id}`);
        return;
      case "CYCLE":
        router.push(`/w/${slug}/cycles/${t.id}`);
        return;
      case "AGENT":
        router.push(`/w/${slug}/agents/${t.profileKey}`);
        return;
    }
  };

  // Build the type-grouped sections from the search result. Each row
  // carries everything `<EntitySearchResult />` needs plus a `run`
  // closure for keyboard nav. Sections are filtered out client-side
  // when their bucket is empty.
  const sections: Array<{
    title: string;
    rows: FlatRow[];
  }> = useMemo(() => {
    if (!queryActive) return [];
    const res = searchQ.data;
    if (!res) return [];

    const out: Array<{ title: string; rows: FlatRow[] }> = [];

    if (res.issues.length > 0) {
      out.push({
        title: "Issues",
        rows: res.issues.map((i): FlatRow => {
          const data: EntitySearchResultData = {
            kind: "issue",
            id: i.id,
            key: i.key,
            title: i.title,
            statusName: i.statusName,
            statusColor: i.statusColor,
            projectKey: i.projectKey,
          };
          return {
            kind: "entity",
            key: `issue:${i.id}`,
            data,
            workspaceLabel: ws && i.workspaceId !== ws.id ? i.workspaceSlug : undefined,
            run: () => navigateToEntity(data, i.workspaceSlug),
          };
        }),
      });
    }
    if (res.projects.length > 0) {
      out.push({
        title: "Projects",
        rows: res.projects.map((p): FlatRow => {
          const data: EntitySearchResultData = {
            kind: "project",
            id: p.id,
            key: p.key,
            name: p.name,
            color: p.color,
            icon: p.icon,
          };
          return {
            kind: "entity",
            key: `project:${p.id}`,
            data,
            workspaceLabel: ws && p.workspaceId !== ws.id ? p.workspaceSlug : undefined,
            run: () => navigateToEntity(data, p.workspaceSlug),
          };
        }),
      });
    }
    if (res.initiatives.length > 0) {
      out.push({
        title: "Initiatives",
        rows: res.initiatives.map((iv): FlatRow => {
          const data: EntitySearchResultData = {
            kind: "initiative",
            id: iv.id,
            slug: iv.slug,
            name: iv.name,
            color: iv.color,
            status: iv.status,
          };
          return {
            kind: "entity",
            key: `initiative:${iv.id}`,
            data,
            workspaceLabel: ws && iv.workspaceId !== ws.id ? iv.workspaceSlug : undefined,
            run: () => navigateToEntity(data, iv.workspaceSlug),
          };
        }),
      });
    }
    if (res.savedViews.length > 0) {
      out.push({
        title: "Saved Views",
        rows: res.savedViews.map((v): FlatRow => {
          const data: EntitySearchResultData = {
            kind: "savedView",
            id: v.id,
            name: v.name,
          };
          return {
            kind: "entity",
            key: `savedView:${v.id}`,
            data,
            workspaceLabel: ws && v.workspaceId !== ws.id ? v.workspaceSlug : undefined,
            run: () => navigateToEntity(data, v.workspaceSlug),
          };
        }),
      });
    }
    if (res.cycles.length > 0) {
      out.push({
        title: "Sprints",
        rows: res.cycles.map((c): FlatRow => {
          const data: EntitySearchResultData = {
            kind: "cycle",
            id: c.id,
            name: c.name,
            status: c.status,
          };
          return {
            kind: "entity",
            key: `cycle:${c.id}`,
            data,
            workspaceLabel: ws && c.workspaceId !== ws.id ? c.workspaceSlug : undefined,
            run: () => navigateToEntity(data, c.workspaceSlug),
          };
        }),
      });
    }
    if (res.agents.length > 0) {
      out.push({
        title: "Agents",
        rows: res.agents.map((a): FlatRow => {
          const data: EntitySearchResultData = {
            kind: "agent",
            id: a.id,
            profileKey: a.profileKey,
            displayName: a.displayName,
            status: a.status,
          };
          return {
            kind: "entity",
            key: `agent:${a.id}`,
            data,
            workspaceLabel: ws && a.workspaceId !== ws.id ? a.workspaceSlug : undefined,
            run: () => navigateToEntity(data, a.workspaceSlug),
          };
        }),
      });
    }

    // Filtered actions matching the query.
    const q = debouncedQuery.toLowerCase();
    const matchingActions = staticActions.filter((a) =>
      a.label.toLowerCase().includes(q),
    );
    if (matchingActions.length > 0) {
      out.push({
        title: "Actions",
        rows: matchingActions.map(
          (a): FlatRow => ({ kind: "action", key: a.id, action: a }),
        ),
      });
    }

    return out;
    // ws.id closes over the workspace narrowing; intentionally re-runs
    // when the search payload or workspace changes. eslint isn't smart
    // enough to read into navigateToEntity's free vars.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQ.data, queryActive, debouncedQuery, ws?.id, staticActions, router]);

  // Empty-state sections (no query) — recents + pins + actions
  const emptySections: Array<{
    title: string;
    rows: FlatRow[];
    rail?: React.ReactNode;
  }> = useMemo(() => {
    if (queryActive) return [];
    const out: Array<{ title: string; rows: FlatRow[]; rail?: React.ReactNode }> = [];

    // Pin rail — chips are click-only (not part of arrow-nav cursor).
    // Same dispatch path as Recents; the rail is what the user sees.
    const pins = pinsQ.data ?? [];
    if (pins.length > 0 && ws) {
      out.push({
        title: "Pinned",
        rows: [],
        rail: (
          <RecentItemsRail
            items={pins}
            workspaceSlug={ws.slug}
            limit={6}
            onSelect={(p) => dispatchPin(p, ws.slug)}
          />
        ),
      });
    }

    const recents = recentsQ.data ?? [];
    if (recents.length > 0 && ws) {
      out.push({
        title: "Recent",
        rows: [],
        rail: (
          <RecentItemsRail
            items={recents}
            workspaceSlug={ws.slug}
            limit={6}
            onSelect={(p) => dispatchPin(p, ws.slug)}
          />
        ),
      });
    }

    if (staticActions.length > 0) {
      out.push({
        title: "Actions",
        rows: staticActions.map(
          (a): FlatRow => ({ kind: "action", key: a.id, action: a }),
        ),
      });
    }

    return out;
    // dispatchPin is recreated each render but only closes over `router`,
    // which is already in deps. eslint can't see through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryActive, pinsQ.data, recentsQ.data, staticActions, router, ws]);

  // Flatten visible navigable rows for keyboard navigation. Rails are
  // rendered for visual continuity but their chips aren't part of the
  // arrow-nav cursor (that would conflict with the action list immediately
  // below). Pins-rail chips are clickable; the arrow nav addresses the
  // entity-row + action-row list only.
  const navigableRows: FlatRow[] = useMemo(() => {
    if (queryActive) {
      const all: FlatRow[] = [];
      // Empty buckets case — surface the create-issue affordance as the
      // sole navigable row.
      const total = sections.reduce((n, s) => n + s.rows.length, 0);
      if (total === 0 && debouncedQuery.length > 0 && ws) {
        all.push({
          kind: "create",
          key: `create:${debouncedQuery}`,
          run: () => {
            createIssueM.mutate({ title: debouncedQuery });
          },
          query: debouncedQuery,
        });
        return all;
      }
      for (const s of sections) for (const r of s.rows) all.push(r);
      return all;
    }
    // Empty-state — only the actions rows are arrow-navigable.
    const all: FlatRow[] = [];
    for (const s of emptySections) for (const r of s.rows) all.push(r);
    return all;
  }, [queryActive, sections, emptySections, debouncedQuery, ws, createIssueM]);

  // Clamp active index when rows change.
  useEffect(() => {
    if (activeIndex >= navigableRows.length) {
      setActiveIndex(Math.max(0, navigableRows.length - 1));
    }
  }, [navigableRows.length, activeIndex]);

  const runRow = (r: FlatRow) => {
    if (r.kind === "entity") r.run();
    else if (r.kind === "action") r.action.run();
    else if (r.kind === "create") r.run();
  };

  // Search loading state — only when query non-empty + payload pending.
  const showSpinner = queryActive && (searchQ.isFetching || debouncedQuery !== rawQuery.trim());

  // Empty-state message: query non-empty + zero rows across ALL buckets.
  const totalSearchRows = sections.reduce((n, s) => n + s.rows.length, 0);
  const showNoMatches = queryActive && !searchQ.isLoading && totalSearchRows === 0;

  return (
    <Dialog open={open} onClose={() => setOpen(false)} className="max-w-2xl">
      {/* Search input */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          autoFocus
          value={rawQuery}
          onChange={(e) => {
            setRawQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIndex((x) => Math.min(navigableRows.length - 1, x + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((x) => Math.max(0, x - 1));
            } else if (e.key === "Enter") {
              const row = navigableRows[activeIndex];
              if (row) {
                e.preventDefault();
                runRow(row);
              }
            }
          }}
          placeholder="Search issues, projects, initiatives, agents… or type a command"
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {showSpinner && <Spinner size="sm" />}
      </div>

      {/* Body */}
      <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1.5">
        {queryActive ? (
          <>
            {sections.map((section) => (
              <Section key={section.title} title={section.title}>
                {section.rows.map((row) => {
                  const idx = navigableRows.findIndex((r) => r.key === row.key);
                  const selected = idx === activeIndex;
                  if (row.kind === "entity") {
                    return (
                      <div key={row.key} className="px-1.5">
                        <EntitySearchResult
                          result={row.data}
                          selected={selected}
                          onSelect={() => runRow(row)}
                          kbdHint={selected ? "↵" : undefined}
                        />
                        {row.workspaceLabel && (
                          <span className="ml-9 -mt-0.5 inline-block rounded border border-border/60 bg-card/40 px-1 py-px font-mono text-[0.625rem] text-muted-foreground">
                            {row.workspaceLabel}
                          </span>
                        )}
                      </div>
                    );
                  }
                  if (row.kind === "action") {
                    return (
                      <ActionRow
                        key={row.key}
                        action={row.action}
                        selected={selected}
                        onSelect={() => runRow(row)}
                      />
                    );
                  }
                  return null;
                })}
              </Section>
            ))}
            {showNoMatches && ws && (
              <div className="px-3 py-6 text-center">
                <div className="text-meta text-muted-foreground">No matches.</div>
                {(() => {
                  const createRow = navigableRows.find((r) => r.kind === "create");
                  if (!createRow || createRow.kind !== "create") return null;
                  const idx = navigableRows.indexOf(createRow);
                  const selected = idx === activeIndex;
                  return (
                    <button
                      type="button"
                      onClick={() => runRow(createRow)}
                      onMouseDown={(e) => e.preventDefault()}
                      disabled={createIssueM.isPending}
                      className={cn(
                        "focus-ring mt-3 inline-flex items-center gap-1.5 rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-xs",
                        selected
                          ? "border-ember/60 bg-card/80 text-foreground"
                          : "text-foreground/90 hover:border-ember/40 hover:bg-card",
                      )}
                    >
                      <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>
                        Create issue{" "}
                        <span className="font-medium">&ldquo;{createRow.query}&rdquo;</span>
                      </span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    </button>
                  );
                })()}
              </div>
            )}
          </>
        ) : (
          <>
            {emptySections.map((section) => (
              <Section key={section.title} title={section.title}>
                {section.rail && <div className="px-3 py-1">{section.rail}</div>}
                {section.rows.map((row) => {
                  const idx = navigableRows.findIndex((r) => r.key === row.key);
                  const selected = idx === activeIndex;
                  if (row.kind === "action") {
                    return (
                      <ActionRow
                        key={row.key}
                        action={row.action}
                        selected={selected}
                        onSelect={() => runRow(row)}
                      />
                    );
                  }
                  return null;
                })}
              </Section>
            ))}
            {emptySections.length === 0 && (
              <div className="px-3 py-8 text-center text-meta text-muted-foreground">
                Start typing to search.
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer hint bar */}
      <div className="flex items-center gap-3 border-t border-border bg-card/40 px-3 py-1.5 text-[0.625rem] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <span>navigate</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>↵</Kbd>
          <span>open</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Esc</Kbd>
          <span>close</span>
        </span>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Section + ActionRow
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <div className="px-3 py-1 text-[0.625rem] uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}

function ActionRow({
  action,
  selected,
  onSelect,
}: {
  action: StaticAction;
  selected: boolean;
  onSelect: () => void;
}) {
  const { Icon } = action;
  return (
    <div className="px-1.5">
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={onSelect}
        onMouseDown={(e) => e.preventDefault()}
        className={cn(
          "focus-ring flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left",
          selected ? "bg-card/60 text-foreground" : "text-foreground/90 hover:bg-subtle",
        )}
      >
        <span className="grid h-5 w-5 shrink-0 place-items-center text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 truncate text-xs">{action.label}</span>
        {action.hint && (
          <span className="ml-auto rounded border border-border/60 bg-card/40 px-1 font-mono text-[0.625rem] text-muted-foreground">
            {action.hint}
          </span>
        )}
        {selected && !action.hint && (
          <span className="ml-auto rounded border border-border/60 bg-card/40 px-1 font-mono text-[0.625rem] text-muted-foreground">
            ↵
          </span>
        )}
      </button>
    </div>
  );
}

