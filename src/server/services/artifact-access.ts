import "server-only";
import type { ArtifactRole, Prisma, PrismaClient, Role } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { buildProjectAccessWhere } from "@/server/services/authorization";

const ROLE_RANK: Record<ArtifactRole, number> = {
  VIEWER: 1,
  COMMENTER: 2,
  EDITOR: 3,
  OWNER: 4,
};

export function isWorkspaceAdmin(role: Role): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export function artifactReadWhere(params: {
  workspaceId: string;
  userId: string;
  membershipId: string;
  membershipRole: Role;
}): Prisma.ArtifactWhereInput {
  const projectAccess = buildProjectAccessWhere({
    workspaceId: params.workspaceId,
    membershipId: params.membershipId,
    membershipRole: params.membershipRole,
    action: "READ",
  });
  const underlyingAccess: Prisma.ArtifactWhereInput = {
    AND: [
      { OR: [{ projectId: null }, { project: { is: projectAccess } }] },
      {
        OR: [
          { issueId: null },
          {
            issue: {
              is: {
                OR: [{ projectId: null }, { project: { is: projectAccess } }],
              },
            },
          },
        ],
      },
    ],
  };
  if (isWorkspaceAdmin(params.membershipRole)) {
    return { workspaceId: params.workspaceId, ...underlyingAccess };
  }
  return {
    workspaceId: params.workspaceId,
    AND: [
      underlyingAccess,
      {
        OR: [
          { visibility: "WORKSPACE" },
          { createdById: params.userId },
          { grants: { some: { userId: params.userId } } },
        ],
      },
    ],
  };
}

export function artifactActorReadWhere(params: {
  workspaceId: string;
  userId?: string | null;
  agentId?: string | null;
}): Prisma.ArtifactWhereInput {
  return {
    workspaceId: params.workspaceId,
    OR: [
      { visibility: "WORKSPACE" },
      ...(params.userId
        ? [{ createdById: params.userId }, { grants: { some: { userId: params.userId } } }]
        : []),
      ...(params.agentId
        ? [{ createdByAgentId: params.agentId }, { grants: { some: { agentId: params.agentId } } }]
        : []),
    ],
  };
}

export async function assertArtifactActorRole(
  db: PrismaClient | Prisma.TransactionClient,
  params: {
    artifactId: string;
    workspaceId: string;
    userId?: string | null;
    agentId?: string | null;
    minimum: ArtifactRole;
  },
) {
  const artifact = await db.artifact.findFirst({
    where: { id: params.artifactId, workspaceId: params.workspaceId },
    select: {
      id: true,
      visibility: true,
      createdById: true,
      createdByAgentId: true,
      grants: {
        where: {
          OR: [
            ...(params.userId ? [{ userId: params.userId }] : []),
            ...(params.agentId ? [{ agentId: params.agentId }] : []),
          ],
        },
        select: { role: true },
      },
    },
  });
  if (!artifact) throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found." });
  let role: ArtifactRole | null = null;
  if (
    (params.userId && artifact.createdById === params.userId) ||
    (params.agentId && artifact.createdByAgentId === params.agentId)
  ) {
    role = "OWNER";
  } else if (artifact.grants.length) {
    role = artifact.grants.reduce<ArtifactRole>(
      (best, grant) => (ROLE_RANK[grant.role] > ROLE_RANK[best] ? grant.role : best),
      artifact.grants[0]!.role,
    );
  } else if (artifact.visibility === "WORKSPACE") {
    role = "COMMENTER";
  }
  if (!role || ROLE_RANK[role] < ROLE_RANK[params.minimum]) {
    if (!role) throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found." });
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${params.minimum.toLowerCase()} artifact access required.`,
    });
  }
  return { artifact, role };
}

export async function assertArtifactRole(
  db: PrismaClient | Prisma.TransactionClient,
  params: {
    artifactId: string;
    workspaceId: string;
    userId: string;
    membershipId: string;
    membershipRole: Role;
    minimum: ArtifactRole;
  },
) {
  const artifact = await db.artifact.findFirst({
    where: {
      id: params.artifactId,
      ...artifactReadWhere(params),
    },
    select: {
      id: true,
      visibility: true,
      createdById: true,
      grants: {
        where: { userId: params.userId },
        select: { role: true },
        take: 1,
      },
    },
  });
  if (!artifact) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found." });
  }

  let role: ArtifactRole | null = null;
  if (isWorkspaceAdmin(params.membershipRole) || artifact.createdById === params.userId) {
    role = "OWNER";
  } else if (artifact.grants[0]) {
    role = artifact.grants[0].role;
  } else if (artifact.visibility === "WORKSPACE") {
    role = "COMMENTER";
  }

  if (!role || ROLE_RANK[role] < ROLE_RANK[params.minimum]) {
    // Do not reveal the existence of private artifacts to callers without read access.
    if (!role) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found." });
    }
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${params.minimum.toLowerCase()} artifact access required.`,
    });
  }
  return { artifact, role };
}
