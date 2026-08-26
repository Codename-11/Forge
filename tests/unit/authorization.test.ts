import { describe, expect, it } from "vitest";
import {
  assertWorkspaceAction,
  canPerformIntegrationAction,
  canPerformProjectAction,
  canPerformWorkspaceAction,
} from "@/server/services/authorization";

describe("workspace authorization", () => {
  it("allows every member role to read the workspace", () => {
    for (const role of ["OWNER", "ADMIN", "MEMBER", "GUEST"] as const) {
      expect(canPerformWorkspaceAction(role, "READ_WORKSPACE")).toBe(true);
    }
  });

  it("does not let guests create or mutate projects", () => {
    expect(canPerformWorkspaceAction("GUEST", "CREATE_PROJECT")).toBe(false);
    expect(canPerformWorkspaceAction("GUEST", "MUTATE_PROJECT")).toBe(false);
    expect(() => assertWorkspaceAction("GUEST", "MUTATE_PROJECT")).toThrow(/workspace role/i);
  });

  it("preserves project mutation access for members and workspace admins", () => {
    for (const role of ["OWNER", "ADMIN", "MEMBER"] as const) {
      expect(canPerformWorkspaceAction(role, "CREATE_PROJECT")).toBe(true);
      expect(canPerformWorkspaceAction(role, "MUTATE_PROJECT")).toBe(true);
    }
    expect(canPerformWorkspaceAction("MEMBER", "MANAGE_WORKSPACE")).toBe(false);
  });
});

describe("project authorization policy", () => {
  it("gives members implicit read and contribution on workspace-visible projects", () => {
    expect(
      canPerformProjectAction({
        membershipRole: "MEMBER",
        visibility: "WORKSPACE",
        accessRole: null,
        action: "CONTRIBUTE",
      }),
    ).toBe(true);
    expect(
      canPerformProjectAction({
        membershipRole: "MEMBER",
        visibility: "WORKSPACE",
        accessRole: null,
        action: "MANAGE",
      }),
    ).toBe(false);
  });

  it("requires an explicit sufficient grant for guests and restricted projects", () => {
    expect(
      canPerformProjectAction({
        membershipRole: "GUEST",
        visibility: "WORKSPACE",
        accessRole: null,
        action: "READ",
      }),
    ).toBe(false);
    expect(
      canPerformProjectAction({
        membershipRole: "MEMBER",
        visibility: "RESTRICTED",
        accessRole: null,
        action: "READ",
      }),
    ).toBe(false);
    expect(
      canPerformProjectAction({
        membershipRole: "GUEST",
        visibility: "RESTRICTED",
        accessRole: "CONTRIBUTOR",
        action: "CONTRIBUTE",
      }),
    ).toBe(true);
    expect(
      canPerformProjectAction({
        membershipRole: "GUEST",
        visibility: "RESTRICTED",
        accessRole: "VIEWER",
        action: "CONTRIBUTE",
      }),
    ).toBe(false);
  });

  it("lets workspace admins manage any project", () => {
    expect(
      canPerformProjectAction({
        membershipRole: "ADMIN",
        visibility: "RESTRICTED",
        accessRole: null,
        action: "MANAGE",
      }),
    ).toBe(true);
  });
});

describe("integration authorization policy", () => {
  it("requires both project authority and the exact external capability", () => {
    const base = {
      membershipRole: "MEMBER" as const,
      projectVisibility: "WORKSPACE" as const,
      projectAccessRole: null,
      grantedCapabilities: ["READ", "LINK"] as const,
    };
    expect(canPerformIntegrationAction({ ...base, action: "LINK" })).toBe(true);
    expect(canPerformIntegrationAction({ ...base, action: "SYNC" })).toBe(false);
    expect(canPerformIntegrationAction({ ...base, action: "ADMIN" })).toBe(false);
  });

  it("does not let workspace admin status replace an integration grant", () => {
    expect(
      canPerformIntegrationAction({
        membershipRole: "OWNER",
        projectVisibility: "RESTRICTED",
        projectAccessRole: null,
        grantedCapabilities: [],
        action: "READ",
      }),
    ).toBe(false);
  });

  it("requires project access as well as a credential grant", () => {
    expect(
      canPerformIntegrationAction({
        membershipRole: "GUEST",
        projectVisibility: "RESTRICTED",
        projectAccessRole: null,
        grantedCapabilities: ["READ"],
        action: "READ",
      }),
    ).toBe(false);
  });
});
