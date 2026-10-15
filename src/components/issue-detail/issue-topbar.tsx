"use client";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Issue-detail-specific top strip. Renders directly under the page shell
 * <Topbar />. Hosts the identifiers (key + title) alongside inline
 * status/priority/assignee controls and the page-level action buttons
 * (pin, focus, delete). Kept dumb on purpose — parent supplies slots, so
 * the page can wire up its own handlers without threading them through.
 */
export function IssueDetailTopbar({
  left,
  middle,
  actions,
  className,
}: {
  left: ReactNode;
  middle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 border-b border-border bg-card/20 px-3 py-3 sm:px-5",
        className,
      )}
    >
      <div className="col-span-2 min-w-0">{left}</div>
      {middle && <div className="flex min-w-0 flex-wrap items-center gap-1.5">{middle}</div>}
      {actions && (
        <div className="flex min-w-0 shrink-0 items-center justify-end gap-1.5">{actions}</div>
      )}
    </div>
  );
}
