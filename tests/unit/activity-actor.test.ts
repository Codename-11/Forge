import { describe, expect, it } from "vitest";
import { activityActorName, activityActorOwnerTitle } from "@/lib/activity-actor";

describe("activityActorName", () => {
  it("shows an agent-linked event as the agent, not the key owner", () => {
    expect(
      activityActorName({
        actor: { name: "Bailey" },
        actorAgent: { name: "Victor", profileKey: "victor" },
      }),
    ).toBe("Victor");
  });

  it("keeps the human key owner as secondary metadata", () => {
    expect(
      activityActorOwnerTitle({
        actor: { name: "Bailey" },
        actorAgent: { name: "Victor", profileKey: "victor" },
      }),
    ).toBe("API key owner: Bailey");
    expect(activityActorOwnerTitle({ actor: { name: "Bailey" }, actorAgent: null })).toBeUndefined();
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
