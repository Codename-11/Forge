import { describe, expect, it } from "vitest";
import {
  parseDateValue,
  formatDateValue,
  buildMonthGrid,
} from "@/components/ui/date-picker";

describe("date-picker helpers", () => {
  it("parses a YYYY-MM-DD string to a local Date", () => {
    const d = parseDateValue("2026-06-27");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(5); // June (0-indexed)
    expect(d!.getDate()).toBe(27);
  });

  it("returns null for empty / malformed input", () => {
    expect(parseDateValue("")).toBeNull();
    expect(parseDateValue(null)).toBeNull();
    expect(parseDateValue(undefined)).toBeNull();
    expect(parseDateValue("2026-13-40")).toBeNull();
    expect(parseDateValue("not-a-date")).toBeNull();
  });

  it("round-trips through formatDateValue", () => {
    expect(formatDateValue(parseDateValue("2026-01-05")!)).toBe("2026-01-05");
    expect(formatDateValue(new Date(2026, 11, 9))).toBe("2026-12-09");
  });

  it("builds a month grid padded to the starting weekday", () => {
    // June 2026: the 1st is a Monday (getDay()===1).
    const grid = buildMonthGrid(2026, 5);
    expect(grid[0]).toBeNull(); // Sunday leading pad
    expect(grid[1]).not.toBeNull();
    expect(grid[1]!.getDate()).toBe(1);
    const realDays = grid.filter(Boolean);
    expect(realDays).toHaveLength(30); // June has 30 days
    expect(realDays[realDays.length - 1]!.getDate()).toBe(30);
  });
});
