"use client";

import type { DataBlockListPayload } from "./data-block-parser";

/**
 * Ordered or unordered list with optional per-item badges. Looks like
 * the renderer's stock list so it sits naturally next to prose lists,
 * but the badge slot gives agents a way to attach a one-token tag
 * (status, count, priority) without dropping into a table.
 */
export function DataBlockList({ payload }: { payload: DataBlockListPayload }) {
  const Tag = payload.ordered ? "ol" : "ul";
  return (
    <Tag
      className={`my-2 space-y-0.5 rounded-md border border-border bg-card/30 px-3 py-2 ${
        payload.ordered ? "ml-0 list-decimal pl-5 marker:font-mono marker:text-muted-foreground" : ""
      }`}
    >
      {payload.items.map((it, i) => {
        const text = typeof it === "string" ? it : it.text;
        const badge = typeof it === "string" ? null : (it.badge ?? null);
        if (payload.ordered) {
          return (
            <li key={i} className="pl-0.5">
              <span className="text-foreground/90">{text}</span>
              {badge ? <BadgeChip text={badge} /> : null}
            </li>
          );
        }
        return (
          <li key={i} className="flex items-start gap-2">
            <span aria-hidden className="mt-1 shrink-0 text-ember/80">
              •
            </span>
            <span className="flex-1 text-foreground/90">{text}</span>
            {badge ? <BadgeChip text={badge} /> : null}
          </li>
        );
      })}
    </Tag>
  );
}

function BadgeChip({ text }: { text: string }) {
  return (
    <span className="ml-2 inline-flex items-center rounded border border-border bg-subtle/60 px-1.5 py-0 font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
      {text}
    </span>
  );
}
