import { describe, expect, it } from "vitest";
import {
  activeIssueBlockers,
  type IssueBlockerRelation,
} from "@/components/issue-detail/issue-blocker-control";

function blocker(id: string, statusCategory: string): IssueBlockerRelation {
  return {
    relationId: `relation-${id}`,
    target: {
      id,
      number: Number(id),
      title: `Blocker ${id}`,
      statusCategory,
    },
  };
}

describe("activeIssueBlockers", () => {
  it("keeps every open dependency and ignores terminal blockers", () => {
    const rows = [
      blocker("1", "TODO"),
      blocker("2", "IN_PROGRESS"),
      blocker("3", "IN_REVIEW"),
      blocker("4", "DONE"),
      blocker("5", "CANCELED"),
    ];

    expect(activeIssueBlockers(rows).map((row) => row.target.id)).toEqual(["1", "2", "3"]);
  });

  it("returns an empty set once every dependency is terminal", () => {
    expect(activeIssueBlockers([blocker("1", "DONE"), blocker("2", "CANCELED")])).toEqual([]);
  });
});
