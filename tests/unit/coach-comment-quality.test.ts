import { describe, expect, it } from "vitest";
import { isUsefulCoachComment } from "@/server/services/ai";

describe("isUsefulCoachComment", () => {
  it("accepts a real multi-sentence diagnostic", () => {
    const real =
      "The stall is explained by Codex losing authentication: its refresh token was revoked, so it could not start or update the issue. Have the operator log the Codex profile out and back in, then kick or reassign the issue.";
    expect(isUsefulCoachComment(real)).toBe(true);
  });

  it("rejects the degenerate meta-acknowledgements seen in prod", () => {
    expect(isUsefulCoachComment("Posted the diagnostic comment on AXI-84.")).toBe(false);
    expect(isUsefulCoachComment("Posted on AXI-84.")).toBe(false);
    expect(isUsefulCoachComment("I've posted the diagnostic comment.")).toBe(false);
  });

  it("rejects terse non-answers", () => {
    expect(isUsefulCoachComment("Done.")).toBe(false);
    expect(isUsefulCoachComment("OK")).toBe(false);
    expect(isUsefulCoachComment("Acknowledged.")).toBe(false);
    expect(isUsefulCoachComment("")).toBe(false);
    expect(isUsefulCoachComment(null)).toBe(false);
  });
});
