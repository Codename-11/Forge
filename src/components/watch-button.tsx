"use client";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";

/**
 * Watch / Unwatch toggle for an issue. Subscribes the caller to the
 * issue's event fan-out — comment @-mentions, status transitions, SLA
 * breaches all fire the watcher's webhook (agents) or land in the
 * inbox/notification surface (humans). Distinct from Pin (which is a
 * sidebar UI shortcut) — both can be active simultaneously.
 *
 * Reads `issue.watchers` for current state (cheap — one row per
 * watcher). Optimistic toggle so the eye flips immediately.
 *
 * Renders a small watcher count chip next to the eye when there is at
 * least one OTHER watcher (or any watcher when the caller isn't one).
 * The chip's native `title=` lists names so hovering reveals who.
 */
export function WatchButton({
  issueId,
  className,
}: {
  issueId: string;
  className?: string;
}) {
  const utils = trpc.useUtils();
  // Caller's identity — for "is the caller currently watching?" we
  // can't derive it from the watchers list alone (the caller may be
  // an agent). Use the dedicated `issue.watching` query, scoped to
  // this issue via membership check on the watchers list.
  const watchersQ = trpc.issue.watchers.useQuery(
    { issueId },
    { staleTime: 60_000 },
  );

  // Detect whether the calling user is in the watchers list. This
  // covers the human path. For agents (API key with linkedAgentId),
  // the WatchButton is unlikely to render server-side; the UI is
  // human-first. If we ever surface a per-agent toggle we'll add an
  // agent-aware lookup.
  const meQ = trpc.user.me.useQuery(undefined, { staleTime: 60_000 });
  const myUserId = meQ.data?.id;
  const watchers = watchersQ.data?.items ?? [];
  const isWatching = !!(
    myUserId && watchers.some((w) => w.userId === myUserId)
  );
  const otherCount = isWatching
    ? watchers.length - 1
    : watchers.length;

  const watch = trpc.issue.watch.useMutation({
    onMutate: async () => {
      await utils.issue.watchers.cancel({ issueId });
      const prev = utils.issue.watchers.getData({ issueId });
      // Optimistic: we don't have all the user fields, but flipping
      // the count chip immediately is the visible feedback.
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) utils.issue.watchers.setData({ issueId }, ctx.prev);
      toast.error(err.message);
    },
    onSettled: () => {
      void utils.issue.watchers.invalidate({ issueId });
      void utils.issue.watching.invalidate();
    },
  });
  const unwatch = trpc.issue.unwatch.useMutation({
    onMutate: async () => {
      await utils.issue.watchers.cancel({ issueId });
      const prev = utils.issue.watchers.getData({ issueId });
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) utils.issue.watchers.setData({ issueId }, ctx.prev);
      toast.error(err.message);
    },
    onSettled: () => {
      void utils.issue.watchers.invalidate({ issueId });
      void utils.issue.watching.invalidate();
    },
  });

  const busy = watch.isPending || unwatch.isPending;
  const label = isWatching ? "Stop watching" : "Watch issue";
  const titleText = isWatching
    ? "Watching — click to stop receiving updates"
    : "Watch — get notified on comments, status changes, SLA breaches";

  // Tooltip enrichment: list watcher names so hovering reveals who.
  const watcherNames = watchers
    .map((w) => w.user?.name || w.user?.handle || w.agent?.name || w.agent?.profileKey)
    .filter(Boolean) as string[];
  const chipTitle =
    watcherNames.length > 0
      ? `Watching: ${watcherNames.join(", ")}`
      : "No watchers yet";

  return (
    <div className={cn("inline-flex items-center gap-1", className)}>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (busy) return;
          if (isWatching) unwatch.mutate({ issueId });
          else watch.mutate({ issueId });
        }}
        title={titleText}
        aria-label={label}
        aria-pressed={isWatching}
        className={cn(
          "focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-subtle",
          MOTION.fast,
          isWatching ? "text-ember" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {isWatching ? (
          <Eye className="h-3 w-3" />
        ) : (
          <EyeOff className="h-3 w-3" />
        )}
      </button>
      {watchers.length > 0 && (
        <span
          title={chipTitle}
          className="text-meta rounded-full bg-subtle/60 px-1.5 font-mono text-muted-foreground"
        >
          {watchers.length}
        </span>
      )}
      {otherCount < 0 && null}
    </div>
  );
}
