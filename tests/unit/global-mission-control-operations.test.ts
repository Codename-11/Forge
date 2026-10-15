import { describe, expect, it } from "vitest";
import { deriveGlobalOperationsPosture } from "@/components/global-shell/global-operations-model";

describe("deriveGlobalOperationsPosture", () => {
  it("does not require managed runtime setup for external MCP work", () => {
    expect(
      deriveGlobalOperationsPosture({
        activeRuns: 0,
        agentsOnline: 1,
        runtimeCount: 0,
        runtimesOnline: 0,
      }),
    ).toMatchObject({
      tone: "neutral",
      label: "Managed execution optional",
      actionLabel: "Set up an agent",
      actionHref: "/agents",
    });
  });

  it("keeps active external work visible without a managed runtime", () => {
    expect(deriveGlobalOperationsPosture({ activeRuns: 1, agentsOnline: 1, runtimeCount: 0, runtimesOnline: 0 }))
      .toMatchObject({ tone: "success", label: "Work in motion" });
  });

  it("surfaces degraded runtime coverage before active execution", () => {
    expect(
      deriveGlobalOperationsPosture({
        activeRuns: 2,
        agentsOnline: 3,
        runtimeCount: 2,
        runtimesOnline: 1,
      }),
    ).toMatchObject({
      tone: "danger",
      label: "Runtime attention",
      actionLabel: "Inspect runtimes",
    });
  });

  it("reports active execution when runtime coverage is healthy", () => {
    expect(
      deriveGlobalOperationsPosture({
        activeRuns: 2,
        agentsOnline: 3,
        runtimeCount: 2,
        runtimesOnline: 2,
      }),
    ).toMatchObject({
      tone: "success",
      label: "Work in motion",
      actionLabel: "View live activity",
    });
  });
});
