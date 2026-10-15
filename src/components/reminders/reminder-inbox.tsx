"use client";
import Link from "next/link";
import { useEffect } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

export function ReminderInbox({
  workspaceId,
  onNavigate,
  enabled = true,
  onCountChange,
  className = "m-3",
}: {
  workspaceId?: string;
  onNavigate?: () => void;
  enabled?: boolean;
  onCountChange?: (count: number) => void;
  className?: string;
}) {
  const utils = trpc.useUtils();
  const query = trpc.reminder.due.useInfiniteQuery(
    { workspaceId },
    {
      enabled,
      refetchInterval: enabled ? 30_000 : false,
      getNextPageParam: (page) => page.nextCursor,
    },
  );
  const invalidate = () =>
    Promise.all([
      utils.reminder.invalidate(),
      utils.notification.unreadCount.invalidate(),
      utils.notification.globalUnreadCount.invalidate(),
    ]);
  const options = {
    onSuccess: () => {
      void invalidate();
    },
    onError: (error: { message: string }) => toast.error(error.message),
  };
  const dismiss = trpc.reminder.dismiss.useMutation(options);
  const snooze = trpc.reminder.snooze.useMutation(options);
  const read = trpc.reminder.read.useMutation(options);
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  useEffect(() => onCountChange?.(total), [onCountChange, total]);
  if (query.error)
    return (
      <p role="alert" className="p-3 text-xs text-danger">
        Reminders could not load.{" "}
        <button className="underline" onClick={() => query.refetch()}>
          Retry
        </button>
      </p>
    );
  if (!rows.length) return null;
  return (
    <section
      aria-label="Your reminders"
      className={`${className} overflow-hidden rounded-lg border border-border bg-card/40`}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-semibold">
        <Bell className="h-3.5 w-3.5 text-ember" />
        Your reminders{" "}
        <span className="text-meta ml-auto text-muted-foreground">
          {query.data?.pages[0]?.total}
        </span>
      </header>
      <div className="divide-y divide-border">
        {rows.map((row) => (
          <article key={row.id} className="space-y-2 p-3">
            <Link
              href={`/w/${row.workspace.slug}/issues/${row.issueId}`}
              onClick={() => {
                read.mutate({ id: row.id });
                onNavigate?.();
              }}
              className="focus-ring block text-sm font-medium hover:text-ember"
            >
              <span className="text-id mr-2 text-muted-foreground">
                {row.workspace.key}-{row.issue.number}
              </span>
              {row.issue.title}
            </Link>
            <p className="text-meta text-muted-foreground">
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: row.timezone,
              }).format(row.remindAt)}{" "}
              · {row.timezone}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={snooze.isPending || dismiss.isPending}
                onClick={() =>
                  snooze.mutate({ id: row.id, remindAt: new Date(Date.now() + 60 * 60_000) })
                }
              >
                Snooze 1 hour
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={dismiss.isPending || snooze.isPending}
                onClick={() => dismiss.mutate({ id: row.id })}
              >
                Dismiss reminder
              </Button>
            </div>
          </article>
        ))}
      </div>
      {query.hasNextPage && (
        <Button
          className="m-3"
          size="sm"
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage()}
        >
          Show more reminders
        </Button>
      )}
    </section>
  );
}
