import {
  IntegrationCapability,
  ProjectAccessRole,
  ProjectVisibility,
  type Prisma,
  type PrismaClient,
  type Role,
} from "@prisma/client";
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

const PROJECT_ACCESS_ROLES: Record<ProjectAction, ProjectAccessRole[]> = {
  READ: [ProjectAccessRole.VIEWER, ProjectAccessRole.CONTRIBUTOR, ProjectAccessRole.MANAGER],
  CONTRIBUTE: [ProjectAccessRole.CONTRIBUTOR, ProjectAccessRole.MANAGER],
  MANAGE: [ProjectAccessRole.MANAGER],
};

/**
 * Tenant-scoped list predicate matching {@link canPerformProjectAction}.
 * Callers must AND this fragment with any resource-specific filters.
 */
export function buildProjectAccessWhere(params: {
  workspaceId: string;
  membershipId: string;
  membershipRole: Role;
  action: ProjectAction;
}): Prisma.ProjectWhereInput {
  const tenant = { workspaceId: params.workspaceId };
  if (isWorkspaceAdmin(params.membershipRole)) return tenant;

  const explicit: Prisma.ProjectWhereInput = {
    accessGrants: {
      some: {
        membershipId: params.membershipId,
        role: { in: PROJECT_ACCESS_ROLES[params.action] },
      },
    },
  };

  if (params.membershipRole === "MEMBER" && params.action !== "MANAGE") {
    return {
      ...tenant,
      OR: [{ visibility: ProjectVisibility.WORKSPACE }, explicit],
    };
  }

  return { ...tenant, ...explicit };
}

type ProjectAuthorizationDb = Pick<PrismaClient, "project">;

export interface ProjectDecision {
  project: {
    id: string;
    workspaceId: string;
    visibility: ProjectVisibility;
  };
  accessRole: ProjectAccessRole | null;
  allowed: boolean;
}

/** Resolve one project decision without leaking a cross-tenant row. */
export async function resolveProjectDecision(
  db: ProjectAuthorizationDb,
  params: {
    workspaceId: string;
    membershipId: string;
    membershipRole: Role;
    projectId: string;
    action: ProjectAction;
  },
): Promise<ProjectDecision | null> {
  const project = await db.project.findFirst({
    where: { id: params.projectId, workspaceId: params.workspaceId, deletedAt: null },
    select: {
      id: true,
      workspaceId: true,
      visibility: true,
      accessGrants: {
        where: { membershipId: params.membershipId },
        select: { role: true },
        take: 1,
      },
    },
  });
  if (!project) return null;
  const accessRole = project.accessGrants[0]?.role ?? null;
  return {
    project: {
      id: project.id,
      workspaceId: project.workspaceId,
      visibility: project.visibility,
    },
    accessRole,
    allowed: canPerformProjectAction({
      membershipRole: params.membershipRole,
      visibility: project.visibility,
      accessRole,
      action: params.action,
    }),
  };
}

/**
 * Assert project authority. READ denials intentionally use NOT_FOUND so a
 * restricted project's existence is not disclosed to an untrusted member.
 */
export async function assertProjectAction(
  db: ProjectAuthorizationDb,
  params: Parameters<typeof resolveProjectDecision>[1],
): Promise<ProjectDecision> {
  const decision = await resolveProjectDecision(db, params);
  if (!decision || !decision.allowed) {
    throw new TRPCError({
      code: params.action === "READ" ? "NOT_FOUND" : "FORBIDDEN",
      message:
        params.action === "READ"
          ? "Project not found."
          : "You do not have permission to modify this project.",
    });
  }
  return decision;
}

/**
 * External credentials are a separate authorization layer. A Forge role or
 * project grant never implies permission to use a GitHub/OAuth credential;
 * the resolved integration grant must explicitly contain the capability too.
 */
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
