"use client";
import {
  Play,
  ArrowRight,
  Wrench,
  MessageSquare,
  Pause,
  Check,
  X as XIcon,
  Hourglass,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Vertical event timeline used inside Mission Control's RunRow when the
 * user expands a run.
 *
 * Visually a stepper: a thin warm hairline connecting circular kind
 * glyphs, with a relative-time stamp + optional payload preview to the
 * right of each row. The freshest event (top of the list) gets an ember
 * pulse so the eye catches "this is what's happening right now."
 *
 * Pure presentation — events come from `agentRun.events` upstream.
 */

export type RunTimelineEvent = {
  id: string;
  kind: string;
  createdAt: Date | string;
  payload?: unknown;
};

const KIND_GLYPH: Record<string, typeof Play> = {
  STARTED: Play,
  STEP: ArrowRight,
  TOOL_CALL: Wrench,
  STATUS: MessageSquare,
  COMMENT: MessageSquare,
  TRANSITION: ArrowRight,
  DISPATCH_RECEIVED: Play,
  BLOCKED: Pause,
  COMPLETED: Check,
  ABANDONED: XIcon,
  ERRORED: XIcon,
  STALLED: Hourglass,
};

const KIND_TINT: Record<string, string> = {
  STARTED: "text-ember",
  STEP: "text-foreground/70",
  TOOL_CALL: "text-foreground/60",
  STATUS: "text-ember",
  COMMENT: "text-indigo-500",
  TRANSITION: "text-foreground/70",
  DISPATCH_RECEIVED: "text-ember",
  BLOCKED: "text-amber-500",
  COMPLETED: "text-emerald-600",
  ABANDONED: "text-muted-foreground",
  ERRORED: "text-rose-600",
  STALLED: "text-amber-500",
};

function relativeTime(input: Date | string): string {
  const t = typeof input === "string" ? new Date(input) : input;
  const ms = Date.now() - t.getTime();
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function previewPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.preview === "string") return p.preview;
  if (typeof p.currentStep === "string") return p.currentStep;
  if (typeof p.eventKind === "string" && p.eventKind !== "") return String(p.eventKind);
  return null;
}

export function RunTimeline({
  events,
  className,
}: {
  events: RunTimelineEvent[];
  className?: string;
}) {
  if (events.length === 0) {
    return (
      <div className={cn("py-2 pl-7 text-meta text-muted-foreground", className)}>
        No events yet.
      </div>
    );
  }

  return (
    <ol className={cn("relative space-y-1.5 py-1.5", className)}>
      {/* Spine connecting the glyphs — sits behind them. */}
      <div
        aria-hidden
        className="absolute left-[10px] top-2.5 bottom-2.5 w-px bg-border"
      />
      {events.map((evt, i) => {
        const Glyph = KIND_GLYPH[evt.kind] ?? Activity;
        const tint = KIND_TINT[evt.kind] ?? "text-muted-foreground";
        const preview = previewPayload(evt.payload);
        const isFreshest = i === 0;
        return (
          <li
            key={evt.id}
            className="relative flex items-start gap-2 pl-0.5"
          >
            <span
              className={cn(
                "relative z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border bg-card",
                isFreshest
                  ? "border-ember/60 ring-2 ring-ember/15"
                  : "border-border",
              )}
            >
              {isFreshest && (
                <span className="absolute inset-0 animate-ping rounded-full bg-ember/30" />
              )}
              <Glyph className={cn("relative h-3 w-3", tint)} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-foreground">
                  {evt.kind}
                </span>
                <span className="text-meta text-muted-foreground">
                  {relativeTime(evt.createdAt)}
                </span>
              </div>
              {preview && (
                <div className="truncate text-meta text-foreground/70">{preview}</div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
