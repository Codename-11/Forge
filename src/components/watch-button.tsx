"use client";
import { Bot, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
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
        <WatcherChip count={watchers.length} watchers={watchers} fallbackTitle={chipTitle} />
      )}
      {otherCount < 0 && null}
    </div>
  );
}

/**
 * Watcher count chip with a CSS-driven hover popover. The popover lists
 * up to six watchers with avatars + names + handles, and a "+N more"
 * spillover when the list overflows. We keep the native `title=` so
 * keyboard / touch users still get a fallback tooltip — the popover is
 * a richer enhancement, not a replacement.
 *
 * No Radix Popover dep — pure Tailwind `group-hover` + `opacity-0` /
 * `pointer-events-none` so the layer is invisible until the chip is
 * hovered. Anchored above the chip so it doesn't dip below the issue
 * header on narrow viewports.
 */
function WatcherChip({
  count,
  watchers,
  fallbackTitle,
}: {
  count: number;
  watchers: WatcherRow[];
  fallbackTitle: string;
}) {
  const MAX = 6;
  const shown = watchers.slice(0, MAX);
  const overflow = Math.max(0, watchers.length - MAX);
  return (
    <span className="group/watchers relative inline-flex">
      <span
        title={fallbackTitle}
        className="text-meta rounded-full bg-subtle/60 px-1.5 font-mono text-muted-foreground"
      >
        {count}
      </span>
      <div
        role="tooltip"
        aria-hidden
        className={cn(
          "pointer-events-none absolute right-0 top-[calc(100%+6px)] z-50 w-64 rounded-md border border-border bg-popover p-2 shadow-md opacity-0 transition-opacity",
          "group-hover/watchers:opacity-100 group-focus-within/watchers:opacity-100",
        )}
      >
        <div className="mb-1 px-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Watchers ({count})
        </div>
        <ul className="flex flex-col gap-0.5">
          {shown.map((w) => (
            <li
              key={w.id}
              className="flex items-center gap-2 rounded px-1 py-0.5 text-meta"
            >
              <WatcherAvatar w={w} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-foreground">
                  {w.user?.name ?? w.agent?.name ?? "Unknown"}
                </div>
                <div className="truncate font-mono text-[0.6875rem] text-muted-foreground">
                  {w.user
                    ? w.user.handle
                      ? `@${w.user.handle}`
                      : ""
                    : w.agent
                      ? `@${w.agent.profileKey}`
                      : ""}
                </div>
              </div>
            </li>
          ))}
        </ul>
        {overflow > 0 && (
          <div className="mt-1 border-t border-border/60 px-1 pt-1 text-meta text-muted-foreground">
            +{overflow} more
          </div>
        )}
      </div>
    </span>
  );
}

type WatcherRow = {
  id: string;
  userId?: string | null;
  agentId?: string | null;
  user?: {
    id: string;
    name: string | null;
    image: string | null;
    handle?: string | null;
  } | null;
  agent?: {
    id: string;
    name: string;
    profileKey: string;
    avatar: string | null;
  } | null;
};

function WatcherAvatar({ w }: { w: WatcherRow }) {
  if (w.agent) {
    // Agent watchers — show the bot glyph (or the agent's avatar emoji
    // if set). Indigo tint matches the agent visual language elsewhere.
    return (
      <span
        aria-hidden
        className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-indigo-500/15 text-indigo-500"
      >
        {w.agent.avatar ? (
          <span className="text-[0.6875rem]">{w.agent.avatar}</span>
        ) : (
          <Bot className="h-3 w-3" />
        )}
      </span>
    );
  }
  return (
    <Avatar
      name={w.user?.name ?? null}
      image={w.user?.image ?? null}
      size={20}
      className="shrink-0"
    />
  );
}
