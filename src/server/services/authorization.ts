import type { Role } from "@prisma/client";
import { TRPCError } from "@trpc/server";

/**
 * Workspace actions that can be decided from Membership.role alone.
 *
 * Resource-specific authorization (restricted projects and external
 * integrations) is evaluated separately below. Keeping those decisions out of
 * tRPC procedure selection prevents a membership check from being mistaken for
 * permission to mutate every resource in a workspace.
 */
export type WorkspaceAction =
  | "READ_WORKSPACE"
  | "CREATE_PROJECT"
  | "MUTATE_PROJECT"
  | "MANAGE_WORKSPACE";

const WORKSPACE_ACTION_ROLES: Record<WorkspaceAction, readonly Role[]> = {
  READ_WORKSPACE: ["OWNER", "ADMIN", "MEMBER", "GUEST"],
  CREATE_PROJECT: ["OWNER", "ADMIN", "MEMBER"],
  MUTATE_PROJECT: ["OWNER", "ADMIN", "MEMBER"],
  MANAGE_WORKSPACE: ["OWNER", "ADMIN"],
};

export function isWorkspaceAdmin(role: Role): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export function canPerformWorkspaceAction(role: Role, action: WorkspaceAction): boolean {
  return WORKSPACE_ACTION_ROLES[action].includes(role);
}

export function assertWorkspaceAction(role: Role, action: WorkspaceAction): void {
  if (!canPerformWorkspaceAction(role, action)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Your workspace role does not permit this action.",
    });
  }
}

/**
 * Schema-independent policy inputs for the future ProjectAccess model.
 * These string unions deliberately do not claim that persistence exists yet;
 * callers pass the resolved grant (or null) after loading it.
 */
export type ProjectVisibility = "WORKSPACE" | "RESTRICTED";
export type ProjectAccessRole = "VIEWER" | "CONTRIBUTOR" | "MANAGER";
export type ProjectAction = "READ" | "CONTRIBUTE" | "MANAGE";

const PROJECT_ROLE_RANK: Record<ProjectAccessRole, number> = {
  VIEWER: 1,
  CONTRIBUTOR: 2,
  MANAGER: 3,
};

const PROJECT_ACTION_RANK: Record<ProjectAction, number> = {
  READ: 1,
  CONTRIBUTE: 2,
  MANAGE: 3,
};

export function canPerformProjectAction(params: {
  membershipRole: Role;
  visibility: ProjectVisibility;
  accessRole: ProjectAccessRole | null;
  action: ProjectAction;
}): boolean {
  if (isWorkspaceAdmin(params.membershipRole)) return true;

  if (params.accessRole) {
    return PROJECT_ROLE_RANK[params.accessRole] >= PROJECT_ACTION_RANK[params.action];
  }

  // Members retain the existing collaborative behavior for workspace-visible
  // projects. Guests never inherit project access, and restricted projects
  // always require an explicit grant.
  return (
    params.membershipRole === "MEMBER" &&
    params.visibility === "WORKSPACE" &&
    params.action !== "MANAGE"
  );
}

/**
 * External credentials are a separate authorization layer. A Forge role or
 * project grant never implies permission to use a GitHub/OAuth credential;
 * the resolved integration grant must explicitly contain the capability too.
 */
export type IntegrationCapability = "READ" | "IMPORT" | "LINK" | "SYNC" | "WRITE" | "ADMIN";
export type IntegrationAction = IntegrationCapability;

const INTEGRATION_PROJECT_ACTION: Record<IntegrationAction, ProjectAction> = {
  READ: "READ",
  IMPORT: "CONTRIBUTE",
  LINK: "CONTRIBUTE",
  SYNC: "CONTRIBUTE",
  WRITE: "CONTRIBUTE",
  ADMIN: "MANAGE",
};

export function canPerformIntegrationAction(params: {
  membershipRole: Role;
  projectVisibility: ProjectVisibility;
  projectAccessRole: ProjectAccessRole | null;
  grantedCapabilities: readonly IntegrationCapability[];
  action: IntegrationAction;
}): boolean {
  if (!params.grantedCapabilities.includes(params.action)) return false;

  return canPerformProjectAction({
    membershipRole: params.membershipRole,
    visibility: params.projectVisibility,
    accessRole: params.projectAccessRole,
    action: INTEGRATION_PROJECT_ACTION[params.action],
  });
}
