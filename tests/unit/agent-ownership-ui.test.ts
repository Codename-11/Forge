import { describe, expect, it } from "vitest";
import { agentOwnerLabel, personalAgentCreationCopy } from "@/lib/agent-ownership-ui";
import { matchesAgentView } from "@/lib/agent-setup";

describe("agent ownership presentation", () => {
  it("shows service administration independently of a human owner", () => {
    expect(agentOwnerLabel({ ownerType: "SERVICE", owner: null })).toBe(
      "Service-owned · Instance administrators",
    );
  });
  it("does not label missing personal ownership as service-owned or owned by the viewer", () => {
    expect(agentOwnerLabel({ ownerType: "PERSONAL", owner: null })).toBe("Unavailable owner");
    expect(
      agentOwnerLabel({ ownerType: "PERSONAL", owner: { name: "Bailey" }, ownedByMe: true }),
    ).toBe("Bailey (you)");
  });
  it("offers personal creation only under an explicit supported policy", () => {
    expect(personalAgentCreationCopy().enabled).toBe(false);
    expect(personalAgentCreationCopy("DISABLED").enabled).toBe(false);
    expect(personalAgentCreationCopy("APPROVAL_REQUIRED").label).toBe("Request my agent");
    expect(personalAgentCreationCopy("SELF_SERVICE").label).toBe("Create my agent");
  });
  it("does not confuse service ownership with instance sharing", () => {
    const service = {
      id: "service",
      ownerType: "SERVICE",
      ownedByMe: false,
      instanceShared: false,
      availability: { state: "AVAILABLE" },
      bindings: [],
    };
    expect(matchesAgentView(service, "mine", true)).toBe(false);
    expect(matchesAgentView(service, "available", true)).toBe(true);
    expect(matchesAgentView(service, "available", false)).toBe(false);
    expect(matchesAgentView({ ...service, instanceShared: true }, "available", false)).toBe(true);
  });
});
