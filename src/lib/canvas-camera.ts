// Camera math + easing helpers for the canvas viewport.
//
// Pure functions only — no React, no DOM — so they're unit-testable and
// shared between the interactive page (tweened fit/zoom, inertial pan) and
// presentation mode (frame-to-frame slide camera moves).

export type Viewport = { x: number; y: number; zoom: number };
export type BBox = { x: number; y: number; w: number; h: number };

/** Standard ease-out cubic — fast start, gentle settle. Excalidraw-ish. */
export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

/** Linear interpolate a→b by t∈[0,1]. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate a whole viewport (position + zoom) by eased t. */
export function lerpViewport(a: Viewport, b: Viewport, t: number): Viewport {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    zoom: lerp(a.zoom, b.zoom, t),
  };
}

/** True when two viewports are within sub-pixel / sub-permille of each other. */
export function viewportsClose(a: Viewport, b: Viewport): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.zoom - b.zoom) < 0.001
  );
}

/**
 * Compute the viewport that fits `items`' bounding box into a `view` of the
 * given pixel size, centered with `pad` px of breathing room, clamped to the
 * zoom range. Returns null when there's nothing to fit.
 */
export function computeFitViewport(
  items: BBox[],
  view: { w: number; h: number },
  opts: { pad?: number; minZoom: number; maxZoom: number },
): Viewport | null {
  if (items.length === 0) return null;
  const pad = opts.pad ?? 80;
  const minX = Math.min(...items.map((i) => i.x));
  const minY = Math.min(...items.map((i) => i.y));
  const maxX = Math.max(...items.map((i) => i.x + i.w));
  const maxY = Math.max(...items.map((i) => i.y + i.h));
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const zoom = Math.min(
    opts.maxZoom,
    Math.max(
      opts.minZoom,
      Math.min((view.w - pad * 2) / contentW, (view.h - pad * 2) / contentH),
    ),
  );
  return {
    zoom,
    x: view.w / 2 - (minX + contentW / 2) * zoom,
    y: view.h / 2 - (minY + contentH / 2) * zoom,
  };
}

/** Whether the user has asked the OS to minimize motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
