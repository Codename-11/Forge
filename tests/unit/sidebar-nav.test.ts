import { describe, expect, it } from "vitest";
import {
  PERSONAL_WORKSPACE_NAV_SECTIONS,
  WORKSPACE_NAV_SECTIONS,
} from "@/components/sidebar-nav";

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

  it("surfaces Plans under Planning with the g l shortcut", () => {
    const planning = WORKSPACE_NAV_SECTIONS.find((section) => section.id === "planning");
    expect(planning?.items.find((item) => item.label === "Plans")).toMatchObject({
      path: "/plans",
      chord: "l",
    });
  });

  it("surfaces Canvas under Planning with the g k shortcut", () => {
    const planning = WORKSPACE_NAV_SECTIONS.find((section) => section.id === "planning");
    expect(planning?.items.find((item) => item.label === "Canvas")).toMatchObject({
      path: "/canvas",
      chord: "k",
    });
  });

  it("surfaces Review under Work with the g v shortcut", () => {
    const work = WORKSPACE_NAV_SECTIONS.find((section) => section.id === "work");
    expect(work?.items.find((item) => item.label === "Review")).toMatchObject({
      path: "/review",
      chord: "v",
    });
  });

  it("surfaces Scheduled tasks as first-class Automation navigation", () => {
    const automation = WORKSPACE_NAV_SECTIONS.find((section) => section.id === "automation");
    expect(automation?.items.find((item) => item.label === "Scheduled tasks")).toMatchObject({
      path: "/scheduled-tasks",
      chord: "q",
    });
  });

  it("does not double-assign any chord", () => {
    const chords = WORKSPACE_NAV_SECTIONS.flatMap((s) => s.items)
      .map((i) => i.chord)
      .filter((c): c is string => Boolean(c));
    expect(new Set(chords).size).toBe(chords.length);
  });
});

describe("personal workspace sidebar navigation", () => {
  it("reframes the primary workflow around today and tasks", () => {
    const personal = PERSONAL_WORKSPACE_NAV_SECTIONS.find((section) => section.id === "personal");
    expect(personal?.items.map((item) => item.label)).toEqual([
      "Today",
      "Inbox",
      "Tasks",
      "Upcoming",
      "Notes",
    ]);
  });

  it("keeps agents, chat, and routines directly available", () => {
    const assist = PERSONAL_WORKSPACE_NAV_SECTIONS.find((section) => section.id === "assist");
    expect(assist?.items.map((item) => item.label)).toEqual(["Chat", "Routines", "Agents"]);
  });

  it("does not double-assign personal navigation chords", () => {
    const chords = PERSONAL_WORKSPACE_NAV_SECTIONS.flatMap((section) => section.items)
      .map((item) => item.chord)
      .filter((chord): chord is string => Boolean(chord));
    expect(new Set(chords).size).toBe(chords.length);
  });
});
