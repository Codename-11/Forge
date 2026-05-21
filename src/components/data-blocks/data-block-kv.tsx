"use client";

import type { DataBlockKVPayload } from "./data-block-parser";

/**
 * Compact key/value strip for metadata dumps. Two-column when wide,
 * stacks on narrow viewports. Designed to sit inline inside comments
 * without dominating the line height like a full table.
 */
export function DataBlockKV({ payload }: { payload: DataBlockKVPayload }) {
  const entries: { key: string; value: string | number | boolean | null }[] =
    Array.isArray(payload.pairs)
      ? payload.pairs
      : Object.entries(payload.pairs).map(([key, value]) => ({ key, value }));

  return (
    <div className="my-2 rounded-md border border-border bg-card/30">
      {payload.caption ? (
        <div className="border-b border-border/60 bg-card/60 px-3 py-1 text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground">
          {payload.caption}
        </div>
      ) : null}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 px-3 py-2 text-[0.8125rem] sm:grid-cols-[max-content_1fr]">
        {entries.map((e, i) => (
          <div
            key={i}
            className="contents"
          >
            <dt className="font-mono text-[0.75rem] text-muted-foreground">
              {e.key}
            </dt>
            <dd className="text-foreground/90 break-words">
              {renderValue(e.value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function renderValue(v: string | number | boolean | null) {
  if (v === null) {
    return <span className="text-muted-foreground/60">—</span>;
  }
  if (typeof v === "boolean") {
    return (
      <span className={v ? "text-ember" : "text-muted-foreground"}>
        {v ? "✓ true" : "✗ false"}
      </span>
    );
  }
  return String(v);
}
