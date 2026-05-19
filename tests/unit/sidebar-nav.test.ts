import { describe, expect, it } from "vitest";
import { WORKSPACE_NAV_SECTIONS } from "@/components/sidebar-nav";

describe("workspace sidebar navigation", () => {
  it("surfaces Chat as a top-level Work item with g m shortcut", () => {
    const work = WORKSPACE_NAV_SECTIONS.find((section) => section.id === "work");
    expect(work).toBeTruthy();
    expect(work?.items.find((item) => item.label === "Chat")).toMatchObject({
      path: "/chat",
      chord: "m",
    });
  });

  it("surfaces Command Center under Work with the g j shortcut", () => {
    const work = WORKSPACE_NAV_SECTIONS.find((section) => section.id === "work");
    expect(work?.items.find((item) => item.label === "Command Center")).toMatchObject({
      path: "/command-center",
      chord: "j",
    });
  });

  it("surfaces Artifacts under Planning with the g f shortcut", () => {
    const planning = WORKSPACE_NAV_SECTIONS.find((section) => section.id === "planning");
    expect(planning).toBeTruthy();
    expect(planning?.items.find((item) => item.label === "Artifacts")).toMatchObject({
      path: "/artifacts",
      chord: "f",
    });
  });
});
