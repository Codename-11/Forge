"use client";
import type { ReactNode } from "react";

/**
 * Per-page header strip — title, optional subtitle, and a slot for
 * page-specific actions on the right. The shell `<TopBar />` (see
 * top-bar.tsx) sits above this and owns workspace-wide chrome
 * (pins, notification bell + activity drawer, help, user menu).
 *
 * The bell + drawer used to live here too. They were promoted to the
 * shell so users see one notification surface, one count, one drawer.
 */
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
    <header className="flex shrink-0 flex-col gap-2 border-b border-border bg-background px-4 py-2 sm:h-12 sm:flex-row sm:items-center sm:px-5 sm:py-0">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold tracking-tight">{title}</div>
        {subtitle && (
          <div className="text-subtitle line-clamp-2 text-muted-foreground sm:line-clamp-1">
            {subtitle}
          </div>
        )}
      </div>
      {actions && <div className="flex min-w-0 items-center gap-1.5 sm:ml-auto">{actions}</div>}
    </header>
  );
}
