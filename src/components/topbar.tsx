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
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-5">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold tracking-tight">{title}</div>
        {subtitle && <div className="truncate text-subtitle text-muted-foreground">{subtitle}</div>}
      </div>
      {actions && (
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      )}
    </header>
  );
}
