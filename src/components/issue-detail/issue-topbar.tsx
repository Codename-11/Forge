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
        "flex flex-wrap items-start gap-2 border-b border-border bg-card/20 px-3 py-2 sm:px-5",
        className,
      )}
    >
      <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 md:w-auto md:gap-2">
        {left}
      </div>
      {middle && (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 md:w-auto md:flex-1">
          {middle}
        </div>
      )}
      {actions && (
        <div className="flex w-full shrink-0 items-center justify-end gap-1.5 md:ml-auto md:w-auto">
          {actions}
        </div>
      )}
    </div>
  );
}
