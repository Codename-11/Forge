import { describe, it, expect } from "vitest";
import {
  easeOutCubic,
  lerp,
  lerpViewport,
  viewportsClose,
  computeFitViewport,
} from "@/lib/canvas-camera";

describe("easeOutCubic", () => {
  it("pins endpoints and is monotonic", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5); // ease-OUT front-loads
  });
  it("clamps out-of-range t", () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
});

describe("lerp / lerpViewport", () => {
  it("interpolates scalars", () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
  });
  it("interpolates a viewport componentwise", () => {
    const v = lerpViewport({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 200, zoom: 2 }, 0.5);
    expect(v).toEqual({ x: 50, y: 100, zoom: 1.5 });
  });
});

describe("viewportsClose", () => {
  it("treats sub-pixel / sub-permille deltas as equal", () => {
    expect(viewportsClose({ x: 0, y: 0, zoom: 1 }, { x: 0.4, y: -0.3, zoom: 1.0005 })).toBe(true);
  });
  it("rejects meaningful deltas", () => {
    expect(viewportsClose({ x: 0, y: 0, zoom: 1 }, { x: 2, y: 0, zoom: 1 })).toBe(false);
    expect(viewportsClose({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0, zoom: 1.5 })).toBe(false);
  });
});

describe("computeFitViewport", () => {
  it("returns null for empty input", () => {
    expect(computeFitViewport([], { w: 800, h: 600 }, { minZoom: 0.25, maxZoom: 3 })).toBeNull();
  });

  it("centers a single box in the viewport", () => {
    const v = computeFitViewport(
      [{ x: 0, y: 0, w: 100, h: 100 }],
      { w: 800, h: 600 },
      { pad: 80, minZoom: 0.25, maxZoom: 3 },
    );
    expect(v).not.toBeNull();
    // Box center (50,50) should land at viewport center (400,300).
    const cx = 50 * v!.zoom + v!.x;
    const cy = 50 * v!.zoom + v!.y;
    expect(cx).toBeCloseTo(400, 5);
    expect(cy).toBeCloseTo(300, 5);
  });

  it("clamps zoom to maxZoom for tiny content", () => {
    const v = computeFitViewport(
      [{ x: 0, y: 0, w: 1, h: 1 }],
      { w: 800, h: 600 },
      { pad: 80, minZoom: 0.25, maxZoom: 3 },
    );
    expect(v!.zoom).toBe(3);
  });

  it("clamps zoom to minZoom for huge content", () => {
    const v = computeFitViewport(
      [{ x: 0, y: 0, w: 100000, h: 100000 }],
      { w: 800, h: 600 },
      { pad: 80, minZoom: 0.25, maxZoom: 3 },
    );
    expect(v!.zoom).toBe(0.25);
  });
});
