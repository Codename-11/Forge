"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { Spinner } from "@/components/ui/spinner";
import { useModalBehavior } from "./use-modal-behavior";

/**
 * <Picker> — vertical command-palette-style chooser.
 *
 * Search input at the top, scrollable results below. Arrow keys move the
 * highlight; ⏎ selects the highlighted item; ⎋ closes. The search input
 * is auto-focused on open.
 *
 * Data-driven: the caller supplies `items`, a `renderItem`, and a `getKey`.
 * Filtering is the caller's responsibility — they can compute `items`
 * from the current `query` (exposed via `onQueryChange`) or pre-filter
 * server-side. The picker just owns UX.
 */
export function Picker<T>({
  open,
  onOpenChange,
  placeholder = "Search…",
  items,
  renderItem,
  getKey,
  onSelect,
  onQueryChange,
  loading,
  emptyLabel = "No results.",
  initialQuery = "",
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placeholder?: string;
  items: T[];
  renderItem: (item: T, opts: { highlighted: boolean }) => React.ReactNode;
  getKey: (item: T) => string;
  onSelect: (item: T) => void | Promise<void>;
  /** Notifies the caller when the query changes (for async search). */
  onQueryChange?: (q: string) => void;
  loading?: boolean;
  emptyLabel?: React.ReactNode;
  initialQuery?: string;
  /** Optional footer slot (e.g. keyboard hints). */
  footer?: React.ReactNode;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = React.useState(initialQuery);
  const [highlight, setHighlight] = React.useState(0);

  useModalBehavior({
    open,
    onClose: () => onOpenChange(false),
    containerRef,
    initialFocusRef: searchRef,
  });

  // Reset query + highlight when (re)opened.
  React.useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setHighlight(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  React.useEffect(() => {
    onQueryChange?.(query);
  }, [query, onQueryChange]);

  // Keep highlight within bounds as items change.
  React.useEffect(() => {
    if (highlight >= items.length) {
      setHighlight(items.length > 0 ? items.length - 1 : 0);
    }
  }, [items.length, highlight]);

  // Scroll the active row into view as the highlight moves.
  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(
      `[data-picker-index="${highlight}"]`,
    );
    if (row) row.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(items.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[highlight];
      if (item) void onSelect(item);
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlight(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlight(Math.max(0, items.length - 1));
    }
  }

  if (!open) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 pt-[14vh] backdrop-blur-sm",
        MOTION.fadeIn,
      )}
      onClick={() => onOpenChange(false)}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        className={cn(
          "flex w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl",
          MOTION.slideUp,
        )}
        style={{ maxHeight: "70vh" }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="border-b border-border p-2">
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground"
          />
        </div>

        <div
          ref={listRef}
          role="listbox"
          aria-label="Picker results"
          className="min-h-[60px] flex-1 overflow-y-auto py-1"
        >
          {loading && items.length === 0 && (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
              <Spinner size="sm" />
              Loading…
            </div>
          )}

          {!loading && items.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {emptyLabel}
            </div>
          )}

          {items.map((item, i) => {
            const highlighted = i === highlight;
            return (
              <div
                key={getKey(item)}
                role="option"
                aria-selected={highlighted}
                data-picker-index={i}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => onSelect(item)}
                className={cn(
                  "focus-ring cursor-pointer px-2 py-1.5 text-sm",
                  highlighted ? "bg-subtle" : "hover:bg-subtle/60",
                  MOTION.fast,
                )}
              >
                {renderItem(item, { highlighted })}
              </div>
            );
          })}
        </div>

        {footer && (
          <div className="border-t border-border bg-card/60 px-3 py-1.5 text-[11px] text-muted-foreground">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
