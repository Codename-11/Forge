"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import type {
  DataBlockAlign,
  DataBlockTablePayload,
} from "./data-block-parser";

/**
 * Bordered table with sticky-header treatment. Header click toggles
 * sort direction (asc → desc → none). Sort is fully client-side and
 * lives in component state — re-renders of the parent reset it, which
 * is fine: agent payloads are normally short and re-render only on
 * comment-edit.
 */
export function DataBlockTable({ payload }: { payload: DataBlockTablePayload }) {
  const { headers, rows, align, caption } = payload;
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(
    null,
  );

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sort.col];
      const bv = b[sort.col];
      // Nulls and undefined sink to the bottom of asc.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv), undefined, {
        numeric: true,
        sensitivity: "base",
      }) * dir;
    });
  }, [rows, sort]);

  function toggle(col: number) {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      return null;
    });
  }

  return (
    <div className="my-2.5 overflow-hidden rounded-md border border-border bg-card/30">
      {caption ? (
        <div className="border-b border-border/60 bg-card/60 px-3 py-1 text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground">
          {caption}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[0.8125rem]">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-border bg-card/80 backdrop-blur">
              {headers.map((h, j) => {
                const a = align?.[j] ?? null;
                const isSorted = sort?.col === j;
                return (
                  <th
                    key={j}
                    aria-sort={
                      isSorted
                        ? sort!.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className={`px-2 py-1.5 text-foreground/90 font-semibold ${alignCls(a)}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(j)}
                      className={`focus-ring inline-flex items-center gap-1 rounded-sm py-0.5 hover:text-foreground ${
                        a === "right"
                          ? "flex-row-reverse"
                          : a === "center"
                            ? "mx-auto"
                            : ""
                      }`}
                      title={`Sort by ${h}`}
                    >
                      <span>{h}</span>
                      {isSorted ? (
                        sort!.dir === "asc" ? (
                          <ChevronUp className="h-3 w-3 text-ember" />
                        ) : (
                          <ChevronDown className="h-3 w-3 text-ember" />
                        )
                      ) : (
                        <ChevronsUpDown className="h-3 w-3 text-muted-foreground/40 group-hover:text-muted-foreground" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={Math.max(headers.length, 1)}
                  className="px-2 py-3 text-center text-muted-foreground"
                >
                  No rows
                </td>
              </tr>
            ) : (
              sortedRows.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-border/40 last:border-b-0 hover:bg-subtle/30"
                >
                  {headers.map((_, j) => {
                    const a = align?.[j] ?? null;
                    const cell = row[j] ?? null;
                    return (
                      <td
                        key={j}
                        className={`px-2 py-1.5 align-top text-foreground/90 ${alignCls(a)}`}
                      >
                        {renderCell(cell)}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderCell(value: string | number | boolean | null) {
  if (value === null) {
    return <span className="text-muted-foreground/60">—</span>;
  }
  if (typeof value === "boolean") {
    return value ? "✓" : "·";
  }
  return String(value);
}

function alignCls(a: DataBlockAlign | null): string {
  if (a === "right") return "text-right";
  if (a === "center") return "text-center";
  return "text-left";
}
