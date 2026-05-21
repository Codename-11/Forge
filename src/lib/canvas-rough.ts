// Hand-drawn ("sketch") rendering for canvas shapes via rough.js — the same
// engine Excalidraw uses. Pure geometry→SVG-path helpers: given a shape's
// box and style, return a list of <path> prop objects the renderer maps over.
//
// The seed is derived from the shape id so a given shape's wobble is stable
// across re-renders (no jitter on every drag frame).
import rough from "roughjs/bin/rough";
import type { Options } from "roughjs/bin/core";

const generator = rough.generator();

export type RoughPath = {
  d: string;
  stroke: string;
  fill: string;
  strokeWidth: number;
};

/** Stable 31-bit hash of a string → rough.js seed. */
export function seedFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 2147483647 || 1;
}

type SketchStyle = {
  stroke: string;
  fill: string;
  strokeWidth: number;
  roughness?: number;
};

function options(seed: number, s: SketchStyle): Options {
  const hasFill = s.fill && s.fill !== "transparent" && s.fill !== "none";
  return {
    seed,
    roughness: s.roughness ?? 1.2,
    bowing: 1,
    stroke: s.stroke,
    strokeWidth: s.strokeWidth,
    ...(hasFill
      ? { fill: s.fill, fillStyle: "hachure", fillWeight: Math.max(1, s.strokeWidth * 0.6), hachureGap: 6 }
      : {}),
  };
}

// rough.js emits OpSets tagged path | fillPath | fillSketch. Map each to the
// right SVG paint: outline strokes, solid fills, and hachure line strokes.
function drawableToPaths(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  drawable: any,
  s: SketchStyle,
): RoughPath[] {
  const out: RoughPath[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const set of drawable.sets as any[]) {
    const d = generator.opsToPath(set);
    if (!d) continue;
    if (set.type === "fillPath") {
      out.push({ d, stroke: "none", fill: s.fill, strokeWidth: 0 });
    } else if (set.type === "fillSketch") {
      out.push({ d, stroke: s.fill, fill: "none", strokeWidth: Math.max(1, s.strokeWidth * 0.6) });
    } else {
      out.push({ d, stroke: s.stroke, fill: "none", strokeWidth: s.strokeWidth });
    }
  }
  return out;
}

export function roughRect(
  seed: number,
  x: number,
  y: number,
  w: number,
  h: number,
  s: SketchStyle,
): RoughPath[] {
  return drawableToPaths(generator.rectangle(x, y, w, h, options(seed, s)), s);
}

export function roughEllipse(
  seed: number,
  cx: number,
  cy: number,
  w: number,
  h: number,
  s: SketchStyle,
): RoughPath[] {
  return drawableToPaths(generator.ellipse(cx, cy, w, h, options(seed, s)), s);
}

export function roughPolygon(
  seed: number,
  points: Array<[number, number]>,
  s: SketchStyle,
): RoughPath[] {
  return drawableToPaths(generator.polygon(points, options(seed, s)), s);
}

export function roughLine(
  seed: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  s: SketchStyle,
): RoughPath[] {
  return drawableToPaths(generator.line(x1, y1, x2, y2, options(seed, s)), s);
}
