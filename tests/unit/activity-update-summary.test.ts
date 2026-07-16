import { describe, expect, it } from "vitest";
import { issueUpdateCopy } from "@/lib/activity-update-summary";

describe("issueUpdateCopy", () => {
  it("summarizes changed issue fields instead of discarding the patch", () => {
    expect(
      issueUpdateCopy({
        title: "Canonical delivery evidence",
        description: "updated body",
        priority: "HIGH",
        projectId: "cmrnproject123",
      }),
    ).toEqual({
      label: "Updated title, description, priority, project",
      phase: "fields",
    });
    expect(issueUpdateCopy({ priority: "HIGH" })).toEqual({
      label: "Priority updated",
      detail: "HIGH",
      phase: "priority",
    });
  });

  it("summarizes label and delivery actions without exposing opaque ids", () => {
    expect(issueUpdateCopy({ add: ["cmrnlabel1", "cmrnlabel2"], remove: ["cmrnlabel3"] })).toEqual({
      label: "Labels changed",
      detail: "2 added · 1 removed",
      phase: "labels",
    });
    expect(
      issueUpdateCopy({
        action: "work-session-participant-joined",
        repoFullName: "Codename-11/Forge",
        branch: "codex/axi-115-agent-connections",
      }),
    ).toEqual({
      label: "Work session participant joined",
      detail: "Codename-11/Forge · codex/axi-115-agent-connections",
      phase: "delivery",
    });
  });

  it("uses the compact fallback only when the payload has no meaningful update evidence", () => {
    expect(issueUpdateCopy(null)).toBeNull();
    expect(issueUpdateCopy({ issueId: "cmrnopaque123" })).toBeNull();
  });
});
