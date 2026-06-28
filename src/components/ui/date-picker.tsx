"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AnchoredPopover } from "./anchored-popover";

// ---------------------------------------------------------------------------
// Pure date helpers — all local-time, `YYYY-MM-DD` strings, so this is a
// drop-in for `<input type="date">` (which is date-only, no timezone).
// ---------------------------------------------------------------------------

export function parseDateValue(v: string | null | undefined): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, mo - 1, d);
  // Reject overflow (e.g. 2026-02-30 → March).
  if (date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Month grid padded with leading nulls so day 1 lands on its weekday. */
export function buildMonthGrid(year: number, month: number): (Date | null)[] {
  const first = new Date(year, month, 1);
  const startDow = first.getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  return cells;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function startOfToday(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Themed date picker — a calendar popover that replaces native
 * `<input type="date">`. `value`/`onChange` speak `YYYY-MM-DD` strings (empty
 * string when cleared), so it's a drop-in for the native input.
 */
export function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder = "Select date",
  disabled = false,
  clearable = true,
  ariaLabel,
  className,
}: {
  value: string | null | undefined;
  onChange: (value: string) => void;
  min?: string | null;
  max?: string | null;
  placeholder?: string;
  disabled?: boolean;
  clearable?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  const selected = parseDateValue(value);
  const minD = parseDateValue(min ?? null);
  const maxD = parseDateValue(max ?? null);

  const [view, setView] = useState(() => {
    const base = selected ?? startOfToday();
    return { y: base.getFullYear(), m: base.getMonth() };
  });

  // Jump the grid to the selected month each time the popover opens.
  useEffect(() => {
    if (!open) return;
    const s = parseDateValue(value);
    if (s) setView({ y: s.getFullYear(), m: s.getMonth() });
  }, [open, value]);

  const cells = useMemo(() => buildMonthGrid(view.y, view.m), [view]);

  function disabledDay(d: Date): boolean {
    if (minD && d < minD) return true;
    if (maxD && d > maxD) return true;
    return false;
  }

  function pick(d: Date) {
    if (disabledDay(d)) return;
    onChange(formatDateValue(d));
    setOpen(false);
  }

  function shift(delta: number) {
    const d = new Date(view.y, view.m + delta, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  }

  const today = startOfToday();

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel ?? "Choose date"}
        className={cn(
          "focus-ring inline-flex h-8 w-full items-center gap-2 rounded-md border border-input bg-background px-2.5 text-sm disabled:opacity-50",
          selected ? "text-foreground" : "text-muted-foreground",
          className,
        )}
      >
        <CalendarIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-left">
          {selected
            ? selected.toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })
            : placeholder}
        </span>
        {clearable && selected && !disabled && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="Clear date"
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </span>
        )}
      </button>

      <AnchoredPopover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        role="dialog"
        ariaLabel="Date picker"
        align="right"
        minSpaceBelow={280}
        className="w-64 rounded-lg border border-border bg-card p-3 shadow-xl"
      >
        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            onClick={() => shift(-1)}
            aria-label="Previous month"
            className="focus-ring rounded p-1 text-muted-foreground hover:bg-subtle hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs font-medium text-foreground">
            {MONTHS[view.m]} {view.y}
          </span>
          <button
            type="button"
            onClick={() => shift(1)}
            aria-label="Next month"
            className="focus-ring rounded p-1 text-muted-foreground hover:bg-subtle hover:text-foreground"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="mb-1 grid grid-cols-7 gap-0.5">
          {WEEKDAYS.map((w, i) => (
            <span
              key={i}
              className="py-1 text-center text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground"
            >
              {w}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((d, i) => {
            if (!d) return <span key={i} />;
            const isSel = selected && sameDay(d, selected);
            const isToday = sameDay(d, today);
            const off = disabledDay(d);
            return (
              <button
                key={i}
                type="button"
                disabled={off}
                onClick={() => pick(d)}
                className={cn(
                  "focus-ring h-7 rounded-md text-xs transition-colors",
                  isSel
                    ? "bg-ember text-ember-foreground"
                    : "text-foreground hover:bg-subtle",
                  !isSel && isToday && "ring-1 ring-ember/40",
                  off &&
                    "cursor-not-allowed text-muted-foreground/40 hover:bg-transparent",
                )}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>
      </AnchoredPopover>
    </>
  );
}
