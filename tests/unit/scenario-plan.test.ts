import { describe, expect, it } from "vitest";
import { buildScenarioPlan, parseScenarioNames, scenarioId } from "../../scripts/scenarios/plan";

describe("named scenario planning", () => {
  it("composes names in caller order and removes duplicates", () => {
    const names = parseScenarioNames("tenancy,delivery-github,tenancy");
    expect(names).toEqual(["tenancy", "delivery-github"]);
    expect(buildScenarioPlan(names).map((item) => item.name)).toEqual(names);
  });

  it("is deterministic and uses stable ids", () => {
    const first = buildScenarioPlan(parseScenarioNames("all"), 2);
    const second = buildScenarioPlan(parseScenarioNames("all"), 2);
    expect(second).toEqual(first);
    expect(scenarioId("large-workspace", "issue", 12)).toBe("cscenariolargeworkspaceissue000012");
  });

  it("applies scale only to scenarios with useful volume controls", () => {
    const [delivery] = buildScenarioPlan(["delivery-github"], 3);
    const [large] = buildScenarioPlan(["large-workspace"], 3);
    const [activity] = buildScenarioPlan(["activity-overflow"], 3);
    expect(delivery.issueCount).toBe(2);
    expect(large.issueCount).toBe(150);
    expect(activity.eventCount).toBe(72);
  });

  it("rejects unknown names and unsafe scale values", () => {
    expect(() => parseScenarioNames("tenancy,not-real")).toThrow(/Unknown scenario/);
    expect(() => buildScenarioPlan(["tenancy"], 0)).toThrow(/1 to 100/);
    expect(() => buildScenarioPlan(["tenancy"], 101)).toThrow(/1 to 100/);
  });
});
