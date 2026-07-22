"use client";
import {
  Play,
  ArrowRight,
  Wrench,
  MessageSquare,
  Bell,
  Pause,
  Check,
  X as XIcon,
  Hourglass,
  Activity,
  ChevronDown,
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
  DISPATCH_STARTED: Play,
  WAKE_DELIVERED: Bell,
  ACK: Check,
  STEP: ArrowRight,
  TOOL_CALL: Wrench,
  STATUS: MessageSquare,
  COMMENT: MessageSquare,
  TRANSITION: ArrowRight,
  DISPATCH_RECEIVED: Play,
  MODE_CHANGED: ArrowRight,
  WAITING: Pause,
  BLOCKED: Pause,
  COMPLETED: Check,
  ABANDONED: XIcon,
  ERRORED: XIcon,
  STALLED: Hourglass,
};

const KIND_TINT: Record<string, string> = {
  STARTED: "text-ember",
  DISPATCH_STARTED: "text-ember",
  WAKE_DELIVERED: "text-ember",
  ACK: "text-emerald-600",
  STEP: "text-foreground/70",
  TOOL_CALL: "text-foreground/60",
  STATUS: "text-ember",
  COMMENT: "text-indigo-500",
  TRANSITION: "text-foreground/70",
  DISPATCH_RECEIVED: "text-ember",
  MODE_CHANGED: "text-foreground/70",
  WAITING: "text-amber-500",
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
  if (typeof p.eventKind === "string" && p.eventKind !== "") {
    return `from ${humanizeEventName(p.eventKind).toLowerCase()}`;
  }
  if (typeof p.externalRunId === "string" && p.externalRunId !== "") {
    const engine = typeof p.engine === "string" ? p.engine : "runtime";
    return `${engine} ${p.externalRunId}`;
  }
  if (typeof p.from === "string" && typeof p.to === "string") {
    return `${p.from.toLowerCase()} -> ${p.to.toLowerCase()}`;
  }
  if (typeof p.preview === "string") return p.preview;
  if (typeof p.currentStep === "string") return p.currentStep;
  if (typeof p.thinking === "string") return p.thinking;
  if (typeof p.summary === "string") return p.summary;
  if (typeof p.description === "string") return p.description;
  if (typeof p.lastEvent === "string") return humanizeEventName(p.lastEvent);
  if (typeof p.tool === "string") {
    const state = p.done === true ? (p.error === true ? "failed" : "completed") : "started";
    return `${p.tool} ${state}`;
  }
  return null;
}

function humanizeEventName(value: string): string {
  return value.replace(/[._-]+/g, " ").trim();
}

function eventTitle(evt: RunTimelineEvent): string {
  const payload =
    evt.payload && typeof evt.payload === "object"
      ? (evt.payload as Record<string, unknown>)
      : null;
  switch (evt.kind) {
    case "STARTED":
      return "run opened";
    case "DISPATCH_STARTED":
      return "runtime started";
    case "WAKE_DELIVERED":
      return "wake delivered";
    case "ACK":
      return "agent acknowledged";
    case "STATUS":
      return "status output";
    case "COMMENT":
      return "agent replied";
    case "TRANSITION":
      return "issue moved";
    case "MODE_CHANGED":
      return "mode changed";
    case "WAITING":
      return "waiting on operator";
    case "BLOCKED":
      return "run blocked";
    case "COMPLETED":
      return "run completed";
    case "ABANDONED":
      return "run stopped";
    case "ERRORED":
      return "run errored";
    case "STALLED":
      return "run stalled";
    default:
      break;
  }
  if (evt.kind === "TOOL_CALL" && typeof payload?.tool === "string") {
    if (payload.done === true) {
      return payload.error === true ? "tool failed" : "tool completed";
    }
    return "tool started";
  }
  if (evt.kind === "STEP" && typeof payload?.thinking === "string") return "progress detail";
  if (evt.kind === "STEP" && typeof payload?.currentStep === "string") {
    return humanizeEventName(payload.currentStep);
  }
  if (evt.kind === "STEP" && typeof payload?.lastEvent === "string") {
    return humanizeEventName(payload.lastEvent);
  }
  return evt.kind === "STEP" ? "step update" : humanizeEventName(evt.kind).toLowerCase();
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
      <div className={cn("text-meta py-2 pl-7 text-muted-foreground", className)}>
        No events yet.
      </div>
    );
  }

  return (
    <ol className={cn("relative space-y-1.5 py-1.5", className)}>
      {/* Spine connecting the glyphs — sits behind them. */}
      <div aria-hidden className="absolute bottom-2.5 left-[10px] top-2.5 w-px bg-border" />
      {events.map((evt, i) => {
        const Glyph = KIND_GLYPH[evt.kind] ?? Activity;
        const tint = KIND_TINT[evt.kind] ?? "text-muted-foreground";
        const title = eventTitle(evt);
        const rawPreview = previewPayload(evt.payload);
        const preview = rawPreview && rawPreview !== title ? rawPreview : null;
        const isFreshest = i === 0;
        return (
          <li key={evt.id} className="relative flex items-start gap-2 pl-0.5">
            <span
              className={cn(
                "relative z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border bg-card",
                isFreshest ? "border-ember/60 ring-2 ring-ember/15" : "border-border",
              )}
            >
              {isFreshest && (
                <span className="absolute inset-0 animate-ping rounded-full bg-ember/30" />
              )}
              <Glyph className={cn("relative h-3 w-3", tint)} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[0.6875rem] font-medium uppercase tracking-wider text-foreground">
                  {title}
                </span>
                <span className="text-meta text-muted-foreground">
                  {relativeTime(evt.createdAt)}
                </span>
              </div>
              {preview && preview.length > 120 ? (
                <details className="group mt-0.5">
                  <summary className="focus-ring flex cursor-pointer list-none items-start gap-1 rounded-sm text-foreground/70 marker:hidden">
                    <span className="text-meta line-clamp-2 min-w-0 flex-1 break-words">
                      {preview}
                    </span>
                    <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="text-meta mt-1 whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/50 px-2 py-1.5 text-foreground/80">
                    {preview}
                  </div>
                </details>
              ) : preview ? (
                <div className="text-meta break-words text-foreground/70">{preview}</div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
