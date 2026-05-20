import { describe, expect, it } from "vitest";
import { computeSnap, SNAP_THRESHOLD_PX } from "@/lib/canvas-snap-guides";

describe("canvas-snap-guides", () => {
  it("returns the active bbox unchanged with no siblings", () => {
    const active = { x: 10, y: 20, width: 100, height: 80 };
    const out = computeSnap(active, [], 1);
    expect(out.bbox).toEqual(active);
    expect(out.guides).toEqual([]);
    expect(out.labels).toEqual([]);
  });

  it("snaps the left edge to a sibling's left edge within threshold", () => {
    // Mismatched widths so only the left-edge alignment is within
    // threshold; otherwise center-alignment would tie and win the bias.
    const active = { x: 51, y: 0, width: 50, height: 50 };
    const sibling = { id: "sib-1", x: 50, y: 100, width: 30, height: 50 };
    const out = computeSnap(active, [sibling], 1);
    expect(out.bbox.x).toBe(50);
    expect(out.guides).toHaveLength(1);
    expect(out.guides[0]?.axis).toBe("x");
    expect(out.guides[0]?.at).toBe(50);
  });

  it("prefers center alignment when multiple alignments tie", () => {
    // Identical widths → left-to-left, center-to-center, and
    // right-to-right all have the same offset. Center should win.
    const active = { x: 51, y: 0, width: 50, height: 50 };
    const sibling = { id: "sib-1", x: 50, y: 100, width: 50, height: 50 };
    const out = computeSnap(active, [sibling], 1);
    expect(out.bbox.x).toBe(50);
    expect(out.guides[0]?.at).toBe(75); // sibling's center
  });

  it("does not snap when the gap exceeds the threshold", () => {
    // 30px gap on every edge pair — well beyond the 4px threshold.
    const active = { x: 200, y: 200, width: 50, height: 50 };
    const sibling = { id: "sib-1", x: 50, y: 50, width: 60, height: 60 };
    const out = computeSnap(active, [sibling], 1);
    expect(out.bbox.x).toBe(200);
    expect(out.guides).toEqual([]);
  });

  it("scales threshold by zoom so snap distance stays constant in pixels", () => {
    // At zoom=0.5, the threshold doubles in canvas units. A 6px canvas
    // delta should still snap.
    const active = { x: 56, y: 0, width: 50, height: 50 };
    const sibling = { id: "sib-1", x: 50, y: 100, width: 50, height: 50 };
    const out = computeSnap(active, [sibling], 0.5);
    expect(out.bbox.x).toBe(50);
  });

  it("snaps independently on each axis", () => {
    const active = { x: 51, y: 51, width: 50, height: 50 };
    const sibling = { id: "sib-1", x: 50, y: 50, width: 50, height: 50 };
    const out = computeSnap(active, [sibling], 1);
    expect(out.bbox.x).toBe(50);
    expect(out.bbox.y).toBe(50);
    expect(out.guides).toHaveLength(2);
  });

  it("emits a distance label between active and nearest sibling", () => {
    const active = { x: 0, y: 0, width: 50, height: 50 };
    const sibling = { id: "sib-1", x: 100, y: 0, width: 50, height: 50 };
    const out = computeSnap(active, [sibling], 1);
    // Vertical overlap, so x-axis gap label applies.
    const xLabel = out.labels.find((l) => l.axis === "x");
    expect(xLabel).toBeDefined();
    expect(xLabel?.value).toBe(50);
  });

  it("clamps threshold check to the exact boundary", () => {
    const active = { x: SNAP_THRESHOLD_PX + 50, y: 0, width: 50, height: 50 };
    const sibling = { id: "sib-1", x: 50, y: 0, width: 50, height: 50 };
    const out = computeSnap(active, [sibling], 1);
    // 4px away — at the boundary, should snap.
    expect(out.bbox.x).toBe(50);
  });
});
