"use client";
import { useEffect, useRef, useState } from "react";

/**
 * useCountUp — design-spec M6.
 *
 * Tweens a number from 0 → `target` once, when the host element first
 * scrolls into view. Cubic ease-out, no animation library (rAF only).
 *
 * Guarantees:
 *  - **Reduced-motion**: jumps straight to `target`, no tween.
 *  - **Once per mount**: a given `target` is tweened a single time. If the
 *    same value remounts (e.g. filters change but the metric is unchanged),
 *    it stays put rather than re-running from 0.
 *  - **Lazy**: nothing animates until the element intersects the viewport,
 *    so off-screen stat tiles don't burn a tween before they're seen.
 *
 * Usage:
 *   const { value, ref } = useCountUp(open);
 *   <div ref={ref}>{value}</div>
 */
export function useCountUp<T extends HTMLElement = HTMLDivElement>(
  target: number,
  { durationMs = 800 }: { durationMs?: number } = {},
) {
  const ref = useRef<T | null>(null);
  // Start at the target so SSR / first paint shows the real number; the
  // tween (when it runs) resets to 0 and animates up.
  const [value, setValue] = useState(target);
  const tweenedFor = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el == null) return;

    // Already tweened this exact value on this mount — leave it settled.
    if (tweenedFor.current === target) {
      setValue(target);
      return;
    }

    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const motionOff =
      typeof document !== "undefined" &&
      document.documentElement.getAttribute("data-motion") === "off";

    if (prefersReduced || motionOff) {
      tweenedFor.current = target;
      setValue(target);
      return;
    }

    let raf = 0;
    let started = false;
    const run = () => {
      if (started) return;
      started = true;
      tweenedFor.current = target;
      const start = performance.now();
      setValue(0);
      const tick = (now: number) => {
        const k = Math.min(1, (now - start) / durationMs);
        const eased = 1 - Math.pow(1 - k, 3);
        setValue(Math.round(target * eased));
        if (k < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          run();
          io.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);

    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [target, durationMs]);

  return { value, ref };
}
