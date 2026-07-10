import { describe, expect, it } from "vitest";
import {
  getIssueFollowThroughModel,
  type IssueFollowThroughInput,
} from "@/components/issue-detail/issue-follow-through-banner";

const NOW = new Date("2026-07-10T12:00:00.000Z");

function input(overrides: Partial<IssueFollowThroughInput> = {}): IssueFollowThroughInput {
  return {
    issueLabel: "AXI-91",
    statusName: "Todo",
    statusCategory: "TODO",
    updatedAt: new Date("2026-07-10T10:00:00.000Z"),
    snoozedUntil: null,
    assignmentSlaMinutes: 30,
    assignedAgent: { id: "agent-1", name: "Victor", profileKey: "victor" },
    latestRun: {
      id: "run-1",
      status: "COMPLETED",
      engagementMode: "RESEARCH",
      summary: "Research is complete; implementation needs a code-capable Execute run.",
      agent: { id: "agent-1", name: "Victor", profileKey: "victor" },
    },
    hasActiveRun: false,
    now: NOW,
    ...overrides,
  };
}

describe("getIssueFollowThroughModel", () => {
  it("explains that a completed research run is waiting on an operator choice", () => {
    const model = getIssueFollowThroughModel(input());

    expect(model).toMatchObject({
      title: "Research finished — choose what happens next",
      evidence: "Research is complete; implementation needs a code-capable Execute run.",
    });
    expect(model?.description).toContain("still Todo with no active run");
    expect(model?.description).toContain("waiting for an operator choice");
  });

  it("stays quiet while a run is active or the issue is snoozed", () => {
    expect(getIssueFollowThroughModel(input({ hasActiveRun: true }))).toBeNull();
    expect(
      getIssueFollowThroughModel(input({ snoozedUntil: new Date("2026-07-11T12:00:00.000Z") })),
    ).toBeNull();
  });

  it("does not duplicate the terminal-run failure banner", () => {
    expect(
      getIssueFollowThroughModel(
        input({ latestRun: { ...input().latestRun!, status: "STALLED" } }),
      ),
    ).toBeNull();
  });

  it("does not warn before the workspace assignment SLA expires", () => {
    expect(
      getIssueFollowThroughModel(input({ updatedAt: new Date("2026-07-10T11:45:00.000Z") })),
    ).toBeNull();
  });
});
