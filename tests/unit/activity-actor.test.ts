import { describe, expect, it } from "vitest";
import { activityActorName } from "@/lib/activity-actor";

describe("activityActorName", () => {
  it("shows an agent-linked event as agent via key owner", () => {
    expect(
      activityActorName({
        actor: { name: "Bailey" },
        actorAgent: { name: "Victor", profileKey: "victor" },
      }),
    ).toBe("Victor via Bailey");
  });

  it("falls back through agent handle, human, then system", () => {
    expect(
      activityActorName({
        actor: null,
        actorAgent: { name: null, profileKey: "victor" },
      }),
    ).toBe("@victor");
    expect(activityActorName({ actor: { name: "Bailey" }, actorAgent: null })).toBe("Bailey");
    expect(activityActorName({ actor: null, actorAgent: null })).toBe("system");
  });
});
