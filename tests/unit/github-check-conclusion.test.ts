import { describe, expect, it } from "vitest";
import { aggregateGitHubCheckConclusion } from "@/server/services/github/webhook";

describe("aggregateGitHubCheckConclusion", () => {
  it("accepts aggregate suite success as completion evidence", () => {
    expect(
      aggregateGitHubCheckConclusion({
        event: "check_suite",
        conclusion: "success",
        existingConclusion: null,
      }),
    ).toBe("success");
  });

  it("does not treat one successful check run as aggregate success", () => {
    expect(
      aggregateGitHubCheckConclusion({
        event: "check_run",
        conclusion: "success",
        existingConclusion: null,
      }),
    ).toBeNull();
  });

  it("keeps a known suite result across later successful jobs and records failures", () => {
    expect(
      aggregateGitHubCheckConclusion({
        event: "check_run",
        conclusion: "success",
        existingConclusion: "success",
      }),
    ).toBe("success");
    expect(
      aggregateGitHubCheckConclusion({
        event: "check_run",
        conclusion: "failure",
        existingConclusion: "success",
      }),
    ).toBe("failure");
  });
});
