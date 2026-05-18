import { describe, expect, it } from "vitest";
import { WORKSPACE_NAV_SECTIONS } from "@/components/sidebar-nav";

describe("workspace sidebar navigation", () => {
  it("surfaces Chat as a top-level Work item between Inbox and Issues with g m shortcut", () => {
    const work = WORKSPACE_NAV_SECTIONS.find((section) => section.id === "work");
    expect(work).toBeTruthy();
    const labels = work?.items.map((item) => item.label);
    expect(labels).toEqual(["Dashboard", "Inbox", "Chat", "Issues", "Projects", "Time"]);
    expect(work?.items.find((item) => item.label === "Chat")).toMatchObject({
      path: "/chat",
      chord: "m",
    });
  });
});
