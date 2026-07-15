"use client";

import Link from "next/link";
import { AlertTriangle, GitBranch, GitPullRequest } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";

const LABEL: Record<string, string> = {
  CLAIMED: "claimed",
  IN_PROGRESS: "working",
  PR_OPEN: "PR open",
  IN_REVIEW: "review",
  READY_TO_MERGE: "ready",
  MERGED: "merged",
  RELEASED: "released",
  DEPLOYED: "deployed",
  STALE: "stale",
};

export function DeliveryWorkTile() {
  const { data, isLoading } = trpc.workSession.active.useQuery(undefined, {
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  if (isLoading)
    return <div className="h-28 animate-pulse rounded-lg border border-border bg-card/40" />;
  if (!data?.length) return null;

  return (
    <section className="rounded-lg border border-border bg-card/40">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
        <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="text-xs font-semibold">Delivery work</h2>
        <span className="ml-auto rounded-full bg-subtle px-1.5 py-px text-[0.625rem] tabular-nums text-muted-foreground">
          {data.length}
        </span>
      </div>
      <div className="divide-y divide-border/60">
        {data.slice(0, 6).map((session) => {
          const owner =
            session.ownerAgent?.name ??
            session.ownerUser?.name ??
            session.ownerUser?.email ??
            "Unassigned";
          return (
            <Link
              key={session.id}
              href={`/w/${session.issue.workspace.slug}/issues/${session.issue.id}`}
              className="focus-ring flex min-w-0 items-center gap-2.5 px-3 py-2.5 hover:bg-subtle/50"
            >
              {session.status === "STALE" ? (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
              ) : session.pullRequest ? (
                <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-ember" />
              ) : (
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5 text-xs">
                  <span className="shrink-0 font-mono text-muted-foreground">
                    {session.issue.workspace.key}-{session.issue.number}
                  </span>
                  <span className="truncate font-medium">{session.issue.title}</span>
                </div>
                <div className="text-meta mt-0.5 flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <span className="truncate">{owner}</span>
                  <span>·</span>
                  <span className="truncate font-mono">{session.branch}</span>
                  <span>·</span>
                  <span>{relativeTime(session.lastHeartbeatAt)}</span>
                </div>
              </div>
              <span
                className={cn(
                  "shrink-0 text-[0.6875rem]",
                  session.status === "STALE"
                    ? "text-warning"
                    : session.status === "READY_TO_MERGE" ||
                        session.status === "MERGED" ||
                        session.status === "RELEASED" ||
                        session.status === "DEPLOYED"
                      ? "text-success"
                      : "text-muted-foreground",
                )}
              >
                {LABEL[session.status] ?? session.status.toLowerCase()}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
