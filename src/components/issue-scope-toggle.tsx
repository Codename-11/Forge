"use client";

import { cn } from "@/lib/utils";

export type IssueLifecycleScope = "open" | "all";

/**
 * Explicit lifecycle baseline shared by issue lists and boards.
 *
 * Status facets still narrow to a specific workflow state; this control
 * answers the broader question that was previously implicit: whether
 * terminal work is eligible to appear at all.
 */
export function IssueScopeToggle({
  value,
  onChange,
  className,
}: {
  value: IssueLifecycleScope;
  onChange: (value: IssueLifecycleScope) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-meta inline-flex h-6 items-center rounded-md border border-border bg-background/50 p-0.5",
        className,
      )}
      aria-label="Issue lifecycle scope"
    >
      {(["open", "all"] as const).map((scope) => (
        <button
          key={scope}
          type="button"
          onClick={() => onChange(scope)}
          aria-pressed={value === scope}
          className={cn(
            "focus-ring rounded px-2 py-0.5 capitalize transition-colors",
            value === scope
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {scope}
        </button>
      ))}
    </div>
  );
}
