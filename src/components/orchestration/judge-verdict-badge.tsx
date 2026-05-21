"use client";
import { Check, X } from "lucide-react";
import { HoverPreviewPortal } from "@/components/ui/hover-preview-portal";
import { cn } from "@/lib/utils";
import type { JudgeVerdict } from "./types";

/**
 * Compact PASS/FAIL chip for a step's judge verdict.
 *
 * PASS → success check, FAIL → danger X. Score (0–1 or 0–100, whatever
 * the judge emits) shows inline when present. The full feedback string
 * is revealed on hover via the shared HoverPreviewPortal so the node
 * stays dense — the eye gets the verdict at a glance, the detail on
 * demand.
 */
export function JudgeVerdictBadge({
  verdict,
  className,
}: {
  verdict: JudgeVerdict;
  className?: string;
}) {
  const pass = verdict.verdict === "PASS";
  const score =
    verdict.score == null
      ? null
      : verdict.score <= 1
        ? Math.round(verdict.score * 100)
        : Math.round(verdict.score);

  const chip = (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border px-1 py-0 font-mono text-[0.5625rem] uppercase tracking-wide",
        pass
          ? "border-success/40 bg-success/10 text-success"
          : "border-danger/40 bg-danger/10 text-danger",
        className,
      )}
    >
      {pass ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
      {pass ? "pass" : "fail"}
      {score != null && <span className="opacity-80">{score}</span>}
    </span>
  );

  if (!verdict.feedback) return chip;

  return (
    <HoverPreviewPortal
      widthPx={260}
      render={() => (
        <div className="rounded-md border border-border bg-popover p-2.5 text-[0.75rem] shadow-md">
          <div
            className={cn(
              "mb-1 flex items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wider",
              pass ? "text-success" : "text-danger",
            )}
          >
            {pass ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            Judge {pass ? "passed" : "failed"}
            {score != null && (
              <span className="ml-auto font-mono text-muted-foreground">
                {score}
              </span>
            )}
          </div>
          <p className="whitespace-pre-wrap text-meta leading-snug text-muted-foreground">
            {verdict.feedback}
          </p>
        </div>
      )}
    >
      {chip}
    </HoverPreviewPortal>
  );
}
