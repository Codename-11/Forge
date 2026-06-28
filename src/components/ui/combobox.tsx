"use client";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import {
  AgentAvatar,
  type AgentAvatarIdentity,
} from "@/components/agents/agent-avatar";

/**
 * `Combobox` — a themed replacement for a native `<select>` used as an
 * attribute picker. Trigger button + a portaled `AnchoredPopover` list
 * (never clipped), optional search, keyboard nav (↑/↓/Enter/Esc), and a
 * colour-dot / agent-avatar per row.
 *
 * Static mode: pass `options` and (optionally) `searchable` for built-in
 * client-side filtering. Async mode: pass `onQueryChange` + `query` and
 * feed already-filtered `options` from a server search (set `loading`
 * while it's in flight).
 */
export type ComboOption = {
  value: string;
  label: string;
  /** Right-aligned mono hint (e.g. an issue key or `@handle`). */
  secondary?: string;
  /** Colour swatch (project/label). `undefined` = no dot. */
  color?: string | null;
  /** Agent identity → renders an avatar instead of a dot. */
  avatar?: AgentAvatarIdentity;
};

export function Combobox({
  value,
  onChange,
  options,
  query,
  onQueryChange,
  loading = false,
  searchable = false,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  allowNone = false,
  noneLabel = "None",
  disabled = false,
  align = "left",
  matchTriggerWidth = false,
  className,
  popoverClassName,
  leadingIcon,
  emptyText = "No matches",
  ariaLabel,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  options: ComboOption[];
  /** Controlled search text (async mode). */
  query?: string;
  /** Present → async mode: caller owns filtering + supplies `options`. */
  onQueryChange?: (q: string) => void;
  loading?: boolean;
  /** Static mode: enable built-in client-side filtering + a search box. */
  searchable?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  allowNone?: boolean;
  noneLabel?: string;
  disabled?: boolean;
  align?: "left" | "right";
  matchTriggerWidth?: boolean;
  className?: string;
  popoverClassName?: string;
  leadingIcon?: ReactNode;
  emptyText?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [internalQuery, setInternalQuery] = useState("");
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();

  const isAsync = !!onQueryChange;
  const showSearch = searchable || isAsync;
  const q = isAsync ? query ?? "" : internalQuery;

  const filtered = useMemo(() => {
    if (isAsync) return options; // parent already filtered
    if (!searchable || !internalQuery.trim()) return options;
    const needle = internalQuery.trim().toLowerCase();
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(needle) ||
        o.secondary?.toLowerCase().includes(needle),
    );
  }, [isAsync, searchable, internalQuery, options]);

  // Rows include a leading "none" sentinel when allowNone.
  const rows = useMemo<(ComboOption | null)[]>(
    () => (allowNone ? [null, ...filtered] : filtered),
    [allowNone, filtered],
  );

  const selected = value ? options.find((o) => o.value === value) ?? null : null;

  useEffect(() => {
    setActive(0);
  }, [rows.length, open]);

  const choose = (row: ComboOption | null) => {
    onChange(row ? row.value : null);
    setOpen(false);
    setInternalQuery("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0 && active < rows.length) choose(rows[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "focus-ring inline-flex items-center gap-1.5 rounded-md border border-input bg-background/40 px-2 py-1 text-sm disabled:opacity-50",
          className,
        )}
      >
        {leadingIcon}
        {selected ? (
          <span className="flex min-w-0 items-center gap-1.5">
            {selected.avatar ? (
              <AgentAvatar agent={selected.avatar} size="xs" title={null} />
            ) : selected.color !== undefined ? (
              <ColorDot color={selected.color} />
            ) : null}
            <span className="truncate">{selected.label}</span>
          </span>
        ) : (
          <span className="truncate text-muted-foreground">{placeholder}</span>
        )}
        <ChevronDown className="ml-auto h-3 w-3 shrink-0 opacity-60" aria-hidden />
      </button>

      <AnchoredPopover
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        align={align}
        matchWidth={matchTriggerWidth}
        role="listbox"
        id={listboxId}
        ariaLabel={ariaLabel}
        className={cn(
          "min-w-[11rem] rounded-md border border-border bg-popover shadow-md",
          popoverClassName,
        )}
      >
        {showSearch && (
          <div className="flex items-center gap-1.5 border-b border-border/60 px-2">
            <Search
              className="h-3 w-3 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <input
              ref={inputRef}
              autoFocus
              value={q}
              onChange={(e) =>
                isAsync
                  ? onQueryChange?.(e.target.value)
                  : setInternalQuery(e.target.value)
              }
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              className="w-full bg-transparent py-1.5 text-xs focus:outline-none"
            />
          </div>
        )}
        <div
          // Callback ref focuses the list when there's no search box, so
          // keyboard nav works for plain enum pickers too.
          ref={(el) => {
            if (el && open && !showSearch) el.focus();
          }}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="max-h-64 overflow-y-auto py-1 focus:outline-none"
        >
          {loading ? (
            <div className="text-meta px-2.5 py-1.5 text-muted-foreground">
              Searching…
            </div>
          ) : rows.length === 0 ? (
            <div className="text-meta px-2.5 py-1.5 text-muted-foreground">
              {emptyText}
            </div>
          ) : (
            rows.map((row, i) => {
              const isSel = row ? row.value === value : value === null;
              return (
                <button
                  key={row ? row.value : "__none__"}
                  type="button"
                  role="option"
                  aria-selected={isSel}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(row)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs",
                    i === active
                      ? "bg-subtle text-foreground"
                      : "text-muted-foreground hover:bg-subtle/70",
                  )}
                >
                  {row?.avatar ? (
                    <AgentAvatar agent={row.avatar} size="xs" title={null} />
                  ) : row && row.color !== undefined ? (
                    <ColorDot color={row.color} />
                  ) : null}
                  <span className="flex-1 truncate">
                    {row ? row.label : noneLabel}
                  </span>
                  {row?.secondary && (
                    <span className="text-id font-mono text-muted-foreground">
                      {row.secondary}
                    </span>
                  )}
                  {isSel && (
                    <Check className="h-3 w-3 shrink-0 text-ember" aria-hidden />
                  )}
                </button>
              );
            })
          )}
        </div>
      </AnchoredPopover>
    </>
  );
}

function ColorDot({ color }: { color?: string | null }) {
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-sm"
      style={{ backgroundColor: color ?? "transparent" }}
      aria-hidden
    />
  );
}
