import { describe, expect, it } from "vitest";
import {
  mergeScopedOrder,
  orderWidgets,
  type DashboardWidget,
} from "@/components/dashboard/dashboard-stack";

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
