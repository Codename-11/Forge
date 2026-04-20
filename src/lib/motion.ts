/**
 * Forge motion tokens.
 *
 * One source of truth for transition + animation classNames. Prefer these
 * over ad-hoc `duration-XXX ease-XXX` on individual components — keeps
 * the whole app on the same (restrained, Nothing-inspired) timing.
 *
 * Timings are short and ease-out — no bounce, no overshoot. All values
 * respect the user's reduced-motion preference via the CSS `motion-*`
 * utilities wired up by `tailwindcss-animate` (+ the app's own shimmer
 * keyframes in globals.css, which honor `prefers-reduced-motion`).
 */
export const MOTION = {
  /** 100ms fast transition. Use for hovers, small state flips. */
  fast: "transition-all duration-100 ease-out",
  /** 150ms base transition. Default for most UI transitions. */
  base: "transition-all duration-150 ease-out",
  /** 300ms slow transition. Panels, larger layout shifts. */
  slow: "transition-all duration-300 ease-out",
  /** Slide in from below + fade. For toasts, popovers, menus. */
  slideUp:
    "motion-safe:animate-in motion-safe:slide-in-from-bottom-2 motion-safe:fade-in duration-150 ease-out",
  /** Slide in from above + fade. For dropdowns, top sheets. */
  slideDown:
    "motion-safe:animate-in motion-safe:slide-in-from-top-2 motion-safe:fade-in duration-150 ease-out",
  /** Simple fade in. For overlays, quick reveals. */
  fadeIn: "motion-safe:animate-in motion-safe:fade-in duration-100",
  /** Simple fade out. For overlay dismissals. */
  fadeOut: "motion-safe:animate-out motion-safe:fade-out duration-100",
  /** Slide in from the right edge. For side panels + drawers. */
  slideInRight:
    "motion-safe:animate-in motion-safe:slide-in-from-right-4 motion-safe:fade-in duration-150 ease-out",
  /** Slide in from the bottom edge. For bottom-sheet drawers. */
  slideInBottom:
    "motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:fade-in duration-150 ease-out",
  /** Slide in from the top edge. For top-aligned floating bars. */
  slideInTop:
    "motion-safe:animate-in motion-safe:slide-in-from-top-4 motion-safe:fade-in duration-150 ease-out",
} as const;

export type MotionToken = keyof typeof MOTION;
