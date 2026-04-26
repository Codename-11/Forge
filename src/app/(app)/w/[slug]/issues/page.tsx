"use client";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { IssueList } from "@/components/issue-list";
import { IssueBoard } from "@/components/issue-board";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DensityProvider, EmptyState, Kbd, useDensity, useSetDensity } from "@/components/ui";
import { ViewToggle, useViewPref } from "@/components/view-toggle";
import {
  CycleFilterChip,
  InitiativeFilterChip,
  type CycleFilter,
  type InitiativeFilter,
} from "@/components/saved-views/filter-chips";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export default function IssuesPage() {
  const [view, setView] = useViewPref("issues");
  const [query, setQuery] = useState("");
  const [cycleId, setCycleId] = useState<CycleFilter>(undefined);
  const [initiativeId, setInitiativeId] = useState<InitiativeFilter>(undefined);
  const { data: ws, isLoading: wsLoading } = trpc.workspace.current.useQuery();
  const key = ws?.key ?? "—";

  const noFilters =
    !query && cycleId === undefined && initiativeId === undefined;
  const isWorkspaceEmpty = !!ws && ws._count.issues === 0 && noFilters;

  return (
    <DensityProvider>
      <Topbar
        title="All issues"
        subtitle={ws ? `${ws._count.issues} total` : undefined}
        actions={
          <div className="flex items-center gap-2">
            {view === "list" && !isWorkspaceEmpty && (
              <>
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search…"
                  className="h-7 w-48 text-xs"
                />
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
        <div className="flex items-center gap-2 border-b border-border bg-card/20 px-5 py-2">
          <CycleFilterChip value={cycleId} onChange={setCycleId} />
          <InitiativeFilterChip value={initiativeId} onChange={setInitiativeId} />
          {(cycleId !== undefined || initiativeId !== undefined) && (
            <button
              type="button"
              onClick={() => {
                setCycleId(undefined);
                setInitiativeId(undefined);
              }}
              className="text-[0.6875rem] text-muted-foreground hover:text-foreground"
            >
              Clear filters
            </button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {wsLoading ? null : isWorkspaceEmpty ? (
          <div className="flex h-full items-center justify-center px-6">
            <EmptyState
              variant="page"
              icon={<Sparkles />}
              title="No issues yet"
              description={
                <span>
                  Create your first issue with <Kbd>⇧C</Kbd> or pick a
                  starter template.
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
              query={query || undefined}
              cycleId={cycleId}
              initiativeId={initiativeId}
            />
          </div>
        ) : (
          <IssueBoard
            workspaceKey={key}
            cycleId={cycleId}
            initiativeId={initiativeId}
          />
        )}
      </div>
    </DensityProvider>
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
