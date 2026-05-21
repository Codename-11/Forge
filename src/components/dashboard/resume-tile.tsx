"use client";
import { History } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { RecentItemsRail } from "@/components/palette/recent-items-rail";

/**
 * "Pick up where you left off" — surfaces the user's most-recently
 * visited entities (issues / projects / initiatives / cycles / agents /
 * saved views) from the per-user `RecentItem` log. Distinct from the
 * dashboard's "Recent issues" column, which is workspace-wide recency;
 * this is *your* trail. Renders nothing until there's something to
 * resume, so a fresh account doesn't show an empty card.
 */
export function ResumeTile({ slug }: { slug: string }) {
  const { data, isLoading } = trpc.recentItem.list.useQuery({ limit: 8 });

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card/40 p-4">
        <div className="h-10 animate-pulse rounded bg-subtle/40" />
      </div>
    );
  }

  const items = data ?? [];
  if (items.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card/40 p-4">
      <header className="mb-2.5 flex items-center gap-2">
        <History className="h-3.5 w-3.5 text-ember" aria-hidden />
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Pick up where you left off
        </span>
      </header>
      <RecentItemsRail items={items} workspaceSlug={slug} limit={8} />
    </div>
  );
}
