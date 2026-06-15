import { describe, expect, it } from "vitest";
import {
  filtersEqual,
  hasTerminalStatusCategory,
  isEmptyFilters,
  safeParseFilters,
  withIncludeDoneForTerminalFilters,
  type SavedViewFilters,
} from "@/lib/saved-view-filters";
import { StatusCategory } from "@prisma/client";

describe("isEmptyFilters", () => {
  it("treats null/undefined/empty object as empty", () => {
    expect(isEmptyFilters(null)).toBe(true);
    expect(isEmptyFilters(undefined)).toBe(true);
    expect(isEmptyFilters({})).toBe(true);
  });

  it("treats explicit-false toggles as empty", () => {
    expect(isEmptyFilters({ unassigned: false, blocked: false })).toBe(true);
  });

  it("returns false for any populated array", () => {
    expect(isEmptyFilters({ statusIds: ["x"] })).toBe(false);
  });
});

describe("filtersEqual", () => {
  it("treats undefined and false toggles as equal", () => {
    expect(filtersEqual({}, { unassigned: false })).toBe(true);
    expect(filtersEqual({ unassigned: true }, { unassigned: true })).toBe(true);
    expect(filtersEqual({ unassigned: true }, { unassigned: false })).toBe(false);
  });

  it("compares arrays as sets (order-independent)", () => {
    const a: SavedViewFilters = { statusIds: ["x", "y", "z"] };
    const b: SavedViewFilters = { statusIds: ["z", "x", "y"] };
    expect(filtersEqual(a, b)).toBe(true);
  });

  it("returns false when array lengths differ", () => {
    expect(filtersEqual({ statusIds: ["x"] }, { statusIds: ["x", "y"] })).toBe(
      false,
    );
  });

  it("treats missing array and empty array as equal", () => {
    expect(filtersEqual({}, { statusIds: [] })).toBe(true);
  });

  it("compares scalar values strictly", () => {
    expect(filtersEqual({ query: "foo" }, { query: "foo" })).toBe(true);
    expect(filtersEqual({ query: "foo" }, { query: "bar" })).toBe(false);
    expect(filtersEqual({ updatedSince: "7d" }, { updatedSince: "1d" })).toBe(
      false,
    );
  });
});

describe("safeParseFilters", () => {
  it("returns {} on garbage input", () => {
    expect(safeParseFilters({ foo: "bar" })).toEqual({});
    expect(safeParseFilters(null)).toEqual({});
    expect(safeParseFilters(42)).toEqual({});
  });

  it("preserves a valid filter blob", () => {
    const b: SavedViewFilters = { statusIds: [], unassigned: true };
    expect(safeParseFilters(b)).toEqual(b);
  });
});

describe("terminal status filter helpers", () => {
  it("detects done/canceled categories", () => {
    expect(hasTerminalStatusCategory([StatusCategory.DONE])).toBe(true);
    expect(hasTerminalStatusCategory([StatusCategory.CANCELED])).toBe(true);
    expect(hasTerminalStatusCategory([StatusCategory.TODO])).toBe(false);
  });

  it("marks terminal category filters as includeDone so list calls remain reachable", () => {
    const filters = withIncludeDoneForTerminalFilters({
      statusCategories: [StatusCategory.DONE],
    });
    expect(filters.includeDone).toBe(true);
  });
});
