import { describe, expect, it } from "vitest";
import { githubCheckWebhookHint } from "@/server/services/github/webhook";

describe("githubCheckWebhookHint", () => {
  it("treats a successful suite as a dirty hint, never aggregate completion evidence", () => {
    expect(
      githubCheckWebhookHint({
        event: "check_suite",
        conclusion: "success",
      }),
    ).toMatchObject({
      status: "dirty",
      conclusion: null,
      source: "webhook-hint",
      observedConclusion: "success",
    });
  });

  it("also treats an individual failure as a non-terminal refresh hint", () => {
    expect(
      githubCheckWebhookHint({
        event: "check_run",
        conclusion: "failure",
        headSha: "abc123",
      }),
    ).toMatchObject({ conclusion: null, observedConclusion: "failure", headSha: "abc123" });
  });
});
