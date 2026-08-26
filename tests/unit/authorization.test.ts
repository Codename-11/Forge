import { describe, expect, it } from "vitest";
import {
  assertProjectAction,
  assertWorkspaceAction,
  buildProjectAccessWhere,
  canPerformIntegrationAction,
  canPerformProjectAction,
  canPerformWorkspaceAction,
} from "@/server/services/authorization";
import { ProjectAccessRole, ProjectVisibility } from "@prisma/client";

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

  it("builds the same tenant-scoped predicate used by project lists", () => {
    expect(
      buildProjectAccessWhere({
        workspaceId: "workspace-1",
        membershipId: "membership-1",
        membershipRole: "MEMBER",
        action: "READ",
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      OR: [
        { visibility: ProjectVisibility.WORKSPACE },
        {
          accessGrants: {
            some: {
              membershipId: "membership-1",
              role: {
                in: [
                  ProjectAccessRole.VIEWER,
                  ProjectAccessRole.CONTRIBUTOR,
                  ProjectAccessRole.MANAGER,
                ],
              },
            },
          },
        },
      ],
    });
  });

  it("hides a restricted project from a reader without a grant", async () => {
    const db = {
      project: {
        findFirst: async () => ({
          id: "project-1",
          workspaceId: "workspace-1",
          visibility: ProjectVisibility.RESTRICTED,
          accessGrants: [],
        }),
      },
    } as unknown as Parameters<typeof assertProjectAction>[0];

    await expect(
      assertProjectAction(db, {
        workspaceId: "workspace-1",
        membershipId: "membership-1",
        membershipRole: "MEMBER",
        projectId: "project-1",
        action: "READ",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
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
