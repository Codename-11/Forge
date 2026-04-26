"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * TimelineScrubber — a self-contained, draggable time-range scrubber for
 * Mission Control. Renders a horizontal "last `rangeMs`" track with event
 * markers, a draggable window-rect overlay (`windowMs` wide), and a
 * 10-minute tick axis along the bottom.
 *
 * Pure presentation: no tRPC, no realtime, no router. Caller passes in
 * events and gets `(start, end)` callbacks when the scrub window moves.
 *
 * Visual style matches Forge's warm earthy tokens — `bg-card/40` track,
 * thin warm border, `bg-ember` accents, no drop shadows.
 */

export type ScrubberEvent = {
  id: string;
  /** Event timestamp (ISO string or Date). */
  ts: string | Date;
  /** Event kind. STARTED / STEP / TOOL_CALL / STATUS / BLOCKED / COMPLETED / ERRORED / STALLED. */
  kind: string;
  agentName: string;
  /** Issue key like "AXI-31", or null if unrelated to a specific issue. */
  issueKey: string | null;
  /** Optional short human label. */
  label?: string;
};

type TimelineScrubberProps = {
  events: ScrubberEvent[];
  /** Width of the scrub window in milliseconds. Default 5min. */
  windowMs?: number;
  /** Total visible time range, anchored at "now". Default 60min. */
  rangeMs?: number;
  /** Fires (debounced via rAF) whenever the scrub window moves. */
  onWindowChange?: (start: number, end: number) => void;
  /** Fires when an event marker is clicked (not the window itself). */
  onEventClick?: (event: ScrubberEvent) => void;
  /** Track height in pixels. Default 80. */
  height?: number;
};

const TICK_INTERVAL_MS = 10 * 60_000; // 10 minutes
const NOW_REFRESH_MS = 10_000; // re-snapshot "now" every 10s
const MARKER_HEIGHT = 4;
const MARKER_HEIGHT_ELEVATED = 6; // 1.5×
const MARKER_WIDTH = 2;

/** Color class per event kind. Falls through to a muted default. */
function markerColorClass(kind: string): string {
  const k = kind.toUpperCase();
  switch (k) {
    case "STARTED":
    case "STEP":
    case "STATUS":
    case "COMPLETED":
      return "bg-ember";
    case "TOOL_CALL":
      return "bg-foreground/60";
    case "BLOCKED":
    case "ERRORED":
    case "STALLED":
      return "bg-amber-500";
    default:
      return "bg-muted-foreground/50";
  }
}

/** Format a relative offset (negative = in the past). e.g. "-3m 12s ago", "now". */
function formatRelative(offsetMs: number): string {
  const abs = Math.abs(offsetMs);
  if (abs < 5_000) return "now";
  if (abs < 60_000) return `${Math.floor(abs / 1000)}s ago`;
  if (abs < 3_600_000) {
    const m = Math.floor(abs / 60_000);
    const s = Math.floor((abs % 60_000) / 1000);
    return s > 0 ? `${m}m ${s}s ago` : `${m}m ago`;
  }
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
}

/** Tick label like "-60m", "-50m", …, "-10m", "now". */
function tickLabel(offsetFromNowMs: number): string {
  if (offsetFromNowMs >= 0) return "now";
  const m = Math.round(-offsetFromNowMs / 60_000);
  return `-${m}m`;
}

/** Convert an event ts to a millisecond timestamp. */
function tsToMs(ts: string | Date): number {
  return ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
}

export function TimelineScrubber({
  events,
  windowMs = 5 * 60_000,
  rangeMs = 60 * 60_000,
  onWindowChange,
  onEventClick,
  height = 80,
}: TimelineScrubberProps): JSX.Element {
  // "now" snapshot — refreshed on an interval so markers slide left.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), NOW_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // Track ref for measuring pixel width during drag.
  const trackRef = useRef<HTMLDivElement | null>(null);

  // Window position is stored as a millisecond offset from `now` — i.e.
  // `windowEndOffsetMs` is how far the right edge of the window sits from
  // "now". 0 means the window is pinned to the right edge (latest). We
  // store offset rather than absolute ms so the window keeps its visual
  // position when "now" advances.
  // Range: [0, rangeMs - windowMs]. Default = 0 (rightmost).
  const [windowEndOffsetMs, setWindowEndOffsetMs] = useState<number>(0);

  // Drag state — pointerdown captures the starting offset and pointer X,
  // pointermove updates the offset based on delta, pointerup ends.
  const dragStateRef = useRef<{
    startPointerX: number;
    startOffsetMs: number;
    trackWidthPx: number;
  } | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const pendingOffsetRef = useRef<number | null>(null);

  // Cap window offset so the window stays inside [0, rangeMs - windowMs].
  const maxOffsetMs = Math.max(0, rangeMs - windowMs);

  // Compute absolute window bounds.
  const windowEndMs = now - windowEndOffsetMs;
  const windowStartMs = windowEndMs - windowMs;

  // Notify parent (debounced via rAF) whenever bounds change. We schedule
  // through rAF so a fast drag doesn't fire 60+ callbacks/frame.
  const onWindowChangeRef = useRef(onWindowChange);
  useEffect(() => {
    onWindowChangeRef.current = onWindowChange;
  }, [onWindowChange]);

  useEffect(() => {
    if (!onWindowChangeRef.current) return;
    const id = requestAnimationFrame(() => {
      onWindowChangeRef.current?.(windowStartMs, windowEndMs);
    });
    return () => cancelAnimationFrame(id);
  }, [windowStartMs, windowEndMs]);

  // ---- Drag handlers ------------------------------------------------

  const flushPendingOffset = useCallback(() => {
    rafIdRef.current = null;
    if (pendingOffsetRef.current == null) return;
    const next = pendingOffsetRef.current;
    pendingOffsetRef.current = null;
    setWindowEndOffsetMs(next);
  }, []);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      dragStateRef.current = {
        startPointerX: e.clientX,
        startOffsetMs: windowEndOffsetMs,
        trackWidthPx: rect.width,
      };
      e.preventDefault();
      e.stopPropagation();
    },
    [windowEndOffsetMs],
  );

  useEffect(() => {
    function handleMove(e: PointerEvent) {
      const drag = dragStateRef.current;
      if (!drag) return;
      const dxPx = e.clientX - drag.startPointerX;
      // Pixel→ms conversion. The track represents `rangeMs`. Dragging
      // the window *right* moves it toward "now" (smaller offset), so
      // an increase in pointer X corresponds to a decrease in offset.
      const dxMs = (dxPx / drag.trackWidthPx) * rangeMs;
      const next = clamp(drag.startOffsetMs - dxMs, 0, maxOffsetMs);
      pendingOffsetRef.current = next;
      if (rafIdRef.current == null) {
        rafIdRef.current = requestAnimationFrame(flushPendingOffset);
      }
    }
    function handleUp() {
      dragStateRef.current = null;
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
        flushPendingOffset();
      }
    }
    document.addEventListener("pointermove", handleMove);
    document.addEventListener("pointerup", handleUp);
    document.addEventListener("pointercancel", handleUp);
    return () => {
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerup", handleUp);
      document.removeEventListener("pointercancel", handleUp);
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [rangeMs, maxOffsetMs, flushPendingOffset]);

  // ---- Layout math --------------------------------------------------

  // Track represents (now - rangeMs) → now, left → right. Convert a
  // timestamp to a percentage along the track. Returns null if outside.
  const tsToPercent = useCallback(
    (tsMs: number): number | null => {
      const offsetFromNow = now - tsMs;
      if (offsetFromNow < 0 || offsetFromNow > rangeMs) return null;
      // 0% = oldest (left edge = now - rangeMs); 100% = now (right edge).
      return ((rangeMs - offsetFromNow) / rangeMs) * 100;
    },
    [now, rangeMs],
  );

  // Window rect bounds as percentages of the track.
  const windowLeftPct = useMemo(() => {
    return ((rangeMs - windowMs - windowEndOffsetMs) / rangeMs) * 100;
  }, [rangeMs, windowMs, windowEndOffsetMs]);
  const windowWidthPct = (windowMs / rangeMs) * 100;

  // Tick positions: -rangeMs, -rangeMs + interval, … 0. Build once per
  // (now, rangeMs) tuple.
  const ticks = useMemo(() => {
    const out: { pct: number; label: string }[] = [];
    // We render a tick at every TICK_INTERVAL_MS step from "now" backward.
    for (let off = 0; off <= rangeMs; off += TICK_INTERVAL_MS) {
      const pct = ((rangeMs - off) / rangeMs) * 100;
      out.push({ pct, label: tickLabel(-off) });
    }
    return out;
  }, [rangeMs]);

  // Pre-filter events to those visible on the track and pre-compute
  // their pct positions + window membership.
  const visibleEvents = useMemo(() => {
    type Visible = {
      event: ScrubberEvent;
      tsMs: number;
      pct: number;
      inWindow: boolean;
    };
    const out: Visible[] = [];
    for (const ev of events) {
      const tsMs = tsToMs(ev.ts);
      if (Number.isNaN(tsMs)) continue;
      const pct = tsToPercent(tsMs);
      if (pct == null) continue;
      const inWindow = tsMs >= windowStartMs && tsMs <= windowEndMs;
      out.push({ event: ev, tsMs, pct, inWindow });
    }
    return out;
  }, [events, tsToPercent, windowStartMs, windowEndMs]);

  // ---- Render -------------------------------------------------------

  // Reserve 18px at the bottom for tick labels; the marker lane sits in
  // the area above. The track outer height is `height` (prop).
  const labelLaneHeight = 18;
  const markerLaneHeight = Math.max(0, height - labelLaneHeight);

  const containerStyle: CSSProperties = { height };

  return (
    <div
      className="relative w-full select-none rounded-md border border-border bg-card/40"
      style={containerStyle}
      data-testid="timeline-scrubber"
    >
      {/* Track surface — pointer-events on the inner div so click-on-event
          works without interfering with window drag. */}
      <div
        ref={trackRef}
        className="relative h-full w-full"
      >
        {/* Tick lane (bottom) — labels + tiny vertical hairlines. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0"
          style={{ height: labelLaneHeight }}
        >
          {ticks.map((t) => (
            <div
              key={`tick-${t.label}-${t.pct}`}
              className="absolute top-0 flex h-full -translate-x-1/2 flex-col items-center"
              style={{ left: `${t.pct}%` }}
            >
              <span className="block h-1 w-px bg-border" />
              <span className="mt-0.5 text-[10px] text-muted-foreground">
                {t.label}
              </span>
            </div>
          ))}
        </div>

        {/* Marker lane — positioned above the tick lane. Markers sit on a
            shared baseline so elevated (in-window) ones grow upward. */}
        <div
          className="absolute inset-x-0 top-0"
          style={{ height: markerLaneHeight }}
        >
          {/* Faint horizontal baseline for visual grounding. */}
          <span
            className="pointer-events-none absolute inset-x-0 bg-border/60"
            style={{
              bottom: 0,
              height: 1,
            }}
          />

          {visibleEvents.map(({ event, tsMs, pct, inWindow }) => {
            const barHeight = inWindow
              ? MARKER_HEIGHT_ELEVATED
              : MARKER_HEIGHT;
            const colorClass = markerColorClass(event.kind);
            const offsetFromNow = tsMs - now;
            const tooltip = [
              event.agentName,
              event.issueKey ?? null,
              event.kind,
              formatRelative(offsetFromNow),
            ]
              .filter((x): x is string => Boolean(x))
              .join(" · ");
            return (
              <button
                key={event.id}
                type="button"
                title={tooltip}
                aria-label={tooltip}
                onClick={(e) => {
                  // Don't let the click bubble into the window-drag layer.
                  e.stopPropagation();
                  onEventClick?.(event);
                }}
                onPointerDown={(e) => {
                  // Prevent the marker click from initiating a window drag.
                  e.stopPropagation();
                }}
                className={`absolute block rounded-[1px] transition-colors hover:opacity-100 ${colorClass} ${
                  inWindow ? "opacity-100" : "opacity-80"
                }`}
                style={{
                  left: `${pct}%`,
                  bottom: 0,
                  width: MARKER_WIDTH,
                  height: barHeight,
                  transform: "translateX(-50%)",
                }}
              />
            );
          })}
        </div>

        {/* Window rect overlay — draggable. Sits above markers but its
            pointer handlers stop propagation so marker clicks still win
            when the user clicks slightly outside the rect. The rect
            itself is the drag handle; the grip-dots are decorative. */}
        <div
          role="slider"
          aria-label="Scrub window"
          aria-valuemin={0}
          aria-valuemax={Math.round(rangeMs / 1000)}
          aria-valuenow={Math.round((rangeMs - windowEndOffsetMs) / 1000)}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          className="absolute cursor-grab rounded-sm bg-ember/15 ring-1 ring-ember/40 transition-colors hover:bg-ember/20 active:cursor-grabbing"
          style={{
            left: `${windowLeftPct}%`,
            width: `${windowWidthPct}%`,
            top: 2,
            // Cover the marker lane but leave the tick labels visible.
            height: Math.max(0, markerLaneHeight - 2),
          }}
        >
          {/* Grip handle — three vertical dots at the left edge. */}
          <span
            className="pointer-events-none absolute left-1 top-1/2 flex -translate-y-1/2 flex-col gap-[2px]"
            aria-hidden="true"
          >
            <span className="h-[2px] w-[2px] rounded-full bg-ember/80" />
            <span className="h-[2px] w-[2px] rounded-full bg-ember/80" />
            <span className="h-[2px] w-[2px] rounded-full bg-ember/80" />
          </span>
        </div>
      </div>
    </div>
  );
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// ----------------------------------------------------------------------
// Sample data — handy for stories / quick visual smoke-testing. Generated
// at module load so the timestamps are always recent relative to "now".
// ----------------------------------------------------------------------

/**
 * Synthetic event stream covering the last hour. Mix of kinds, two
 * agents, two issues — plenty of density to exercise the scrubber.
 */
export const SAMPLE_SCRUBBER_EVENTS: ScrubberEvent[] = (() => {
  const now = Date.now();
  const mins = (n: number) => now - n * 60_000;
  return [
    {
      id: "s1",
      ts: new Date(mins(58)),
      kind: "STARTED",
      agentName: "victor",
      issueKey: "AXI-31",
      label: "Picked up triage",
    },
    {
      id: "s2",
      ts: new Date(mins(56)),
      kind: "STEP",
      agentName: "victor",
      issueKey: "AXI-31",
      label: "Reading repo layout",
    },
    {
      id: "s3",
      ts: new Date(mins(52)),
      kind: "TOOL_CALL",
      agentName: "victor",
      issueKey: "AXI-31",
      label: "grep -R 'autoDispatch'",
    },
    {
      id: "s4",
      ts: new Date(mins(47)),
      kind: "STATUS",
      agentName: "victor",
      issueKey: "AXI-31",
      label: "Drafting plan",
    },
    {
      id: "s5",
      ts: new Date(mins(40)),
      kind: "BLOCKED",
      agentName: "victor",
      issueKey: "AXI-31",
      label: "Waiting on schema clarification",
    },
    {
      id: "s6",
      ts: new Date(mins(35)),
      kind: "STARTED",
      agentName: "mizu",
      issueKey: "WRK-7",
      label: "Marketing copy review",
    },
    {
      id: "s7",
      ts: new Date(mins(31)),
      kind: "TOOL_CALL",
      agentName: "mizu",
      issueKey: "WRK-7",
    },
    {
      id: "s8",
      ts: new Date(mins(26)),
      kind: "STEP",
      agentName: "mizu",
      issueKey: "WRK-7",
      label: "Iterating on tagline",
    },
    {
      id: "s9",
      ts: new Date(mins(20)),
      kind: "STALLED",
      agentName: "victor",
      issueKey: "AXI-31",
      label: "No progress for 5m",
    },
    {
      id: "s10",
      ts: new Date(mins(14)),
      kind: "STEP",
      agentName: "victor",
      issueKey: "AXI-31",
      label: "Resumed after unblock",
    },
    {
      id: "s11",
      ts: new Date(mins(9)),
      kind: "TOOL_CALL",
      agentName: "victor",
      issueKey: "AXI-31",
      label: "Apply Edit",
    },
    {
      id: "s12",
      ts: new Date(mins(6)),
      kind: "STATUS",
      agentName: "victor",
      issueKey: "AXI-31",
      label: "Tests passing",
    },
    {
      id: "s13",
      ts: new Date(mins(4)),
      kind: "COMPLETED",
      agentName: "mizu",
      issueKey: "WRK-7",
      label: "Approved",
    },
    {
      id: "s14",
      ts: new Date(mins(2)),
      kind: "ERRORED",
      agentName: "victor",
      issueKey: null,
      label: "Webhook delivery failed",
    },
    {
      id: "s15",
      ts: new Date(mins(0.5)),
      kind: "COMPLETED",
      agentName: "victor",
      issueKey: "AXI-31",
      label: "Shipped",
    },
  ];
})();
