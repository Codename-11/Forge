import { describe, expect, it } from "vitest";
import { deriveGlobalOperationsPosture } from "@/components/global-shell/global-operations-model";

describe("deriveGlobalOperationsPosture", () => {
  it("prioritizes missing runtime setup over idle queue state", () => {
    expect(
      deriveGlobalOperationsPosture({
        activeRuns: 0,
        agentsOnline: 1,
        runtimeCount: 0,
        runtimesOnline: 0,
      }),
    ).toMatchObject({
      tone: "warning",
      label: "Setup required",
      actionLabel: "Register a runtime",
    });
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
