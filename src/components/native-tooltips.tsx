"use client";
import { useEffect, useRef, useState } from "react";
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
 * The fade-in is `motion-safe` only; the tooltip itself always works
 * regardless of the motion preference (a tooltip is an affordance, not
 * ambient motion).
 */
const SHOW_DELAY_MS = 350;
const STASH_ATTR = "data-native-title";

type TipState = {
  text: string;
  x: number;
  y: number;
  placement: "top" | "bottom";
} | null;

export function NativeTooltips() {
  const [tip, setTip] = useState<TipState>(null);
  const [mounted, setMounted] = useState(false);
  const activeRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number>(0);

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
      setTip(null);
    };

    const place = (el: HTMLElement, text: string) => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      const placement: "top" | "bottom" = r.top > 48 ? "top" : "bottom";
      const x = Math.min(
        Math.max(r.left + r.width / 2, 8),
        window.innerWidth - 8,
      );
      const y = placement === "top" ? r.top - 8 : r.bottom + 8;
      setTip({ text, x, y, placement });
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

  if (!mounted || !tip) return null;

  return createPortal(
    <div
      role="tooltip"
      className={cn(
        "pointer-events-none fixed z-[1000] max-w-xs -translate-x-1/2 whitespace-normal rounded-md border border-border bg-popover px-2 py-1 text-xs leading-snug text-popover-foreground shadow-md",
        tip.placement === "top" && "-translate-y-full",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100",
      )}
      style={{ left: tip.x, top: tip.y }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
