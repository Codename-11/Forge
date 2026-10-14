import { describe, expect, it } from "vitest";
import {
  resolveQuickCreateMode,
  resolveWorkItemKind,
  SWITCHABLE_MODES,
} from "@/components/quick-create";
import { WorkItemKind } from "@prisma/client";
import { parseGitHubIssueOrPrRef } from "@/lib/github-ref";
import { quickCreateRequestFromDataset } from "@/lib/workspace-surface-requests";

describe("CaptureSheet (QuickCreate) switchable modes", () => {
  it("exposes the seven agentic-OS destinations", () => {
    const kinds = SWITCHABLE_MODES.map((m) => m.kind).sort();
    expect(kinds).toEqual(
      ["action-request", "artifact", "cycle", "initiative", "issue", "note", "project"].sort(),
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

describe("CaptureSheet route and caller intent", () => {
  it("preserves named planning actions on detail pages before and after hydration", () => {
    const request = quickCreateRequestFromDataset({ quickCreateMode: "project" });
    expect(resolveQuickCreateMode("/w/forge/projects/cproject123", request)).toEqual({
      kind: "project",
    });
    expect(resolveQuickCreateMode("/w/forge/issues/cissue123", { mode: "cycle" })).toEqual({
      kind: "cycle",
    });
    expect(
      quickCreateRequestFromDataset({
        quickCreateMode: "invalid",
        quickCreateProject: "project-id",
      }),
    ).toEqual({ projectId: "project-id" });
  });
  it("defaults issue-detail capture to a comment", () => {
    expect(resolveQuickCreateMode("/w/forge/issues/cissue123")).toEqual({
      kind: "issue-context",
      issueId: "cissue123",
      intent: "comment",
    });
  });

  it("lets an explicit create-issue action bypass issue-detail comment context", () => {
    expect(
      resolveQuickCreateMode("/w/forge/issues/cissue123", {
        mode: "issue",
      }),
    ).toEqual({ kind: "issue" });
  });

  it("lets an explicit create-task action bypass issue-detail comment context", () => {
    expect(resolveQuickCreateMode("/w/forge/issues/cissue123", { mode: "task" })).toEqual({
      kind: "issue",
    });
  });

  it("creates tasks in personal workspaces without changing explicit issue actions", () => {
    expect(resolveWorkItemKind("PERSONAL")).toBe(WorkItemKind.TASK);
    expect(resolveWorkItemKind("TEAM")).toBe(WorkItemKind.ISSUE);
    expect(resolveWorkItemKind("PERSONAL", { mode: "issue" })).toBe(WorkItemKind.ISSUE);
    expect(resolveWorkItemKind("TEAM", { mode: "task" })).toBe(WorkItemKind.TASK);
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
