"use client";
import { useState } from "react";
import { Topbar } from "@/components/topbar";
import { IssueList } from "@/components/issue-list";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type Tab = "assigned" | "created" | "all";

export default function InboxPage() {
  const [tab, setTab] = useState<Tab>("assigned");
  const { data: ws } = trpc.workspace.current.useQuery();
  const { data: me } = trpc.workspace.me.useQuery();

  const tabs: { id: Tab; label: string; hint: string }[] = [
    { id: "assigned", label: "Assigned to me", hint: "Active issues with you in the assignee list." },
    { id: "created", label: "Created by me", hint: "Issues you opened." },
    { id: "all", label: "All active", hint: "Everything open workspace-wide." },
  ];

  return (
    <>
      <Topbar
        title="Inbox"
        subtitle={tabs.find((t) => t.id === tab)?.hint}
        actions={
          <div className="flex items-center gap-1 rounded-md bg-subtle p-0.5 text-[11px]">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "focus-ring rounded px-2 py-1 transition-colors",
                  tab === t.id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!me ? (
          <div className="p-8 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <IssueList
            workspaceKey={ws?.key ?? "—"}
            assigneeId={tab === "assigned" ? me.user.id : undefined}
            authorId={tab === "created" ? me.user.id : undefined}
            includeDone={false}
            emptyHint={
              tab === "assigned"
                ? "Nothing on your plate."
                : tab === "created"
                  ? "You haven't opened any issues yet."
                  : "Nothing active right now."
            }
          />
        )}
      </div>
    </>
  );
}
