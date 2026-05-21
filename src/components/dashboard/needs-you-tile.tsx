"use client";
import Link from "next/link";
import { ArrowRight, Inbox, Shield, Zap } from "lucide-react";
import { trpc } from "@/lib/trpc";

/**
 * "Needs you" — the dashboard's nudge toward decisions waiting on the
 * operator: open action requests (incl. unassigned plan-approval asks)
 * and pending review gates. Links to the Command Center where they're
 * acted on. Renders nothing when the queue is empty, so it only ever
 * appears as a real prompt (no "all clear" clutter).
 */
export function NeedsYouTile({ slug }: { slug: string }) {
  const { data } = trpc.commandCenter.decisionsCount.useQuery(undefined, {
    refetchOnWindowFocus: true,
    staleTime: 60_000,
  });

  if (!data || data.total === 0) return null;

  return (
    <Link
      href={`/w/${slug}/command-center`}
      className="group flex items-center gap-3 rounded-lg border border-ember/30 bg-ember/5 p-4 transition hover:border-ember/50 hover:bg-ember/10"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ember/15 text-ember">
        <Zap className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          {data.total} {data.total === 1 ? "thing needs" : "things need"} your decision
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-meta text-muted-foreground">
          {data.actionRequests > 0 ? (
            <span className="flex items-center gap-1">
              <Inbox className="h-3 w-3" />
              {data.actionRequests} ask{data.actionRequests === 1 ? "" : "s"}
            </span>
          ) : null}
          {data.reviewGates > 0 ? (
            <span className="flex items-center gap-1">
              <Shield className="h-3 w-3" />
              {data.reviewGates} review gate{data.reviewGates === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-ember opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  );
}
