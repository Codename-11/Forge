"use client";

import { useState } from "react";
import Link from "next/link";
import { Activity, Bell, Check, ChevronRight, Inbox } from "lucide-react";
import { SidePanel } from "@/components/ui/modal";
import { EmptyState, Spinner } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";
import { WsChip } from "./mission-control-home";

/** Cross-workspace counterpart to the workspace ActivityDrawer. */
export function GlobalAttentionBell() {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const badge = trpc.inbox.badge.useQuery(undefined, {
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
  const alertCount = trpc.notification.globalUnreadCount.useQuery(undefined, {
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
  const work = trpc.global.work.useQuery(undefined, {
    enabled: open,
    refetchOnWindowFocus: true,
  });
  const activity = trpc.global.activity.useQuery(undefined, {
    enabled: open,
    refetchOnWindowFocus: true,
  });
  const alerts = trpc.notification.globalList.useQuery(undefined, {
    enabled: open,
    refetchOnWindowFocus: true,
  });
  const markAlertsRead = trpc.notification.globalMarkRead.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.inbox.badge.invalidate(),
        utils.notification.globalUnreadCount.invalidate(),
        utils.notification.globalList.invalidate(),
      ]);
    },
  });
  const unread = (badge.data?.count ?? 0) + (alertCount.data?.count ?? 0);
  const tip = unread > 0 ? `${unread} unread attention items` : "No unread attention items";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={tip}
        aria-label={`Open notifications. ${tip}`}
        className="focus-ring relative inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground sm:h-7 sm:w-7"
      >
        <Bell className="h-3.5 w-3.5" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-ember px-1 font-mono text-[0.6875rem] font-semibold text-ember-foreground">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      <SidePanel
        open={open}
        onOpenChange={setOpen}
        title="Notifications"
        description="Assignments and operational alerts across every workspace."
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Needs your attention</p>
              <p className="text-meta mt-0.5 text-muted-foreground">One shared attention queue.</p>
            </div>
            <button
              type="button"
              disabled={unread === 0 || markAlertsRead.isPending}
              onClick={() => markAlertsRead.mutate()}
              className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium hover:border-ember/40 disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" /> Mark all read
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {work.isLoading || activity.isLoading || alerts.isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Spinner />
              </div>
            ) : (
              <div className="space-y-3">
                {(alerts.data?.length ?? 0) > 0 && (
                  <section className="overflow-hidden rounded-lg border border-border bg-card/40">
                    <header className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
                      <Bell className="h-3.5 w-3.5 text-ember" />
                      <h3 className="text-xs font-semibold">Operational alerts</h3>
                      <span className="text-meta ml-auto text-muted-foreground">
                        {alertCount.data?.count ?? 0} unread
                      </span>
                    </header>
                    <div className="divide-y divide-border/60">
                      {alerts.data!.slice(0, 5).map((alert) => (
                        <Link
                          key={alert.id}
                          href={alert.notification.primaryHref}
                          onClick={() => setOpen(false)}
                          className="focus-ring flex min-h-14 items-start gap-2.5 px-3 py-2.5 hover:bg-subtle"
                        >
                          <WsChip ws={alert.workspace} dense />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium">
                              {alert.notification.summary}
                            </span>
                            <span className="text-meta mt-0.5 line-clamp-2 block text-muted-foreground">
                              {alert.notification.recommendedAction}
                            </span>
                          </span>
                          <span className="text-meta shrink-0 text-muted-foreground">
                            {relativeTime(alert.createdAt)}
                          </span>
                        </Link>
                      ))}
                    </div>
                  </section>
                )}

                <section className="overflow-hidden rounded-lg border border-border bg-card/40">
                  <header className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
                    <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
                    <h3 className="text-xs font-semibold">Assigned to you</h3>
                    <span className="text-meta ml-auto text-muted-foreground">
                      {work.data?.length ?? 0} open
                    </span>
                  </header>
                  {(work.data?.length ?? 0) === 0 ? (
                    <EmptyState
                      variant="card"
                      title="No active assignments"
                      description="Your cross-workspace inbox is clear."
                    />
                  ) : (
                    <div className="divide-y divide-border/60">
                      {work.data!.slice(0, 5).map((issue) => (
                        <Link
                          key={issue.id}
                          href={`/w/${issue.workspace.slug}/i/${issue.workspace.key}-${issue.number}`}
                          onClick={() => setOpen(false)}
                          className="focus-ring flex min-h-12 items-center gap-2.5 px-3 py-2 hover:bg-subtle"
                        >
                          <WsChip ws={issue.workspace} dense />
                          <span className="text-id shrink-0 text-muted-foreground">
                            {issue.workspace.key}-{issue.number}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-xs">{issue.title}</span>
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        </Link>
                      ))}
                    </div>
                  )}
                  <Link
                    href="/inbox"
                    onClick={() => setOpen(false)}
                    className="focus-ring flex min-h-10 items-center justify-center border-t border-border/70 text-xs font-medium text-muted-foreground hover:bg-subtle hover:text-foreground"
                  >
                    Open global inbox
                  </Link>
                </section>

                <section className="overflow-hidden rounded-lg border border-border bg-card/40">
                  <header className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
                    <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                    <h3 className="text-xs font-semibold">Recent activity</h3>
                  </header>
                  <div className="divide-y divide-border/60">
                    {(activity.data ?? []).slice(0, 5).map((event) => (
                      <Link
                        key={event.id}
                        href={event.href}
                        onClick={() => setOpen(false)}
                        className="focus-ring flex min-h-12 items-start gap-2.5 px-3 py-2 hover:bg-subtle"
                      >
                        <WsChip ws={event.workspace} dense />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">{event.title}</span>
                          {event.detail && (
                            <span className="text-meta block truncate text-muted-foreground">
                              {event.detail}
                            </span>
                          )}
                        </span>
                        <span className="text-meta shrink-0 text-muted-foreground">
                          {relativeTime(event.createdAt)}
                        </span>
                      </Link>
                    ))}
                  </div>
                  <Link
                    href="/activity"
                    onClick={() => setOpen(false)}
                    className="focus-ring flex min-h-10 items-center justify-center border-t border-border/70 text-xs font-medium text-muted-foreground hover:bg-subtle hover:text-foreground"
                  >
                    View all activity
                  </Link>
                </section>
              </div>
            )}
          </div>
        </div>
      </SidePanel>
    </>
  );
}
