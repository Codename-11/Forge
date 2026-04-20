"use client";
import { useEffect, useRef } from "react";

export type Hotkey = string; // e.g. "cmd+k", "c", "?", "g i"

function match(e: KeyboardEvent, combo: Hotkey): boolean {
  const parts = combo.toLowerCase().split("+");
  const key = parts.pop();
  if (!key) return false;
  const needMeta = parts.includes("cmd") || parts.includes("meta");
  const needCtrl = parts.includes("ctrl");
  const needShift = parts.includes("shift");
  const needAlt = parts.includes("alt");
  if (needMeta !== (e.metaKey || e.ctrlKey && navigator.platform.includes("Mac"))) return false;
  if (needCtrl && !e.ctrlKey) return false;
  if (needShift !== e.shiftKey) return false;
  if (needAlt !== e.altKey) return false;
  return e.key.toLowerCase() === key;
}

export function useHotkey(combo: Hotkey, handler: (e: KeyboardEvent) => void, deps: unknown[] = []) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isEditable && !combo.includes("cmd") && !combo.includes("ctrl")) return;
      if (match(e, combo)) {
        e.preventDefault();
        handler(e);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * Two-key chord handler, e.g. `useChord("g", { i: () => router.push("/inbox") })`.
 * Pressing the leader arms the chord for `windowMs`; pressing a mapped key runs
 * the handler. Input/textarea focus is ignored. Any non-mapped key cancels.
 */
export function useChord(
  leader: string,
  map: Record<string, () => void>,
  windowMs = 1500,
) {
  const armedRef = useRef<number | null>(null);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const k = e.key.toLowerCase();
      if (armedRef.current != null && Date.now() - armedRef.current < windowMs) {
        armedRef.current = null;
        if (map[k]) {
          e.preventDefault();
          map[k]();
          return;
        }
        // unmapped second key — just disarm
        return;
      }
      if (k === leader.toLowerCase()) {
        armedRef.current = Date.now();
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [leader, map, windowMs]);
}
