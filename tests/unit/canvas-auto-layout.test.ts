import { describe, expect, it } from "vitest";
import {
  computeAutoLayout,
  parseAutoLayout,
  type AutoLayoutSpec,
} from "@/lib/canvas-auto-layout";

const FRAME = { x: 100, y: 100, width: 600, height: 400 };

function spec(over: Partial<AutoLayoutSpec> = {}): AutoLayoutSpec {
  return {
    direction: "vertical",
    gap: 12,
    paddingTop: 12,
    paddingRight: 12,
    paddingBottom: 12,
    paddingLeft: 12,
    align: "start",
    justify: "start",
    ...over,
  };
}

describe("parseAutoLayout", () => {
  it("returns null for non-objects and empty objects", () => {
    expect(parseAutoLayout(null)).toBeNull();
    expect(parseAutoLayout(undefined)).toBeNull();
    expect(parseAutoLayout({})).toBeNull();
  });

  it("recognises a spec when any signal field is present", () => {
    expect(parseAutoLayout({ direction: "horizontal" })?.direction).toBe("horizontal");
    expect(parseAutoLayout({ gap: 24 })?.gap).toBe(24);
    expect(parseAutoLayout({ justify: "space-between" })?.justify).toBe("space-between");
  });

  it("fills defaults for missing fields", () => {
    const s = parseAutoLayout({ direction: "vertical" });
    expect(s).toMatchObject({ direction: "vertical", gap: 12, align: "start", justify: "start" });
  });
});

describe("computeAutoLayout — vertical stack", () => {
  it("stacks children top-to-bottom with gap", () => {
    const children = [
      { id: "a", x: 0, y: 0, width: 200, height: 60 },
      { id: "b", x: 0, y: 80, width: 200, height: 60 },
      { id: "c", x: 0, y: 160, width: 200, height: 60 },
    ];
    const pos = computeAutoLayout(FRAME, spec(), children);
    expect(pos.get("a")).toEqual({ x: 112, y: 112 });
    expect(pos.get("b")).toEqual({ x: 112, y: 184 }); // 112 + 60 + 12
    expect(pos.get("c")).toEqual({ x: 112, y: 256 }); // 112 + 60 + 12 + 60 + 12
  });

  it("centers cross-axis when align: center", () => {
    const children = [{ id: "a", x: 0, y: 0, width: 200, height: 60 }];
    const pos = computeAutoLayout(FRAME, spec({ align: "center" }), children);
    // innerLeft=112, innerWidth=576 → center: 112 + (576-200)/2 = 300
    expect(pos.get("a")?.x).toBe(300);
  });

  it("respects justify: end on primary axis", () => {
    const children = [
      { id: "a", x: 0, y: 0, width: 200, height: 60 },
      { id: "b", x: 0, y: 0, width: 200, height: 60 },
    ];
    const pos = computeAutoLayout(FRAME, spec({ justify: "end" }), children);
    // total = 60 + 12 + 60 = 132. innerBottom = 488. startY = 488 - 132 = 356
    expect(pos.get("a")?.y).toBe(356);
    expect(pos.get("b")?.y).toBe(428);
  });
});

describe("computeAutoLayout — horizontal row", () => {
  it("lays children left-to-right with gap", () => {
    const children = [
      { id: "a", x: 0, y: 0, width: 100, height: 60 },
      { id: "b", x: 120, y: 0, width: 100, height: 60 },
    ];
    const pos = computeAutoLayout(FRAME, spec({ direction: "horizontal" }), children);
    expect(pos.get("a")).toEqual({ x: 112, y: 112 });
    expect(pos.get("b")).toEqual({ x: 224, y: 112 });
  });

  it("distributes evenly with justify: space-between", () => {
    const children = [
      { id: "a", x: 0, y: 0, width: 100, height: 60 },
      { id: "b", x: 200, y: 0, width: 100, height: 60 },
      { id: "c", x: 400, y: 0, width: 100, height: 60 },
    ];
    const pos = computeAutoLayout(
      FRAME,
      spec({ direction: "horizontal", justify: "space-between" }),
      children,
    );
    // innerWidth = 576. totalWidths = 300. spare = 276 over 2 gaps = 138.
    expect(pos.get("a")?.x).toBe(112);
    expect(pos.get("b")?.x).toBe(112 + 100 + 138);
    expect(pos.get("c")?.x).toBe(112 + 100 + 138 + 100 + 138);
  });
});

describe("computeAutoLayout — drag-to-reorder", () => {
  it("re-sorts when an item's stored y crosses another", () => {
    // c moved above a: new stored y=10 < a.y=20
    const children = [
      { id: "a", x: 0, y: 20, width: 200, height: 60 },
      { id: "b", x: 0, y: 100, width: 200, height: 60 },
      { id: "c", x: 0, y: 10, width: 200, height: 60 },
    ];
    const pos = computeAutoLayout(FRAME, spec(), children);
    // c should land first
    expect(pos.get("c")?.y).toBeLessThan(pos.get("a")!.y);
    expect(pos.get("a")?.y).toBeLessThan(pos.get("b")!.y);
  });
});
