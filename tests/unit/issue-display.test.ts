import { describe, it, expect } from "vitest";
import {
  PRIORITY_GLYPH,
  firstLine,
  formatDueDate,
  formatSlaShort,
} from "@/lib/issue-display";

describe("issue-display helpers", () => {
  describe("formatSlaShort", () => {
    it("formats minutes, hours, and days compactly", () => {
      expect(formatSlaShort(45)).toBe("45m");
      expect(formatSlaShort(60)).toBe("1h");
      expect(formatSlaShort(240)).toBe("4h");
      expect(formatSlaShort(90)).toBe("1.5h");
      expect(formatSlaShort(1440)).toBe("1d");
      expect(formatSlaShort(4320)).toBe("3d");
      expect(formatSlaShort(2160)).toBe("1.5d");
    });
  });

  describe("firstLine", () => {
    it("takes the first non-empty line and strips a leading marker", () => {
      expect(firstLine("\n\n# Heading\nbody")).toBe("Heading");
      expect(firstLine("- a list item")).toBe("a list item");
      expect(firstLine("> a quote")).toBe("a quote");
      expect(firstLine("plain text")).toBe("plain text");
    });
    it("caps the length so a long paragraph can't blow out layout", () => {
      expect(firstLine("x".repeat(300)).length).toBe(160);
      expect(firstLine("y".repeat(20), 10).length).toBe(10);
    });
  });

  describe("formatDueDate", () => {
    it("uses relative phrasing near the present", () => {
      expect(formatDueDate(new Date(), null)).toBe("due today");
      expect(formatDueDate(new Date(Date.now() + 86_400_000), null)).toBe(
        "due tomorrow",
      );
      expect(formatDueDate(new Date(Date.now() - 3 * 86_400_000), null)).toBe(
        "3d overdue",
      );
      expect(formatDueDate(new Date(Date.now() + 4 * 86_400_000), null)).toBe(
        "in 4d",
      );
    });
  });

  it("PRIORITY_GLYPH covers every priority", () => {
    expect(PRIORITY_GLYPH.URGENT).toBe("!!!");
    expect(PRIORITY_GLYPH.HIGH).toBe("!!");
    expect(PRIORITY_GLYPH.NONE).toBe("—");
  });
});
