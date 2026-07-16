import { describe, expect, it } from "vitest";
import {
  activityActorKind,
  activityActorName,
  activityActorOwnerTitle,
} from "@/lib/activity-actor";

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
    expect(
      activityActorOwnerTitle({ actor: { name: "Bailey" }, actorAgent: null }),
    ).toBeUndefined();
  });

  it("falls back through agent handle and human before classifying automation", () => {
    expect(
      activityActorName({
        actor: null,
        actorAgent: { name: null, profileKey: "victor" },
      }),
    ).toBe("@victor");
    expect(activityActorName({ actor: { name: "Bailey" }, actorAgent: null })).toBe("Bailey");
    expect(activityActorName({ actor: null, actorAgent: null })).toBe("Forge automation");
  });

  it("distinguishes worker and connector provenance without a bare system actor", () => {
    const worker = {
      actor: null,
      actorAgent: null,
      kind: "AGENT_RUN_STALLED",
      payload: { action: "watchdog-sweep" },
    };
    expect(activityActorKind(worker)).toBe("worker");
    expect(activityActorName(worker)).toBe("Forge worker");

    const connector = {
      actor: null,
      actorAgent: null,
      kind: "ISSUE_UPDATED",
      payload: { provider: "GITHUB", deliveryId: "delivery-1" },
    };
    expect(activityActorKind(connector)).toBe("connector");
    expect(activityActorName(connector)).toBe("GitHub connector");
  });
});
