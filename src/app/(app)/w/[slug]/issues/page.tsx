"use client";
import { useState } from "react";
import { Topbar } from "@/components/topbar";
import { IssueList } from "@/components/issue-list";
import { IssueBoard } from "@/components/issue-board";
import { Input } from "@/components/ui/input";
import { ViewToggle, useViewPref } from "@/components/view-toggle";
import { trpc } from "@/lib/trpc";

export default function IssuesPage() {
  const [view, setView] = useViewPref("issues");
  const [query, setQuery] = useState("");
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
      <div className="min-h-0 flex-1 overflow-hidden">
        {view === "list" ? (
          <div className="h-full overflow-y-auto">
            <IssueList workspaceKey={key} query={query || undefined} />
          </div>
        ) : (
          <IssueBoard workspaceKey={key} />
        )}
      </div>
    </>
  );
}
