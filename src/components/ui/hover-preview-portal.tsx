"use client";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * Generic hover-preview portal. Wraps any clickable child (chip, link,
 * pill, etc.). On hover-in with a short delay, renders a popover via
 * `createPortal(document.body)` positioned underneath the wrapped
 * element — flipped up when there isn't enough room below.
 *
 * Architecture: this primitive owns the *positioning + open/close
 * lifecycle*. Callers supply the popover *content* through `render` so
 * each entity type (issue, agent, project, …) renders its own card.
 * The `IssueHoverPreview` / `AgentHoverPreview` / `EntityHoverPreview`
 * wrappers are thin shims on top.
 *
 * Why hand-rolled (no Radix / Floating UI)? Forge already ships a
 * tiny, dependency-free hover popover for `KEY-NN` chips; rebuilding
 * for each new chip type would mean three copies of the same delay /
 * portal / flip math. This module is the single source of truth.
 *
 * No-op on touch (`pointer: coarse` media query) — popovers are
 * mouse-only. Touch users tap to navigate, which the wrapped child
 * already handles.
 *
 * A11y: the popover gets `role="tooltip"` and an `id`; the wrapper
 * sets `aria-describedby` on the child container so SRs can pick up
 * the floating panel when the wrapped chip is focused.
 */

const HOVER_OPEN_DELAY_MS = 350;
const HOVER_CLOSE_DELAY_MS = 150;
const POPOVER_GAP_PX = 4;
const DEFAULT_WIDTH_PX = 280;

type Pos = { top: number; left: number; flipUp: boolean };

export type HoverPreviewPortalProps = {
  /**
   * Builds the popover content. Only invoked when `open` is true so
   * each card's data fetch (tRPC query) stays cold until needed.
   */
  render: () => ReactNode;
  /** Wrapped child — the chip / link / pill that triggers the popover. */
  children: ReactNode;
  /** Pixel width of the popover. Defaults to 280. */
  widthPx?: number;
  /** Override the wrapper element's classes (defaults to `relative inline`). */
  className?: string;
  /**
   * Optional aria role for the popover. Defaults to "tooltip". Use
   * "region" if the popover is interactive enough to warrant its own
   * landmark.
   */
  role?: "tooltip" | "region";
};

export function HoverPreviewPortal({
  render,
  children,
  widthPx = DEFAULT_WIDTH_PX,
  className,
  role = "tooltip",
}: HoverPreviewPortalProps) {
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const popoverId = useId();

  // Touch / coarse-pointer detection — popover is mouse-only.
  const [coarsePointer, setCoarsePointer] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse)");
    setCoarsePointer(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setCoarsePointer(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleOpen = useCallback(() => {
    if (coarsePointer) return;
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (open) return;
    if (openTimerRef.current !== null) return;
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      setOpen(true);
    }, HOVER_OPEN_DELAY_MS);
  }, [coarsePointer, open]);

  const scheduleClose = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (!open) return;
    if (closeTimerRef.current !== null) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  }, [open]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  // Close on scroll / resize — popover is anchored to a measured
  // position, so any layout shift invalidates it. Cheaper to close
  // and let the operator re-hover than to keep re-measuring.
  useEffect(() => {
    if (!open) return;
    const close = () => {
      clearTimers();
      setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, clearTimers]);

  // Position the popover relative to the wrapper. Measured after the
  // popover mounts so we know its actual height for the flip decision.
  useLayoutEffect(() => {
    if (!open || !wrapperRef.current) {
      setPos(null);
      return;
    }
    const wrap = wrapperRef.current.getBoundingClientRect();
    const popHeight = popoverRef.current?.getBoundingClientRect().height ?? 120;
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    const wantTop = wrap.bottom + POPOVER_GAP_PX;
    const wouldOverflowBottom = wantTop + popHeight > vpH - 8;
    const flipUp = wouldOverflowBottom && wrap.top - POPOVER_GAP_PX - popHeight > 8;
    let left = wrap.left;
    if (left + widthPx > vpW - 8) {
      left = Math.max(8, vpW - 8 - widthPx);
    }
    if (left < 8) left = 8;
    const top = flipUp
      ? Math.max(8, wrap.top - POPOVER_GAP_PX - popHeight)
      : wantTop;
    setPos({ top, left, flipUp });
  }, [open, widthPx]);

  return (
    <span
      ref={wrapperRef}
      className={cn("relative inline", className)}
      aria-describedby={open ? popoverId : undefined}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={scheduleOpen}
      onBlur={scheduleClose}
    >
      {children}
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popoverRef}
              id={popoverId}
              role={role}
              style={{
                position: "fixed",
                top: pos?.top ?? -9999,
                left: pos?.left ?? -9999,
                width: widthPx,
                // Hide until measured to avoid a one-frame top-left flash.
                visibility: pos ? "visible" : "hidden",
              }}
              className={cn(
                "z-50 rounded-lg border border-border bg-card shadow-xl",
                "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100",
              )}
              onMouseEnter={() => {
                if (closeTimerRef.current !== null) {
                  window.clearTimeout(closeTimerRef.current);
                  closeTimerRef.current = null;
                }
              }}
              onMouseLeave={scheduleClose}
            >
              {render()}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
