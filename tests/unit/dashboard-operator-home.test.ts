import { describe, expect, it } from "vitest";
import { buildOperatorLanes } from "@/components/dashboard/operator-home";
import type { DashboardWorkCard } from "@/components/dashboard/issue-card";

function card(id: string, overrides: Partial<DashboardWorkCard> = {}): DashboardWorkCard {
  return {
    id,
    number: Number(id.replace(/\D/g, "")) || 1,
    title: `Issue ${id}`,
    description: null,
    priority: "NONE",
    dueDate: null,
    slaMinutes: null,
    activityAt: new Date("2026-08-26T12:00:00Z"),
    childTotal: 0,
    childDone: 0,
    status: {
      id: `status-${id}`,
      name: "Todo",
      category: "TODO",
      color: "#78716c",
    },
    project: null,
    labels: [],
    assignees: [],
    assignedAgent: null,
    latestRun: null,
    ...overrides,
  } as DashboardWorkCard;
}

describe("buildOperatorLanes", () => {
  const now = new Date("2026-08-26T12:00:00Z").getTime();

  it("deduplicates cards and assigns each one to exactly one semantic lane", () => {
    const active = card("1", {
      priority: "HIGH",
      status: { id: "active", name: "In Progress", category: "IN_PROGRESS", color: "#d97706" },
    });
    const waiting = card("2", {
      latestRun: { status: "WAITING" } as DashboardWorkCard["latestRun"],
    });
    const later = card("3");

    const lanes = buildOperatorLanes([active, waiting], [active, later], now);
    const ids = [lanes.recommended, ...lanes.now, ...lanes.next, ...lanes.waiting]
      .filter((item): item is DashboardWorkCard => Boolean(item))
      .map((item) => item.id);

    expect(ids).toHaveLength(new Set(ids).size);
    expect(lanes.now.map((item) => item.id)).toEqual(["3"]);
    expect(lanes.waiting.map((item) => item.id)).toEqual(["2"]);
    expect(lanes.next).toEqual([]);
    expect(lanes.recommended?.id).toBe("1");
  });

  it("promotes due-soon work and keeps review work in Waiting", () => {
    const dueSoon = card("4", { dueDate: new Date(now + 24 * 60 * 60 * 1000) });
    const review = card("5", {
      status: { id: "review", name: "In Review", category: "IN_REVIEW", color: "#ca8a04" },
    });

    const lanes = buildOperatorLanes([dueSoon, review], [], now);

    expect(lanes.recommended?.id).toBe("4");
    expect(lanes.now).toEqual([]);
    expect(lanes.waiting.map((item) => item.id)).toEqual(["5"]);
  });

  it("caps lane density while preserving the highest-ranked source order", () => {
    const active = Array.from({ length: 8 }, (_, index) =>
      card(String(index + 10), {
        priority: index < 2 ? "URGENT" : "HIGH",
      }),
    );

    const lanes = buildOperatorLanes(active, [], now);

    expect(lanes.now).toHaveLength(5);
    expect(lanes.recommended?.id).toBe("10");
    expect(lanes.now.map((item) => item.id)).toEqual(["11", "12", "13", "14", "15"]);
    expect(lanes.next.map((item) => item.id)).toEqual(["16", "17"]);
  });
});
