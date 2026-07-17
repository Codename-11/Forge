import { describe, expect, it } from "vitest";
import { issueSearchWhere, parseIssueSearch } from "@/server/services/issue-search";

describe("issue search parser", () => {
  it("normalizes direct identifiers", () => {
    expect(parseIssueSearch("  axi-117 ")).toEqual({
      kind: "identifier",
      workspaceKey: "AXI",
      number: 117,
    });
    expect(parseIssueSearch("117")).toEqual({ kind: "identifier", number: 117 });
    expect(parseIssueSearch("#117")).toEqual({ kind: "identifier", number: 117 });
    expect(parseIssueSearch("999999999999999999999")).toEqual({
      kind: "identifier",
      number: -1,
    });
  });

  it("normalizes ordinary text and keeps identifiers exact", () => {
    expect(parseIssueSearch("  release   train ")).toEqual({
      kind: "text",
      query: "release train",
    });
    expect(issueSearchWhere("#42")).toEqual({ number: 42 });
  });
});
