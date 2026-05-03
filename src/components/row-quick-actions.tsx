"use client";

import { useMemo } from "react";
import { toast } from "sonner";
import { Bell, Check, CircleDot, UserCircle2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { SnoozeMenu } from "@/components/snooze-menu";

/**
 * `RowQuickActions` — compact horizontal action group for an inbox row.
 * Designed to be visually quiet: translucent at rest, full-opacity on
 * row hover (the parent should set `group` and `group-hover:` on the
 * row, then this component reads `data-row-hover` via the parent's
 * Tailwind tokens).
 *
 * Slots from left to right:
 *   1. Status pill   — clickable; opens an external status menu via
 *                      `onPickStatus` (the parent owns the menu UI).
 *   2. Assignee chip — clickable; opens an external assignee menu
 *                      via `onPickAssignee`.
 *   3. Snooze        — uses `SnoozeMenu`, calls `issue.snooze` /
 *                      `issue.unsnooze` directly so the row updates.
 *   4. Nudge         — one-click `issue.nudge`. Disabled when the
 *                      issue has no assigned agent.
 *   5. Mark read     — one-click `inbox.visit` (debounced 5s
 *                      server-side). The "mark this row read" model
 *                      is global "I've seen the inbox" rather than
 *                      per-row; that's intentionally simple in v1.
 *
 * All mutations surface optimistic toasts on success / error and
 * invalidate `inbox.get` / `issue.byId` on success.
 */
export function RowQuickActions({
  issueId,
  snoozedUntil,
  hasAssignedAgent,
  onPickStatus,
  onPickAssignee,
  className,
  /**
   * When false (default), the actions render at low opacity until the
   * parent row is hovered. Set true to keep them always visible (e.g.
   * on the issue-detail header, where there's no row-hover gesture).
   */
  alwaysVisible = false,
}: {
  issueId: string;
  snoozedUntil?: Date | string | null;
  hasAssignedAgent?: boolean;
  onPickStatus?: (anchor: HTMLElement) => void;
  onPickAssignee?: (anchor: HTMLElement) => void;
  className?: string;
  alwaysVisible?: boolean;
}) {
  const utils = trpc.useUtils();

  const snoozeM = trpc.issue.snooze.useMutation({
    onSuccess: () => {
      toast.success("Snoozed.");
      void utils.inbox.get.invalidate();
      void utils.issue.byId.invalidate({ id: issueId });
      void utils.dashboard.suggestions.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const unsnoozeM = trpc.issue.unsnooze.useMutation({
    onSuccess: () => {
      toast.success("Unsnoozed.");
      void utils.inbox.get.invalidate();
      void utils.issue.byId.invalidate({ id: issueId });
      void utils.dashboard.suggestions.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const nudgeM = trpc.issue.nudge.useMutation({
    onSuccess: () => {
      toast.success("Nudged.");
      void utils.inbox.get.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const visitM = trpc.inbox.visit.useMutation({
    onSuccess: () => {
      void utils.inbox.get.invalidate();
      void utils.inbox.badge.invalidate();
    },
  });

  const handleSnooze = (until: Date | null) => {
    if (until == null) {
      unsnoozeM.mutate({ id: issueId });
    } else {
      snoozeM.mutate({ id: issueId, until });
    }
  };

  const isSnoozed = useMemo(
    () => !!snoozedUntil && new Date(snoozedUntil).getTime() > Date.now(),
    [snoozedUntil],
  );

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 transition-opacity",
        alwaysVisible ? "opacity-100" : "opacity-60 group-hover:opacity-100",
        className,
      )}
    >
      {onPickStatus ? (
        <button
          type="button"
          aria-label="Change status"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onPickStatus(e.currentTarget);
          }}
          className="focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground"
        >
          <CircleDot className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
      {onPickAssignee ? (
        <button
          type="button"
          aria-label="Change assignee"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onPickAssignee(e.currentTarget);
          }}
          className="focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground"
        >
          <UserCircle2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}

      <SnoozeMenu snoozedUntil={snoozedUntil} onSelect={handleSnooze} />

      <button
        type="button"
        aria-label="Nudge assignee"
        title={
          hasAssignedAgent
            ? "Nudge — pings the assigned agent via comment"
            : "Nudge — adds a quiet check-in comment"
        }
        disabled={nudgeM.isPending || isSnoozed}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          nudgeM.mutate({ id: issueId });
        }}
        className="focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <Bell className="h-3.5 w-3.5" aria-hidden />
      </button>

      <button
        type="button"
        aria-label="Mark inbox read"
        title="Mark inbox as visited"
        disabled={visitM.isPending}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          visitM.mutate();
        }}
        className="focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <Check className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
