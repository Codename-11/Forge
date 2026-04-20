"use client";
import * as React from "react";

/**
 * Shared keyboard + focus behavior for Forge modal primitives.
 *
 * Every modal primitive (`<Confirm>`, `<QuickForm>`, `<SidePanel>`,
 * `<Picker>`, `<Drawer>`) funnels through this hook to keep the contract
 * uniform:
 *
 *   - ⎋ closes (unless `onEscape` is overridden to swallow).
 *   - Tab / Shift+Tab cycle focus inside the container.
 *   - On open, focus is moved to the first focusable element inside the
 *     container (or `initialFocusRef` if supplied).
 *   - On close, focus is restored to whatever element triggered the open
 *     (captured at mount time via `document.activeElement`).
 *
 * `prefers-reduced-motion` is respected by the callers via the `MOTION.*`
 * tokens — this hook is motion-agnostic.
 */
export function useModalBehavior({
  open,
  onClose,
  containerRef,
  initialFocusRef,
  onEscape,
  disabled,
}: {
  open: boolean;
  onClose: () => void;
  containerRef: React.RefObject<HTMLElement | null>;
  /**
   * Optional ref to the element that should receive focus when the modal
   * opens. Falls back to the first focusable descendant of the container.
   */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /**
   * Custom Escape handler. Return `false` to swallow (don't close). Default
   * behavior is to call `onClose()`.
   */
  onEscape?: (e: KeyboardEvent) => boolean | void;
  /**
   * Skip wiring entirely (e.g. SSR, or when the primitive wants to own
   * its own focus/keyboard handling).
   */
  disabled?: boolean;
}) {
  // Capture the trigger so we can restore focus on close.
  const triggerRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (disabled) return;
    if (!open) return;

    // Remember what had focus before we opened.
    triggerRef.current =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;

    // Move focus inside the modal after paint.
    const raf = requestAnimationFrame(() => {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
        return;
      }
      const first = firstFocusable(containerRef.current);
      if (first) first.focus();
    });

    return () => {
      cancelAnimationFrame(raf);
      // Restore focus to whatever opened us, if it's still connected.
      const trigger = triggerRef.current;
      if (trigger && document.contains(trigger)) {
        trigger.focus();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, disabled]);

  // Escape + tab-cycling focus trap.
  React.useEffect(() => {
    if (disabled) return;
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const swallow = onEscape?.(e);
        if (swallow === false) return;
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const container = containerRef.current;
        if (!container) return;
        const focusables = collectFocusable(container);
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !container.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose, disabled]);
}

const FOCUSABLE_SELECTORS = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function collectFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS),
  );
  return nodes.filter(
    (el) =>
      !el.hasAttribute("disabled") &&
      el.offsetParent !== null &&
      el.getAttribute("aria-hidden") !== "true",
  );
}

function firstFocusable(container: HTMLElement | null): HTMLElement | null {
  return collectFocusable(container)[0] ?? null;
}
