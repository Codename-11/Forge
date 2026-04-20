"use client";
import { useState } from "react";
import { Topbar } from "@/components/topbar";
import { IssueList } from "@/components/issue-list";
import { IssueBoard } from "@/components/issue-board";
import { Input } from "@/components/ui/input";
import { ViewToggle, useViewPref } from "@/components/view-toggle";
import {
  CycleFilterChip,
  InitiativeFilterChip,
  type CycleFilter,
  type InitiativeFilter,
} from "@/components/saved-views/filter-chips";
import { trpc } from "@/lib/trpc";

export default function IssuesPage() {
  const [view, setView] = useViewPref("issues");
  const [query, setQuery] = useState("");
  const [cycleId, setCycleId] = useState<CycleFilter>(undefined);
  const [initiativeId, setInitiativeId] = useState<InitiativeFilter>(undefined);
  const { data: ws } = trpc.workspace.current.useQuery();
  const key = ws?.key ?? "—";

  return (
    <>
      <Topbar
        title="All issues"
        subtitle={ws ? `${ws._count.issues} total` : undefined}
        actions={
          <div className="flex items-center gap-2">
            {view === "list" && (
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                className="h-7 w-48 text-xs"
              />
            )}
            <ViewToggle value={view} onChange={setView} />
          </div>
        }
      />
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
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            Clear filters
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {view === "list" ? (
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
    </>
  );
}
