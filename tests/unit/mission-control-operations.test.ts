import { describe, expect, it } from "vitest";
import {
  canonicalIssueKey,
  summarizeQueue,
} from "../../src/components/mission-control/operations-model";

describe("Mission Control operations model", () => {
  it("uses the canonical workspace key for queue issue references", () => {
    expect(canonicalIssueKey("FRG", 6)).toBe("FRG-6");
  });

  it("keeps the total queue count distinct from unassigned work", () => {
    expect(
      summarizeQueue([
        { assignedAgent: null, unblocked: true },
        { assignedAgent: null, unblocked: true },
        { assignedAgent: null, unblocked: false },
        { assignedAgent: { id: "agent-1" }, unblocked: true },
      ]),
    ).toEqual({ total: 4, unassigned: 3, blocked: 1 });
  });
});
