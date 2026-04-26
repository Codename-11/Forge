"use client";

import { useMemo, useState, type JSX } from "react";

/**
 * GitHub-contributions-style activity heatmap.
 *
 * Self-contained presentation component for the Mission Control widget.
 * Renders a 7-row (Mon→Sun) grid of cells whose ember opacity scales
 * with the day's event count, with month labels along the top and a
 * Less/More legend underneath.
 *
 * Pure React + Tailwind — no date-fns, no tRPC, no realtime.
 */
export type ActivityHeatmapDay = {
  /** ISO calendar date, YYYY-MM-DD (in the viewer's local time zone). */
  date: string;
  count: number;
};

type Cell = {
  /** YYYY-MM-DD */
  key: string;
  /** Date object at local midnight; null for cells "before" the dataset. */
  date: Date;
  count: number;
  /** 0–4 — index into the bucket scale. */
  bucket: number;
};

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Tailwind class for each of the 5 buckets (0 = empty). */
const BUCKET_CLASS = [
  "bg-card ring-1 ring-border/30",
  "bg-ember/20",
  "bg-ember/40",
  "bg-ember/65",
  "bg-ember/90",
] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Forge weeks start on Monday. Returns 0 (Mon) … 6 (Sun) for the given
 * date — used to anchor the rightmost column to today's row.
 */
function mondayIndex(d: Date): number {
  // JS getDay: 0 = Sun, 1 = Mon, … 6 = Sat
  const js = d.getDay();
  return (js + 6) % 7;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

function bucketFor(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  // Even split across the upper four buckets — bucket 0 is reserved for
  // empty days so any non-zero count gets at least bucket 1.
  const ratio = count / max;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}

function humanDate(d: Date): string {
  // e.g. "Tue Apr 21" — no year, this is for a 12-week panel.
  const wd = WEEKDAY_SHORT[d.getDay()] ?? "";
  const m = MONTH_LABELS[d.getMonth()] ?? "";
  return `${wd} ${m} ${d.getDate()}`;
}

export function ActivityHeatmap({
  data,
  weeks = 12,
  cellSize = 10,
  cellGap = 2,
  onCellClick,
}: {
  data: ActivityHeatmapDay[];
  weeks?: number;
  cellSize?: number;
  cellGap?: number;
  onCellClick?: (day: ActivityHeatmapDay) => void;
}): JSX.Element {
  const [hovered, setHovered] = useState<{ col: number; row: number } | null>(
    null,
  );

  const { columns, max } = useMemo(() => {
    // O(1) lookup map: date key → count.
    const counts = new Map<string, number>();
    for (const d of data) counts.set(d.date, d.count);

    const today = startOfDay(new Date());
    // Anchor the last column so today sits in its correct weekday row.
    // Total cells = weeks * 7. Today is at column (weeks-1), row mondayIndex(today).
    const totalCells = weeks * 7;
    const todayCol = weeks - 1;
    const todayRow = mondayIndex(today);
    const startOffset = todayCol * 7 + todayRow; // days back from today to the very first cell
    const start = addDays(today, -startOffset);

    let observedMax = 0;
    const flat: Cell[] = [];
    for (let i = 0; i < totalCells; i++) {
      const date = addDays(start, i);
      const key = toKey(date);
      const count = counts.get(key) ?? 0;
      if (count > observedMax) observedMax = count;
      flat.push({ key, date, count, bucket: 0 });
    }
    // Second pass to assign buckets now that we know the max.
    for (const cell of flat) {
      cell.bucket = bucketFor(cell.count, observedMax);
    }

    // Reshape into columns (weeks) of 7 rows.
    const cols: Cell[][] = [];
    for (let w = 0; w < weeks; w++) {
      const col: Cell[] = [];
      for (let r = 0; r < 7; r++) {
        const cell = flat[w * 7 + r];
        if (cell) col.push(cell);
      }
      cols.push(col);
    }
    return { columns: cols, max: observedMax };
  }, [data, weeks]);

  // Month-label row: show abbrev when a column starts a new month
  // (relative to its top-most cell).
  const monthLabels = useMemo(() => {
    const labels: (string | null)[] = [];
    let lastMonth = -1;
    for (const col of columns) {
      const top = col[0];
      if (!top) {
        labels.push(null);
        continue;
      }
      const m = top.date.getMonth();
      if (m !== lastMonth) {
        labels.push(MONTH_LABELS[m] ?? null);
        lastMonth = m;
      } else {
        labels.push(null);
      }
    }
    return labels;
  }, [columns]);

  const colWidth = cellSize + cellGap;
  const rowHeight = cellSize + cellGap;
  const gridWidth = weeks * colWidth - cellGap;
  const gridHeight = 7 * rowHeight - cellGap;

  // Tooltip placement — show beneath the cell, clamped to the grid edges.
  const tooltipFor = hovered
    ? (() => {
        const cell = columns[hovered.col]?.[hovered.row];
        if (!cell) return null;
        const left = hovered.col * colWidth + cellSize / 2;
        const top = hovered.row * rowHeight + cellSize + 6;
        return { cell, left, top };
      })()
    : null;

  return (
    <div className="inline-flex flex-col gap-2 text-foreground">
      <div className="flex gap-2">
        {/* Day-of-week labels (Mon / Wed / Fri only) */}
        <div
          className="flex flex-col"
          style={{ paddingTop: 14 /* leave room for month row */ }}
        >
          {DAY_LABELS.map((label, idx) => {
            const visible = idx === 0 || idx === 2 || idx === 4; // Mon, Wed, Fri
            return (
              <div
                key={label}
                className="flex items-center justify-end pr-1 text-[10px] text-muted-foreground"
                style={{ height: cellSize, marginBottom: idx === 6 ? 0 : cellGap }}
              >
                {visible ? label : ""}
              </div>
            );
          })}
        </div>

        {/* Grid + month labels */}
        <div className="flex flex-col">
          <div
            className="relative"
            style={{ width: gridWidth, height: 14 }}
            aria-hidden
          >
            {monthLabels.map((label, col) =>
              label ? (
                <span
                  key={`${label}-${col}`}
                  className="absolute top-0 text-[10px] text-muted-foreground"
                  style={{ left: col * colWidth }}
                >
                  {label}
                </span>
              ) : null,
            )}
          </div>

          <div
            className="relative"
            style={{ width: gridWidth, height: gridHeight }}
            onMouseLeave={() => setHovered(null)}
          >
            {columns.map((col, colIdx) =>
              col.map((cell, rowIdx) => {
                const isFuture = cell.date.getTime() > Date.now();
                const cls = BUCKET_CLASS[cell.bucket] ?? BUCKET_CLASS[0];
                const interactive = !!onCellClick && !isFuture;
                return (
                  <button
                    key={cell.key}
                    type="button"
                    aria-label={`${cell.count} events on ${humanDate(cell.date)}`}
                    disabled={isFuture}
                    onMouseEnter={() => setHovered({ col: colIdx, row: rowIdx })}
                    onFocus={() => setHovered({ col: colIdx, row: rowIdx })}
                    onBlur={() => setHovered(null)}
                    onClick={
                      interactive
                        ? () =>
                            onCellClick?.({
                              date: cell.key,
                              count: cell.count,
                            })
                        : undefined
                    }
                    className={`absolute rounded-[2px] transition-opacity ${cls} ${
                      interactive
                        ? "cursor-pointer hover:opacity-80"
                        : "cursor-default"
                    } ${isFuture ? "opacity-30" : ""}`}
                    style={{
                      left: colIdx * colWidth,
                      top: rowIdx * rowHeight,
                      width: cellSize,
                      height: cellSize,
                    }}
                  />
                );
              }),
            )}

            {tooltipFor ? (
              <div
                role="tooltip"
                className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-meta text-foreground shadow-sm"
                style={{ left: tooltipFor.left, top: tooltipFor.top }}
              >
                <span className="font-medium">{tooltipFor.cell.count}</span>{" "}
                <span className="text-muted-foreground">
                  {tooltipFor.cell.count === 1 ? "event" : "events"} on{" "}
                  {humanDate(tooltipFor.cell.date)}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
        <span>Less</span>
        {BUCKET_CLASS.map((cls, i) => (
          <span
            key={i}
            className={`rounded-[2px] ${cls}`}
            style={{ width: cellSize, height: cellSize }}
            aria-hidden
          />
        ))}
        <span>More</span>
        {max > 0 ? (
          <span className="ml-2 text-muted-foreground/70">peak {max}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A small synthetic dataset for previews and tests. Generates the last
 * ~12 weeks with a gentle weekday bias so the heatmap looks alive
 * without any backing data.
 */
export const SAMPLE_HEATMAP_DATA: ActivityHeatmapDay[] = (() => {
  const out: ActivityHeatmapDay[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < 12 * 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dow = d.getDay(); // 0 Sun .. 6 Sat
    // Cheap deterministic pseudo-random so the export stays stable.
    const seed = (d.getFullYear() * 372 + (d.getMonth() + 1) * 31 + d.getDate()) % 97;
    const weekendBias = dow === 0 || dow === 6 ? 0.2 : 1;
    const raw = Math.floor((seed % 14) * weekendBias);
    out.push({
      date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
      count: raw,
    });
  }
  return out;
})();
