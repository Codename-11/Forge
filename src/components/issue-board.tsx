"use client";
import Link from "next/link";
import { Plus } from "lucide-react";
import { StatusCategory } from "@prisma/client";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { StatusDot } from "@/components/ui/status-dot";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { presenceAvailability } from "@/lib/transport-display";
import { AgentHoverPreview } from "@/components/agent-hover-preview";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import type { IssueSort, SavedViewFilters } from "@/lib/saved-view-filters";

/**
 * Status-column kanban board. Drag-and-drop is intentionally left as a
 * future enhancement — the keyboard-first path (bulk-select + status set)
 * already covers the primary workflow.
 *
 * Each column owns its own cursor-paginated query (scoped to that status),
 * rather than the board sharing one capped page bucketed client-side. A
 * shared page is wrong for a board: ordered globally by priority, the
 * budget gets eaten by high-priority rows and low-priority columns
 * (Backlog/Done) come up empty or undercounted. Per-column queries give
 * every column its own honest, paginated set.
 */
export function IssueBoard({
  workspaceKey,
  projectId,
  assigneeId,
  cycleId,
  initiativeId,
  extraFilters,
  includeDone = true,
  sort,
  dueOn,
  emptyOverride,
}: {
  workspaceKey: string;
  projectId?: string;
  assigneeId?: string;
  /** Tri-state: `undefined` = any; `null` = backlog; string = specific id. */
  cycleId?: string | null;
  /** Tri-state: `undefined` = any; `null` = no initiative; string = id. */
  initiativeId?: string | null;
  /** Phase 1D saved-view projection. Spread into each column's `issue.list`. */
  extraFilters?: SavedViewFilters;
  /** Whether terminal workflow columns and rows are eligible to appear. */
  includeDone?: boolean;
  /** Within-column ordering. Forwarded to each column's query. */
  sort?: IssueSort;
  /** Single-day due-date filter (UTC `YYYY-MM-DD`), same as the list view. */
  dueOn?: string;
  /**
   * Shown in place of the columns when the active filters match nothing
   * (parity with the list view's filtered-empty state).
   */
  emptyOverride?: React.ReactNode;
}) {
  const { data: statuses } = trpc.status.list.useQuery();
  const ws = useMaybeWorkspace();
  const base = ws ? `/w/${ws.slug}` : "";

  // Total matching count across all columns — drives the filtered-empty
  // state. The parent supplies the lifecycle baseline so switching between
  // list and board never changes the result universe.
  const countFilter = {
    projectId,
    assigneeId,
    cycleId,
    initiativeId,
    dueOn,
    ...(extraFilters ?? {}),
    includeDone,
  };
  const { data: countData } = trpc.issue.count.useQuery(countFilter);

  if (!statuses) return null;

  // Column visibility honours an explicit status filter: a status facet
  // (`statusIds`) or category filter narrows which columns render at all.
  const statusIdFilter = extraFilters?.statusIds;
  const statusCatFilter = extraFilters?.statusCategories;
  const visibleStatuses = statuses.filter((s) => {
    if (
      !includeDone &&
      (s.category === StatusCategory.DONE || s.category === StatusCategory.CANCELED)
    ) {
      return false;
    }
    if (statusIdFilter?.length && !statusIdFilter.includes(s.id)) return false;
    if (statusCatFilter?.length && !statusCatFilter.includes(s.category)) return false;
    return true;
  });

  if (countData?.count === 0 && emptyOverride !== undefined) {
    return <>{emptyOverride}</>;
  }

  // Per-column query filter: drop the board-wide status narrowing (the
  // column IS its status) and pin `statusIds: [s.id]`. Leaving
  // `statusCategories` in would OR against the pinned id and broaden the
  // column beyond itself, so strip both here.
  const { statusIds: _s, statusCategories: _c, ...restFilters } = extraFilters ?? {};

  return (
    <div className="flex h-[calc(100svh-8.5rem)] snap-x gap-2 overflow-x-auto px-3 py-3 sm:h-[calc(100svh-6rem)] sm:gap-3 sm:px-4">
      {visibleStatuses.map((s) => (
        <BoardColumn
          key={s.id}
          status={s}
          base={base}
          workspaceKey={workspaceKey}
          projectId={projectId}
          columnFilter={{
            ...restFilters,
            includeDone,
            statusIds: [s.id],
            projectId,
            assigneeId,
            cycleId,
            initiativeId,
            dueOn,
            sort,
            limit: 50,
          }}
        />
      ))}
    </div>
  );
}

function BoardColumn({
  status,
  base,
  workspaceKey,
  projectId,
  columnFilter,
}: {
  status: { id: string; name: string; color: string; category: string };
  base: string;
  workspaceKey: string;
  projectId?: string;
  columnFilter: Parameters<typeof trpc.issue.list.useInfiniteQuery>[0];
}) {
  const { data, hasNextPage, isFetchingNextPage, fetchNextPage } = trpc.issue.list.useInfiniteQuery(
    columnFilter,
    {
      getNextPageParam: (last) => last.nextCursor,
    },
  );
  const items = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section className="flex w-[min(20rem,calc(100vw-2rem))] shrink-0 snap-start flex-col rounded-lg border border-border bg-card/40 sm:w-72">
      <header className="flex h-9 items-center gap-2 border-b border-border px-3">
        <StatusDot status={status} size={12} />
        <span className="text-xs font-medium">{status.name}</span>
        <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">
          {items.length}
          {hasNextPage ? "+" : ""}
        </span>
        {/* Quick-add into this column. The shared capture flow preserves
            both the project scope and this column's status. */}
        <button
          type="button"
          title="New issue"
          aria-label={`New issue in ${status.name}`}
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("forge:quick-create", {
                detail: {
                  statusId: status.id,
                  ...(projectId ? { projectId } : {}),
                },
              }),
            )
          }
          className="focus-ring -mr-1 inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground sm:h-6 sm:w-6"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
        {items.map((i) => (
          <Link
            key={i.id}
            href={`${base}/issues/${i.id}`}
            className="block rounded-md border border-border bg-background p-2 text-left hover:border-ember/40"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-id text-muted-foreground">
                {workspaceKey}-{i.number}
              </span>
              {i.project && (
                <Badge className="ml-auto shrink-0" color={i.project.color ?? undefined}>
                  {i.project.key}
                </Badge>
              )}
            </div>
            <div className="mt-1 break-words text-sm leading-snug">{i.title}</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <div className="flex -space-x-1.5">
                {i.assignees.slice(0, 3).map((a) => (
                  <Avatar
                    key={a.userId}
                    name={a.user.name}
                    image={a.user.image}
                    size={16}
                    className="ring-1 ring-background"
                  />
                ))}
              </div>
              {i.assignedAgent && (
                <AgentHoverPreview agentId={i.assignedAgent.id}>
                  <span
                    className="text-meta inline-flex min-w-0 items-center gap-1 text-muted-foreground"
                    title={`Agent: ${i.assignedAgent.name}`}
                  >
                    <AgentPresenceDot
                      status={i.assignedAgent.status}
                      size="sm"
                      availability={presenceAvailability(i.assignedAgent)}
                    />
                    <span className="text-id truncate">@{i.assignedAgent.profileKey}</span>
                  </span>
                </AgentHoverPreview>
              )}
            </div>
          </Link>
        ))}
        {hasNextPage && (
          <button
            type="button"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="focus-ring text-meta w-full rounded-md border border-border bg-background/40 px-2 py-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </section>
  );
}
