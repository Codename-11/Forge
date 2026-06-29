"use client";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * `AnchoredPopover` — a popover/menu that renders into `document.body` via
 * a portal, fixed-positioned off an anchor element's bounding rect. Use it
 * for any dropdown that would otherwise be clipped by an ancestor's
 * `overflow-hidden` / `overflow-y-auto` (scrollable lanes, cards, sidebars,
 * table rows). Because it lives at the body level it can never be clipped,
 * and clicks inside it don't bubble back through the anchor's DOM (so a row
 * link behind the trigger won't navigate).
 *
 * The caller owns the trigger + `open` state; this owns positioning,
 * flip-when-tight, outside-click, and Escape. Pass the trigger (or its
 * wrapper) as `anchorRef`. Style the popover box via `className` (width,
 * bg, border, padding) — positioning is applied inline.
 *
 * Hover popovers (tooltips): set `dismissOnOutsideClick={false}` and wire
 * `onMouseEnter` / `onMouseLeave` (plus matching handlers on the anchor) so
 * the pointer can cross the gap into the portaled panel without it closing.
 */
export function AnchoredPopover({
  anchorRef,
  open,
  onClose,
  align = "left",
  gap = 4,
  matchWidth = false,
  minSpaceBelow = 220,
  className,
  role = "menu",
  id,
  ariaLabel,
  dismissOnOutsideClick = true,
  dismissOnEscape = true,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  /** The trigger element (or its wrapper) the popover anchors to. */
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  /** Which edge aligns to the anchor. `right` keeps right edges flush. */
  align?: "left" | "right";
  /** Pixel gap between anchor and popover. */
  gap?: number;
  /** Force the popover to the anchor's width (e.g. full-width field menus). */
  matchWidth?: boolean;
  /** Below this much room under the anchor, flip the popover above it. */
  minSpaceBelow?: number;
  className?: string;
  role?: string;
  id?: string;
  ariaLabel?: string;
  dismissOnOutsideClick?: boolean;
  dismissOnEscape?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: ReactNode;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    width?: number;
  } | null>(null);

  // Measure on open + keep in sync with scroll/resize. Rendered null until
  // measured, so there's no first-frame flash at the wrong position.
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    function measure() {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const below = vh - r.bottom;
      const placeAbove = below < minSpaceBelow && r.top > below;
      const next: {
        left?: number;
        right?: number;
        top?: number;
        bottom?: number;
        width?: number;
      } = {};
      if (align === "right") next.right = Math.max(8, vw - r.right);
      else next.left = Math.max(8, Math.min(r.left, vw - 8));
      if (placeAbove) next.bottom = vh - r.top + gap;
      else next.top = r.bottom + gap;
      if (matchWidth) next.width = r.width;
      setPos(next);
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, anchorRef, align, gap, matchWidth, minSpaceBelow]);

  // Outside-click (checks anchor + popover) + Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      if (dismissOnOutsideClick) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && dismissOnEscape) {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchorRef, onClose, dismissOnOutsideClick, dismissOnEscape]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={popoverRef}
      id={id}
      role={role}
      aria-label={ariaLabel}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ position: "fixed", ...pos }}
      className={cn("z-[60]", className)}
    >
      {children}
    </div>,
    document.body,
  );
}
