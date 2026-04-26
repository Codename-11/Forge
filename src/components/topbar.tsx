"use client";
import type { ReactNode } from "react";
import { Bell } from "lucide-react";
import ActivityDrawer, { useActivityDrawer } from "@/components/activity-drawer";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";

function ActivityBell() {
  const ws = useMaybeWorkspace();
  const { toggle, unreadCount } = useActivityDrawer();
  if (!ws) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={
        unreadCount > 0
          ? `Open activity, ${unreadCount} unread`
          : "Open activity"
      }
      className="focus-ring relative inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground"
    >
      <Bell className="h-3.5 w-3.5" />
      {unreadCount > 0 && (
        <span
          className={cn(
            "absolute -top-0.5 -right-0.5 grid h-3.5 min-w-3.5 place-items-center",
            "rounded-full bg-ember px-1 text-[9px] font-mono font-semibold text-ember-foreground",
          )}
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      )}
    </button>
  );
}

export function Topbar({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold tracking-tight">{title}</div>
        {subtitle && <div className="truncate text-subtitle text-muted-foreground">{subtitle}</div>}
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        <ActivityBell />
        {actions}
      </div>
      <ActivityDrawer />
    </header>
  );
}
