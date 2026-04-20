"use client";
import type { ReactNode } from "react";

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
        {subtitle && <div className="truncate text-[11px] text-muted-foreground">{subtitle}</div>}
      </div>
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </header>
  );
}
