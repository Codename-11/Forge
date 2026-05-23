"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * Global themed-tooltip delegate.
 *
 * Mounted once at the app root. Listens at the document level for hover /
 * focus on any element carrying a `title` attribute, then:
 *   1. stashes the text and **removes** `title` so the browser's native
 *      tooltip never appears,
 *   2. renders a themed (token-styled) tooltip positioned at the element,
 *   3. restores `title` when the pointer / focus leaves, so screen readers
 *      still get the accessible description at rest.
 *
 * Net effect: every `title="…"` in the app becomes a themed tooltip with
 * zero per-call-site changes, and there are no browser-native tooltips.
 * New code can keep using `title` (or the {@link Tooltip} wrapper, which
 * just sets `title`).
 *
 * ### Keyboard-shortcut chips
 *
 * An element may carry an optional `data-tooltip-kbd` attribute alongside
 * its `title`. Its value is a space-separated list of keys (e.g. `"⌘ K"`
 * or `"G D"`); each key renders as a `.kbd` chip to the right of the label
 * text inside the tooltip. The plain `title` should hold the
 * human-readable label only, so the at-rest accessible name stays clean.
 * `data-tooltip-kbd` is left on the element (it is not a native-tooltip
 * source), so only `title` is stashed / restored.
 *
 * ### Positioning
 *
 * Placement is two-pass: the tooltip is first rendered at a tentative
 * anchor point, then `useLayoutEffect` measures the real rendered box and
 * clamps it fully inside the viewport with an 8px margin on all sides.
 * Vertical placement prefers above the target and flips below when it
 * would clip the top edge (and vice-versa). Horizontal placement stays
 * centered on the target when possible, shifting left/right only as needed
 * to respect the margins.
 *
 * The fade-in is `motion-safe` only; the tooltip itself always works
 * regardless of the motion preference (a tooltip is an affordance, not
 * ambient motion).
 */
const SHOW_DELAY_MS = 350;
const STASH_ATTR = "data-native-title";
const KBD_ATTR = "data-tooltip-kbd";
const MARGIN = 8;

type Anchor = {
  text: string;
  keys: string[];
  /** Target rect, in viewport coords — the tooltip is placed against this. */
  rect: { top: number; bottom: number; left: number; width: number };
};

type Placed = {
  left: number;
  top: number;
  placement: "top" | "bottom";
};

export function NativeTooltips() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [mounted, setMounted] = useState(false);
  const activeRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number>(0);
  const tipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const restore = () => {
      const el = activeRef.current;
      if (el) {
        const stashed = el.getAttribute(STASH_ATTR);
        if (stashed !== null) {
          el.setAttribute("title", stashed);
          el.removeAttribute(STASH_ATTR);
        }
      }
      activeRef.current = null;
    };

    const hide = () => {
      window.clearTimeout(timerRef.current);
      restore();
      setAnchor(null);
      setPlaced(null);
    };

    const parseKeys = (raw: string | null): string[] =>
      raw ? raw.split(/\s+/).filter(Boolean) : [];

    const place = (el: HTMLElement, text: string) => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      // Reset the measured placement so the next layout pass repositions
      // against fresh geometry rather than flashing at the old spot.
      setPlaced(null);
      setAnchor({
        text,
        keys: parseKeys(el.getAttribute(KBD_ATTR)),
        rect: { top: r.top, bottom: r.bottom, left: r.left, width: r.width },
      });
    };

    const claim = (el: HTMLElement, text: string, immediate: boolean) => {
      window.clearTimeout(timerRef.current);
      restore();
      activeRef.current = el;
      el.setAttribute(STASH_ATTR, text);
      el.removeAttribute("title"); // suppress the native tooltip
      if (immediate) {
        place(el, text);
      } else {
        timerRef.current = window.setTimeout(() => {
          if (activeRef.current === el) place(el, text);
        }, SHOW_DELAY_MS);
      }
    };

    const titledFrom = (node: EventTarget | null): HTMLElement | null => {
      if (!node || !(node as Element).closest) return null;
      const el = (node as Element).closest<HTMLElement>("[title]");
      if (!el) return null;
      const text = el.getAttribute("title");
      return text && text.trim() ? el : null;
    };

    const onOver = (e: MouseEvent) => {
      const el = titledFrom(e.target);
      if (!el || el === activeRef.current) return;
      claim(el, el.getAttribute("title") as string, false);
    };

    const onOut = (e: MouseEvent) => {
      const el = activeRef.current;
      if (!el) return;
      const to = e.relatedTarget as Node | null;
      if (to && el.contains(to)) return; // still within the same element
      hide();
    };

    const onFocusIn = (e: FocusEvent) => {
      const el = titledFrom(e.target);
      if (!el || el === activeRef.current) return;
      claim(el, el.getAttribute("title") as string, true);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("blur", hide);

    return () => {
      hide();
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Second pass: measure the rendered tooltip and clamp it into the
  // viewport. Runs synchronously before paint so the user never sees the
  // tentative (pre-clamp) position.
  useLayoutEffect(() => {
    if (!anchor) return;
    const node = tipRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { rect } = anchor;
    const centerX = rect.left + rect.width / 2;

    // Horizontal: center on the target, then clamp so the box stays within
    // the 8px margins. If the box is wider than the viewport it pins left.
    let left = centerX - box.width / 2;
    left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - MARGIN - box.width));

    // Vertical: prefer above the target; flip below if it would clip the
    // top edge. The gap mirrors the old 8px offset.
    const fitsAbove = rect.top - MARGIN - box.height >= MARGIN;
    const fitsBelow = rect.bottom + MARGIN + box.height <= vh - MARGIN;
    let placement: "top" | "bottom";
    if (fitsAbove) placement = "top";
    else if (fitsBelow) placement = "bottom";
    else placement = rect.top > vh - rect.bottom ? "top" : "bottom"; // more room wins

    let top =
      placement === "top" ? rect.top - MARGIN - box.height : rect.bottom + MARGIN;
    top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, vh - MARGIN - box.height));

    setPlaced({ left, top, placement });
  }, [anchor]);

  if (!mounted || !anchor) return null;

  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      className={cn(
        "pointer-events-none fixed z-[1000] flex max-w-xs items-center gap-2 whitespace-normal rounded-md border border-border bg-popover px-2 py-1 text-xs leading-snug text-popover-foreground shadow-md",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100",
        // Hidden until measured so the tentative position never paints.
        placed ? "visible" : "invisible",
      )}
      style={
        placed
          ? { left: placed.left, top: placed.top }
          : // Tentative: render near the anchor (off the measured path) so
            // the box has real geometry to read in the layout pass.
            { left: anchor.rect.left, top: anchor.rect.top }
      }
    >
      <span className="min-w-0">{anchor.text}</span>
      {anchor.keys.length > 0 && (
        <span className="ml-auto flex shrink-0 items-center gap-px">
          {anchor.keys.map((key, i) => (
            <span key={`${key}-${i}`} className="kbd !h-4 !min-w-[1rem] !px-1">
              {key}
            </span>
          ))}
        </span>
      )}
    </div>,
    document.body,
  );
}
