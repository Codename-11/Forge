import { describe, expect, it } from "vitest";
import { realtimeTargets, relationRealtimeTargets } from "@/lib/realtime-targets";

describe("realtime cache targets", () => {
  it("refreshes both ends of a relation without treating ordinary metadata as a relation", () => {
    expect(
      relationRealtimeTargets({
        subjectType: "issue",
        subjectId: "issue-1",
        payload: { relationId: "relation-1", toIssueId: "issue-2" },
      }),
    ).toEqual(["issue-1", "issue-2"]);
    expect(
      relationRealtimeTargets({
        subjectType: "issue",
        subjectId: "issue-1",
        payload: { title: "Changed" },
      }),
    ).toEqual([]);
  });
  it("targets the viewed issue and both sides of a sprint move", () => {
    expect(
      realtimeTargets({
        subjectType: "issue",
        subjectId: "issue-1",
        payload: { cycleId: "cycle-new", previousCycleId: "cycle-old" },
      }),
    ).toEqual({ issueId: "issue-1", cycleIds: ["cycle-new", "cycle-old"] });
  });

  it("uses payload issue ids for non-issue lifecycle events", () => {
    expect(
      realtimeTargets({
        subjectType: "agent-run",
        subjectId: "run-1",
        payload: { issueId: "issue-1" },
      }),
    ).toEqual({ issueId: "issue-1", cycleIds: [] });
  });

  it("does not invent broad targets for unrelated events", () => {
    expect(realtimeTargets({ subjectType: "agent", subjectId: "agent-1" })).toEqual({
      issueId: null,
      cycleIds: [],
    });
  });
});
