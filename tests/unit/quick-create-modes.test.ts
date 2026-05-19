import { describe, expect, it } from "vitest";
import { SWITCHABLE_MODES } from "@/components/quick-create";

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
