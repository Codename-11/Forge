"use client";

import { useState } from "react";
import { HelpCircle } from "lucide-react";
import type { AutoDispatchMode } from "@prisma/client";
import { cn } from "@/lib/utils";
import { DispatchModeBadge } from "@/components/dispatch-mode-badge";

/**
 * `DispatchReasonChip` — small "Why?" pill that surfaces the
 * dispatcher's decision provenance. The blob is the same shape
 * persisted on `Issue.dispatchReason` and mirrored on the
 * AGENT_ASSIGNED event payload (see `dispatcher.ts`).
 *
 * Click / hover reveals a panel with:
 *   - DispatchModeBadge for the picker mode.
 *   - One-line `reasonText` (e.g. "round-robin: least-recently-
 *     dispatched among 4 eligible").
 *   - Compact list of profileKeys considered, with the winner
 *     highlighted.
 *   - Decided-at relative timestamp.
 *
 * The chip is intentionally read-only — it doesn't expose any
 * mutation. Settings affordance lives on `DispatchModeBadge`'s
 * own `showSettingsLink` flag, which we don't enable here (the
 * chip is a context surface, not a configuration path).
 */
export type DispatchReason = {
  /**
   * AutoDispatchMode value OR free-form string ("RULE",
   * "MANUAL", "MANUAL_REDIRECT") emitted by the dispatcher when
   * a non-mode-driven path fired.
   */
  mode: AutoDispatchMode | string;
  candidatesConsidered: string[];
  picked: string;
  reasonText: string;
  decidedAt: string;
  ruleId?: string;
};

const DISPATCH_MODES: ReadonlyArray<AutoDispatchMode> = [
  "MANUAL_ONLY",
  "ROUND_ROBIN",
  "PRIORITY_MATCH",
  "CAPABILITY_MATCH",
];

function isAutoDispatchMode(v: string): v is AutoDispatchMode {
  return DISPATCH_MODES.includes(v as AutoDispatchMode);
}

export function DispatchReasonChip({
  reason,
  className,
}: {
  reason: DispatchReason;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label="Show dispatch reason"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={cn(
          "focus-ring inline-flex h-6 items-center gap-1 rounded-md border border-border bg-card/40 px-1.5 text-muted-foreground hover:bg-card hover:text-foreground",
          open && "bg-card text-foreground",
        )}
      >
        <HelpCircle className="h-3 w-3" aria-hidden />
        <span className="text-meta">Why?</span>
      </button>

      {open && (
        <div
          role="tooltip"
          className="absolute right-0 top-full z-30 mt-1 w-72 rounded-md border border-border bg-card p-2.5 shadow-md"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            {isAutoDispatchMode(reason.mode) ? (
              <DispatchModeBadge mode={reason.mode} />
            ) : (
              <span className="inline-flex items-center gap-1 rounded-md border border-border bg-card/40 px-2 py-1 text-meta text-foreground/90">
                {reason.mode === "RULE"
                  ? "Dispatch rule"
                  : reason.mode === "MANUAL"
                    ? "Manual"
                    : reason.mode === "MANUAL_REDIRECT"
                      ? "Redirect"
                      : reason.mode}
              </span>
            )}
            <span className="text-meta text-muted-foreground/80">
              {formatRelativeTime(reason.decidedAt)}
            </span>
          </div>

          <div className="text-[0.75rem] text-foreground/90">
            {reason.reasonText}
          </div>

          {reason.candidatesConsidered.length > 0 && (
            <div className="mt-2">
              <div className="text-meta text-muted-foreground">
                Candidates
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {reason.candidatesConsidered.map((profileKey) => {
                  const isWinner = profileKey === reason.picked;
                  return (
                    <span
                      key={profileKey}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono",
                        "text-id",
                        isWinner
                          ? "border-ember/40 bg-ember/10 text-foreground"
                          : "border-border bg-card/40 text-muted-foreground",
                      )}
                      title={isWinner ? "Picked" : "Considered"}
                    >
                      <span aria-hidden>@</span>
                      {profileKey}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </span>
  );
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
