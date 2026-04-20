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
        "flex flex-wrap items-center gap-2 border-b border-border bg-card/20 px-5 py-2",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">{left}</div>
      {middle && (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {middle}
        </div>
      )}
      {actions && (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {actions}
        </div>
      )}
    </div>
  );
}
