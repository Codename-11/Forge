"use client";

import { useRef, useState } from "react";
import { CalendarClock, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { DatePicker } from "@/components/ui/date-picker";

/**
 * `SnoozeMenu` — popover dropdown that lets the operator put an issue
 * "on hold" for a duration (1 day / 3 days / 1 week) or pick a custom
 * date. When an issue is already snoozed, the menu also offers an
 * "Unsnooze" entry. The menu is *display-only* — it calls
 * `onSelect(until | null)` and lets the parent decide which mutation
 * to fire (`issue.snooze({ until })` or `issue.unsnooze()`).
 *
 * Visual idiom mirrors `AgentQuickActions`: a small icon trigger that
 * pops a 12rem-wide menu beneath it, with a click-outside + Escape
 * handler. Settings-driven thresholds aren't relevant here — these are
 * UX presets, not workspace knobs.
 */
export type SnoozePreset = {
  label: string;
  /** Number of days from now. Coerced to a Date inside `onSelect`. */
  days: number;
};

const DEFAULT_PRESETS: ReadonlyArray<SnoozePreset> = [
  { label: "1 day", days: 1 },
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
];

export function SnoozeMenu({
  snoozedUntil,
  onSelect,
  presets = DEFAULT_PRESETS,
  trigger,
  align = "right",
  className,
}: {
  /** Current snooze timestamp, if any. Used to render the active row. */
  snoozedUntil?: Date | string | null;
  /**
   * Called when the operator picks a preset, custom date, or
   * "Unsnooze". `null` = the user wants to clear the snooze.
   */
  onSelect: (until: Date | null) => void;
  presets?: ReadonlyArray<SnoozePreset>;
  /**
   * Optional custom trigger element. When omitted, a quiet
   * "Snooze" icon button is rendered. Must be a button-like element.
   */
  trigger?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const closeMenu = () => {
    setOpen(false);
    setCustomOpen(false);
  };

  const isSnoozed =
    !!snoozedUntil && new Date(snoozedUntil).getTime() > Date.now();
  const snoozedDate = snoozedUntil ? new Date(snoozedUntil) : null;

  const pick = (until: Date | null) => {
    setOpen(false);
    setCustomOpen(false);
    onSelect(until);
  };

  const pickPreset = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    pick(d);
  };

  return (
    <div ref={containerRef} className={cn("relative inline-flex", className)}>
      {trigger ? (
        <span
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          className="inline-flex"
        >
          {trigger}
        </span>
      ) : (
        <button
          type="button"
          aria-label={isSnoozed ? "Edit snooze" : "Snooze"}
          title={
            isSnoozed && snoozedDate
              ? `Snoozed until ${formatLongDate(snoozedDate)}`
              : "Snooze"
          }
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          className={cn(
            "focus-ring inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-subtle hover:text-foreground",
            (open || isSnoozed) && "bg-subtle text-foreground",
          )}
        >
          <CalendarClock className="h-3.5 w-3.5" aria-hidden />
          {isSnoozed && snoozedDate ? (
            <span className="text-meta">until {formatShortDate(snoozedDate)}</span>
          ) : null}
        </button>
      )}

      <AnchoredPopover
        anchorRef={containerRef}
        open={open}
        onClose={closeMenu}
        align={align}
        role="menu"
        className="w-48 rounded-md border border-border bg-card py-1 shadow-md"
      >
          {isSnoozed && snoozedDate ? (
            <div className="border-b border-border px-2.5 py-1.5">
              <div className="text-meta text-muted-foreground">
                Snoozed until
              </div>
              <div className="text-[0.75rem] text-foreground">
                {formatLongDate(snoozedDate)}
              </div>
            </div>
          ) : null}

          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              role="menuitem"
              onClick={() => pickPreset(p.days)}
              className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[0.75rem] hover:bg-subtle"
            >
              <span>{p.label}</span>
              <span className="text-meta text-muted-foreground/70">
                {formatShortDate(addDays(new Date(), p.days))}
              </span>
            </button>
          ))}

          {!customOpen ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => setCustomOpen(true)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[0.75rem] hover:bg-subtle"
            >
              <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Until specific date…</span>
            </button>
          ) : (
            <div className="px-2.5 py-1.5">
              <label className="text-meta text-muted-foreground">
                Snooze until
              </label>
              <DatePicker
                value={null}
                min={toInputDate(addDays(new Date(), 1))}
                onChange={(v) => {
                  if (!v) return;
                  const d = new Date(v + "T09:00:00");
                  if (Number.isFinite(d.getTime()) && d.getTime() > Date.now()) {
                    pick(d);
                  }
                }}
                placeholder="Pick a date"
                ariaLabel="Snooze until"
                className="mt-1 text-[0.75rem]"
              />
            </div>
          )}

          {isSnoozed ? (
            <>
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                role="menuitem"
                onClick={() => pick(null)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[0.75rem] hover:bg-subtle"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground" />
                <span>Unsnooze</span>
              </button>
            </>
          ) : null}
      </AnchoredPopover>
    </div>
  );
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

function toInputDate(d: Date): string {
  // YYYY-MM-DD in local time — matches `<input type="date">`.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatShortDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatLongDate(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
