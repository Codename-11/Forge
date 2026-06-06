import { describe, expect, it } from "vitest";
import {
  getTerminalRunFailureBanner,
  isTerminalFailedRunStatus,
} from "@/components/issue-detail/run-failure-banner";

const baseRun = {
  id: "run_1234567890abcdef",
  status: "STALLED",
  currentStep: "stalled after no runtime activity",
  externalRunId: null,
  lastEventAt: new Date("2026-06-01T12:00:00.000Z"),
  finishedAt: new Date("2026-06-01T12:05:00.000Z"),
  agent: {
    name: "Codex",
    profileKey: "codex",
    provider: "CODEX",
    runtime: {
      name: "Codex local bridge",
      adapterKey: "codex-app-server",
    },
  },
};

describe("run failure banner helpers", () => {
  it("classifies stalled and abandoned runs as terminal failed, but not completed", () => {
    expect(isTerminalFailedRunStatus("STALLED")).toBe(true);
    expect(isTerminalFailedRunStatus("ABANDONED")).toBe(true);
    expect(isTerminalFailedRunStatus("COMPLETED")).toBe(false);
    expect(isTerminalFailedRunStatus("ACTIVE")).toBe(false);
    expect(isTerminalFailedRunStatus("WAITING")).toBe(false);
  });

  it("builds operator-friendly diagnostic copy with context and next action", () => {
    const banner = getTerminalRunFailureBanner(baseRun);

    expect(banner).not.toBeNull();
    expect(banner?.title).toBe("Codex run stalled before completing");
    expect(banner?.description).toContain("did not report runtime activity");
    expect(banner?.metadata).toContainEqual({ label: "Agent", value: "Codex (@codex)" });
    expect(banner?.metadata).toContainEqual({
      label: "Tool surface",
      value: "Codex local bridge · codex-app-server",
    });
    expect(banner?.metadata).toContainEqual({ label: "Run", value: "run_1234567890abcdef" });
    expect(banner?.recommendation).toContain("runtime/tool surface");
    expect(banner?.recommendation).toContain("Switching Execute/Review/Research");
  });

  it("returns null when a newer completed run is the latest run", () => {
    expect(getTerminalRunFailureBanner({ ...baseRun, status: "COMPLETED" })).toBeNull();
  });
});
