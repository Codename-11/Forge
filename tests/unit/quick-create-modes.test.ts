import { describe, expect, it } from "vitest";
import { SWITCHABLE_MODES } from "@/components/quick-create";
import { parseGitHubIssueOrPrRef } from "@/lib/github-ref";

describe("CaptureSheet (QuickCreate) switchable modes", () => {
  it("exposes the seven agentic-OS destinations", () => {
    const kinds = SWITCHABLE_MODES.map((m) => m.kind).sort();
    expect(kinds).toEqual(
      [
        "action-request",
        "artifact",
        "cycle",
        "initiative",
        "issue",
        "note",
        "project",
      ].sort(),
    );
  });

  it("keeps Issue as the first entry so the default capture intent does not shift", () => {
    expect(SWITCHABLE_MODES[0].kind).toBe("issue");
  });

  it("has a human label for every mode", () => {
    for (const mode of SWITCHABLE_MODES) {
      expect(mode.label).toMatch(/[A-Za-z]/);
      expect(mode.label.length).toBeLessThanOrEqual(20);
    }
  });
});

describe("QuickCreate GitHub import refs", () => {
  it("parses GitHub issue URLs", () => {
    expect(parseGitHubIssueOrPrRef("https://github.com/acme/widgets/issues/42")).toEqual({
      repoFullName: "acme/widgets",
      number: 42,
      type: "ISSUE",
      url: "https://github.com/acme/widgets/issues/42",
    });
  });

  it("parses GitHub pull request URLs", () => {
    expect(parseGitHubIssueOrPrRef("github.com/acme/widgets/pull/7")).toEqual({
      repoFullName: "acme/widgets",
      number: 7,
      type: "PULL_REQUEST",
      url: "https://github.com/acme/widgets/pull/7",
    });
  });

  it("parses owner/repo#number shorthand without assuming issue vs PR", () => {
    expect(parseGitHubIssueOrPrRef("acme/widgets#9")).toEqual({
      repoFullName: "acme/widgets",
      number: 9,
    });
  });

  it("ignores non-GitHub text so normal issue titles stay local", () => {
    expect(parseGitHubIssueOrPrRef("Fix the overlay import flow")).toBeNull();
  });
});
