import { describe, expect, it } from "vitest";
import {
  mergeScopedOrder,
  orderWidgets,
  priorityColumnsForWorkCount,
  type DashboardWidget,
} from "@/components/dashboard/dashboard-stack";
import { formatPulseCount } from "@/components/dashboard/pulse-tile";

const widget = (id: string): DashboardWidget => ({
  id,
  title: id,
  node: null,
});

describe("orderWidgets", () => {
  it("uses saved known ids first and appends new registry entries", () => {
    const widgets = [widget("pipeline"), widget("today"), widget("pulse")];

    expect(orderWidgets(widgets, ["today", "removed-widget"]).map((item) => item.id)).toEqual([
      "today",
      "pipeline",
      "pulse",
    ]);
  });
});

describe("mergeScopedOrder", () => {
  it("reorders one dashboard zone without discarding ids owned by another", () => {
    expect(
      mergeScopedOrder(
        ["agent-attention", "pipeline", "today", "standup"],
        ["standup", "agent-attention"],
        ["agent-attention", "standup"],
      ),
    ).toEqual(["standup", "pipeline", "today", "agent-attention"]);
  });

  it("appends newly introduced scoped widgets to an older saved order", () => {
    expect(
      mergeScopedOrder(
        ["whats-new", "pulse"],
        ["pipeline", "whats-new", "suggestions", "pulse"],
        ["pipeline", "whats-new", "suggestions", "pulse"],
      ),
    ).toEqual(["pipeline", "whats-new", "suggestions", "pulse"]);
  });

  it("deduplicates malformed saved preferences", () => {
    expect(
      mergeScopedOrder(
        ["pipeline", "pipeline", "agent-activity"],
        ["pipeline", "today", "today"],
        ["pipeline", "today"],
      ),
    ).toEqual(["pipeline", "today", "agent-activity"]);
  });
});

describe("formatPulseCount", () => {
  it("keeps operational metrics bounded without losing the exact title value", () => {
    expect(formatPulseCount(0)).toBe("0");
    expect(formatPulseCount(999)).toBe("999");
    expect(formatPulseCount(1_000)).toBe("999+");
    expect(formatPulseCount(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("priorityColumnsForWorkCount", () => {
  it("stacks operations beside a tall work canvas and compacts sparse states", () => {
    expect(priorityColumnsForWorkCount(6)).toBe(2);
    expect(priorityColumnsForWorkCount(8)).toBe(2);
    expect(priorityColumnsForWorkCount(9)).toBe(1);
    expect(priorityColumnsForWorkCount(12)).toBe(1);
  });
});
