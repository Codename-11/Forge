import { describe, expect, it } from "vitest";
import { agentSetupDestination, matchesAgentView } from "@/lib/agent-setup";

const workspace = { id: "ws-one", slug: "my-workspace", role: "ADMIN" };
const profile = {
  id: "profile-one",
  ownedByMe: true,
  instanceShared: false,
  availability: { state: "AVAILABLE" },
  bindings: [{ id: "agent-one", workspace: { id: workspace.id } }],
};

describe("agent setup navigation", () => {
  it("connects a runtime without an existing agent while preserving the home workspace", () => {
    expect(agentSetupDestination({ mode: "managed", managedTask: "runtime", workspace })).toBe(
      "/w/my-workspace/settings/runtimes?create=1",
    );
    expect(agentSetupDestination({ mode: "managed", managedTask: "runtime" })).toBeNull();
  });
  it("does not let members or guests register hosts through setup", () => {
    for (const role of ["MEMBER", "GUEST", ""]) {
      expect(
        agentSetupDestination({
          mode: "managed",
          managedTask: "runtime",
          workspace: { ...workspace, role },
        }),
      ).toBeNull();
    }
  });
  it("still requires an identity when configuring an agent rather than registering a host", () => {
    expect(agentSetupDestination({ mode: "managed", managedTask: "agent", workspace })).toBeNull();
  });
  it("requires an explicitly selected workspace", () => {
    expect(agentSetupDestination({ mode: "external" })).toBeNull();
  });
  it("sends personal external clients to scoped personal token setup without a runtime", () => {
    expect(
      agentSetupDestination({ mode: "external", workspace: { ...workspace, role: "MEMBER" } }),
    ).toBe("/w/my-workspace/settings/access?create=personal");
  });
  it("sends an available agent in the selected workspace to linked MCP setup", () => {
    expect(agentSetupDestination({ mode: "external", workspace, profile })).toBe(
      "/w/my-workspace/settings/access?create=agent&agentId=agent-one",
    );
  });
  it("preserves selected workspace when an agent needs workspace access first", () => {
    expect(
      agentSetupDestination({ mode: "external", workspace, profile: { ...profile, bindings: [] } }),
    ).toBe("/agents/profile-one?workspace=ws-one&setup=external");
  });
  it("never issues a key against a different workspace binding", () => {
    expect(
      agentSetupDestination({
        mode: "external",
        workspace: { ...workspace, id: "ws-two" },
        profile,
      }),
    ).toBe("/agents/profile-one?workspace=ws-two&setup=external");
  });
  it("routes members to the agent detail rather than administrator credential setup", () => {
    expect(
      agentSetupDestination({
        mode: "external",
        workspace: { ...workspace, role: "MEMBER" },
        profile,
      }),
    ).toBe("/agents/profile-one?workspace=ws-one&setup=external");
  });
  it("keeps managed execution and external credential routes distinct", () => {
    expect(agentSetupDestination({ mode: "managed", workspace, profile })).toBe(
      "/agents/profile-one?workspace=ws-one&setup=managed",
    );
    expect(
      agentSetupDestination({
        mode: "managed",
        workspace: { ...workspace, role: "MEMBER" },
        profile,
      }),
    ).toBeNull();
  });
  it("blocks unavailable profiles and guests", () => {
    for (const state of ["PENDING_APPROVAL", "DISABLED", "ARCHIVED"]) {
      expect(
        agentSetupDestination({
          mode: "external",
          workspace,
          profile: { ...profile, availability: { state } },
        }),
      ).toBeNull();
    }
    expect(
      agentSetupDestination({ mode: "external", workspace: { ...workspace, role: "GUEST" } }),
    ).toBeNull();
  });
});

describe("agent catalog views", () => {
  it("separates ownership from catalog sharing", () => {
    const shared = { ...profile, ownedByMe: false, instanceShared: true };
    expect(matchesAgentView(shared, "mine", false)).toBe(false);
    expect(matchesAgentView(shared, "available", false)).toBe(true);
    expect(matchesAgentView(profile, "mine", false)).toBe(true);
    expect(matchesAgentView(profile, "available", false)).toBe(true);
  });
  it("reserves all-profiles view for instance admins and excludes unavailable agents from setup", () => {
    const unavailable = { ...profile, availability: { state: "PENDING_APPROVAL" } };
    expect(matchesAgentView(unavailable, "mine", false)).toBe(true);
    expect(matchesAgentView(unavailable, "available", false)).toBe(false);
    expect(matchesAgentView(unavailable, "all", false)).toBe(false);
    expect(matchesAgentView(unavailable, "all", true)).toBe(true);
    expect(matchesAgentView({ ...profile, ownedByMe: false }, "available", true)).toBe(false);
  });
});
