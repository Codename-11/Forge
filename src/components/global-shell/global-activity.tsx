"use client";

import { Activity as ActivityIcon } from "lucide-react";
import { Spinner, EmptyState } from "@/components/ui";
import { activityActorName, activityActorOwnerTitle } from "@/lib/activity-actor";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";
import { WsChip } from "./mission-control-home";

/**
 * Global activity feed — recent events across every workspace the user
 * belongs to (the full-page counterpart to the Activity dock). Read-only;
 * each row carries its workspace chip and the acting human/agent.
 */
export function GlobalActivity() {
  const activity = trpc.global.activity.useQuery();
  const rows = activity.data ?? [];

  return (
    <div className="mx-auto w-full max-w-[900px] px-8 py-6">
      {activity.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ActivityIcon />}
          title="No activity yet"
          description="Runs, comments, and decisions across your workspaces appear here as they happen."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card/40">
          {rows.map((e, i) => {
            const actor = activityActorName(e);
            const actorTitle = activityActorOwnerTitle(e);
            const kind = e.kind.split(".").slice(1).join(".") || e.kind;
            return (
              <div
                key={e.id}
                className={`flex items-center gap-3 px-3 py-2.5 ${i > 0 ? "border-t border-border/60" : ""}`}
              >
                <WsChip ws={e.workspace} dense />
                <span className="inline-flex h-4 items-center rounded bg-subtle px-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                  {kind}
                </span>
                <span className="flex-1 truncate text-sm">
                  <span className="text-foreground/90" title={actorTitle}>
                    {actor}
                  </span>{" "}
                  <span className="text-muted-foreground">· {e.subjectType}</span>
                </span>
                <span
                  className="text-meta tabular-nums text-muted-foreground/70"
                  style={{ minWidth: 52, textAlign: "right" }}
                >
                  {relativeTime(e.createdAt)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
