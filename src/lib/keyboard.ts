"use client";
import { useEffect, useRef } from "react";

export type Hotkey = string; // e.g. "cmd+k", "c", "?", "g i"

/**
 * On Mac, "Mod" (cmd in our combo strings) maps to Cmd / Meta. On every
 * other platform Mod maps to Ctrl. Detected once per page load — covers
 * desktop browsers; mobile/edge cases fall back to non-Mac.
 */
function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  // navigator.platform is deprecated but still the most reliable
  // synchronous flag here. UA-ch's `userAgentData.platform` is not
  // available in Firefox.
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
}

function match(e: KeyboardEvent, combo: Hotkey): boolean {
  const parts = combo.toLowerCase().split("+");
  const key = parts.pop();
  if (!key) return false;
  const needMod = parts.includes("cmd") || parts.includes("meta") || parts.includes("mod");
  const needCtrl = parts.includes("ctrl");
  const needShift = parts.includes("shift");
  const needAlt = parts.includes("alt");

  // Mod = Cmd on Mac, Ctrl elsewhere. This makes `cmd+\` work for
  // both Mac (Cmd+\) and Linux/Windows (Ctrl+\).
  const modPressed = isMac() ? e.metaKey : e.ctrlKey;
  if (needMod !== modPressed) return false;

  // Explicit ctrl+ combos still require ctrl regardless of platform.
  // (Skip the check on non-Mac when needMod already mapped to ctrl —
  // otherwise `mod+x` would also require ctrl unconditionally.)
  if (needCtrl && !e.ctrlKey) return false;

  if (needShift !== e.shiftKey) return false;
  if (needAlt !== e.altKey) return false;

  // Combos with no modifier prefixes (e.g. "c", "?") must match an
  // event with NO modifiers. Without this guard, Ctrl+C would fire
  // any `useHotkey("c")` handler and `e.preventDefault()` would
  // swallow the platform copy shortcut.
  const combosHasAnyMod = needMod || needCtrl || needShift || needAlt;
  if (!combosHasAnyMod) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    // Note: shift is allowed for shifted-character keys ("?" etc.) so
    // we don't gate it here — `e.key` already encodes the shifted form.
  }

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
