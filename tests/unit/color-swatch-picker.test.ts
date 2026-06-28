import { describe, expect, it } from "vitest";
import { normalizeHexColor } from "@/components/ui/color-swatch-picker";

describe("normalizeHexColor", () => {
  it("passes through a valid 6-digit hex (lowercased)", () => {
    expect(normalizeHexColor("#d97706")).toBe("#d97706");
    expect(normalizeHexColor("#D97706")).toBe("#d97706");
  });

  it("adds a missing leading #", () => {
    expect(normalizeHexColor("d97706")).toBe("#d97706");
  });

  it("expands 3-digit shorthand to 6", () => {
    expect(normalizeHexColor("#abc")).toBe("#aabbcc");
    expect(normalizeHexColor("abc")).toBe("#aabbcc");
    expect(normalizeHexColor("#FFF")).toBe("#ffffff");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeHexColor("  #ABC  ")).toBe("#aabbcc");
  });

  it("rejects invalid input", () => {
    expect(normalizeHexColor("xyz")).toBeNull();
    expect(normalizeHexColor("#12")).toBeNull();
    expect(normalizeHexColor("#1234567")).toBeNull();
    expect(normalizeHexColor("")).toBeNull();
    expect(normalizeHexColor("rgb(1,2,3)")).toBeNull();
  });
});
