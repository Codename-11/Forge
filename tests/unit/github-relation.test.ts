import { describe, expect, it } from "vitest";
import {
  derivePullRequestIssueRelations,
  isReleasePullRequest,
} from "@/server/services/github/relation";

describe("GitHub native relation derivation", () => {
  it("distinguishes implementation, closing, and bare references", () => {
    const relations = derivePullRequestIssueRelations({
      workspaceKey: "AXI",
      title: "Improve delivery cards (AXI-117)",
      body: "Related context AXI-63. Implements AXI-117. Closes AXI-118. Close AXI-119. Resolve AXI-120.",
    });
    expect(Object.fromEntries(relations)).toEqual({
      63: "RELATES_TO",
      117: "IMPLEMENTS",
      118: "FIXES",
      119: "FIXES",
      120: "FIXES",
    });
  });

  it("treats every issue reference in release assembly as containment", () => {
    const relations = derivePullRequestIssueRelations({
      workspaceKey: "AXI",
      title: "Release v0.28.0 — delivery truth",
      body: "Includes #72 for AXI-117 and fixes from AXI-118.",
      headRef: "codex/release-v0.28.0",
    });
    expect([...relations.entries()]).toEqual([
      [117, "RELEASES"],
      [118, "RELEASES"],
    ]);
  });

  it("recognizes release branches even when the title is customized", () => {
    expect(isReleasePullRequest({ title: "July delivery", headRef: "release/v0.28.0" })).toBe(true);
  });
});
