import { describe, expect, it } from "vitest";
import { groupConsecutive } from "@/lib/activity-grouping";

describe("groupConsecutive", () => {
  it("collapses adjacent equivalent rows while retaining their bounds", () => {
    const rows = [
      { id: "newest", key: "title" },
      { id: "middle", key: "title" },
      { id: "oldest", key: "title" },
    ];

    expect(groupConsecutive(rows, (row) => row.key)).toEqual([
      { newest: rows[0], oldest: rows[2], count: 3 },
    ]);
  });

  it("does not merge matching rows separated by a different event", () => {
    const rows = [
      { id: "one", key: "title" },
      { id: "two", key: "status" },
      { id: "three", key: "title" },
    ];

    expect(groupConsecutive(rows, (row) => row.key).map((group) => group.count)).toEqual([1, 1, 1]);
  });
});
