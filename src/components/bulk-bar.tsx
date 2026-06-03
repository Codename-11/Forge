"use client";

import { X } from "lucide-react";
import { Kbd } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Sticky toolbar that appears at the top of the scroll container when at
 * least one row is selected in a bulk-select surface.
 *
 * Originated as an inline component on the inbox page (see
 * `src/app/(app)/w/[slug]/inbox/page.tsx` history) — extracted here so
 * `/issues` and the project list tab can mirror the same affordances:
 * sticky positioning, count + clear chip, kbd hints, and a flexible
 * action slot the per-surface caller fills with picker triggers.
 *
 * The component is intentionally low-opinion: callers pass an
 * `actions` array and we render the buttons. Pickers / dialogs /
 * SnoozeMenu triggers all stay where the caller can wire them to the
 * surface's own state. That keeps inbox's `SnoozeMenu` (which renders
 * its own popover from the trigger element) and the issues page's
 * modal-style pickers both first-class.
 */
export type BulkBarAction = {
  /** Stable key for React. */
  id: string;
  /** Visible label inside the button. */
  label: React.ReactNode;
  /** Optional leading icon (lucide). */
  icon?: React.ReactNode;
  /** Optional title/tooltip. */
  title?: string;
  /** Disable the button (e.g. while a mutation is pending). */
  disabled?: boolean;
  /**
   * Either an onClick handler or a fully custom trigger node. Use
   * `render` when the action's trigger is a component that owns its
   * own popover (e.g. the inbox's `SnoozeMenu`) — we'll render the
   * node verbatim instead of wrapping it in a `<button>`.
   */
  onClick?: () => void;
  render?: (defaultClass: string) => React.ReactNode;
};

const BTN_CLASS =
  "focus-ring inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[0.6875rem] hover:bg-subtle disabled:opacity-50";

export function BulkBar({
  count,
  onClear,
  actions,
  className,
  contentClassName,
  hint,
}: {
  count: number;
  onClear: () => void;
  actions: BulkBarAction[];
  /** Override the outer (sticky wrapper) class. */
  className?: string;
  /** Override the inner content row class — e.g. constrain max-width. */
  contentClassName?: string;
  /**
   * Optional override for the kbd hint span. Defaults to the
   * inbox-style "x select · Esc clear" hint.
   */
  hint?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur",
        className,
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 px-3 py-2 text-[0.75rem] sm:gap-3 sm:px-5",
          contentClassName,
        )}
      >
        <span className="font-medium">{count} selected</span>
        <button
          type="button"
          onClick={onClear}
          title="Clear selection (Esc)"
          className="text-meta inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" />
          Clear selection
        </button>
        <span className="text-meta hidden items-center gap-1 text-muted-foreground/70 sm:inline-flex">
          {hint ?? (
            <>
              <Kbd>x</Kbd> select · <Kbd>Esc</Kbd> clear
            </>
          )}
        </span>
        <div className="flex w-full min-w-0 items-center gap-1.5 overflow-x-auto pb-1 sm:ml-auto sm:w-auto sm:overflow-visible sm:pb-0">
          {actions.map((a) => {
            if (a.render) {
              return <span key={a.id}>{a.render(BTN_CLASS)}</span>;
            }
            return (
              <button
                key={a.id}
                type="button"
                disabled={a.disabled}
                onClick={a.onClick}
                title={a.title}
                className={BTN_CLASS}
              >
                {a.icon}
                {a.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={onClear}
            title="Clear selection (Esc)"
            className="focus-ring inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] text-muted-foreground hover:text-foreground"
          >
            <Kbd>Esc</Kbd>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
