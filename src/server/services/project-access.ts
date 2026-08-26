import "server-only";

import type { Membership, Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import {
  assertProjectAction,
  buildProjectAccessWhere,
  resolveProjectDecision,
  type ProjectAction,
} from "@/server/services/authorization";

type DbClient = PrismaClient | Prisma.TransactionClient;
type ViewerMembership = Pick<Membership, "id" | "role">;

export interface ProjectViewer {
  workspaceId: string;
  membership: ViewerMembership;
}

export function projectWhereForViewer(
  viewer: ProjectViewer,
  action: ProjectAction = "READ",
): Prisma.ProjectWhereInput {
  return buildProjectAccessWhere({
    workspaceId: viewer.workspaceId,
    membershipId: viewer.membership.id,
    membershipRole: viewer.membership.role,
    action,
  });
}

/**
 * Project-aware issue predicate for human sessions. Unfiled issues retain the
 * existing collaborative workspace behavior for members, while guests need a
 * concrete project grant and therefore cannot see unfiled work.
 */
export function issueWhereForViewer(
  viewer: ProjectViewer,
  action: ProjectAction = "READ",
): Prisma.IssueWhereInput {
  const project = projectWhereForViewer(viewer, action);
  const canUseUnfiled =
    viewer.membership.role === "OWNER" ||
    viewer.membership.role === "ADMIN" ||
    (viewer.membership.role === "MEMBER" && action !== "MANAGE");
  return {
    workspaceId: viewer.workspaceId,
    OR: [
      ...(canUseUnfiled ? [{ projectId: null } satisfies Prisma.IssueWhereInput] : []),
      { project: project },
    ],
  };
}

export async function assertProjectForViewer(
  db: DbClient,
  viewer: ProjectViewer,
  projectId: string,
  action: ProjectAction,
) {
  return assertProjectAction(db as PrismaClient, {
    workspaceId: viewer.workspaceId,
    membershipId: viewer.membership.id,
    membershipRole: viewer.membership.role,
    projectId,
    action,
  });
}

export async function assertIssueForViewer(
  db: DbClient,
  viewer: ProjectViewer,
  issueId: string,
  action: ProjectAction,
  includeArchived = false,
): Promise<{ id: string; projectId: string | null }> {
  const issue = await db.issue.findFirst({
    where: {
      id: issueId,
      workspaceId: viewer.workspaceId,
      deletedAt: includeArchived ? undefined : null,
      AND: [issueWhereForViewer(viewer, action)],
    },
    select: { id: true, projectId: true },
  });
  if (!issue) {
    const activeIssue = await db.issue.findFirst({
      where: { id: issueId, workspaceId: viewer.workspaceId, deletedAt: null },
      select: { id: true },
    });
    const notFound = action === "READ" || !activeIssue;
    throw new TRPCError({
      code: notFound ? "NOT_FOUND" : "FORBIDDEN",
      message: notFound ? "Issue not found." : "You do not have permission to modify this issue.",
    });
  }
  return issue;
}

export async function assertIssuesForViewer(
  db: DbClient,
  viewer: ProjectViewer,
  issueIds: readonly string[],
  action: ProjectAction,
  includeArchived = false,
): Promise<void> {
  const ids = [...new Set(issueIds)];
  if (ids.length === 0) return;
  const count = await db.issue.count({
    where: {
      id: { in: ids },
      workspaceId: viewer.workspaceId,
      deletedAt: includeArchived ? undefined : null,
      AND: [issueWhereForViewer(viewer, action)],
    },
  });
  if (count !== ids.length) {
    const activeCount = await db.issue.count({
      where: {
        id: { in: ids },
        workspaceId: viewer.workspaceId,
        deletedAt: includeArchived ? undefined : null,
      },
    });
    const notFound = action === "READ" || activeCount !== ids.length;
    throw new TRPCError({
      code: notFound ? "NOT_FOUND" : "FORBIDDEN",
      message: notFound
        ? "One or more issues were not found."
        : "You do not have permission to modify one or more issues.",
    });
  }
}

/** Prevent assignments from becoming an accidental restricted-project grant. */
export async function assertMembersCanReadProject(
  db: DbClient,
  params: { workspaceId: string; projectId: string | null; userIds: readonly string[] },
): Promise<void> {
  const userIds = [...new Set(params.userIds)];
  if (userIds.length === 0) return;
  const memberships = await db.membership.findMany({
    where: { workspaceId: params.workspaceId, userId: { in: userIds } },
    select: { id: true, userId: true, role: true },
  });
  if (memberships.length !== userIds.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Every assignee must be a member of this workspace.",
    });
  }
  for (const membership of memberships) {
    if (!params.projectId) {
      if (membership.role === "GUEST") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "A guest cannot be assigned unfiled work without project access.",
        });
      }
      continue;
    }
    const decision = await resolveProjectDecision(db as PrismaClient, {
      workspaceId: params.workspaceId,
      membershipId: membership.id,
      membershipRole: membership.role,
      projectId: params.projectId,
      action: "READ",
    });
    if (!decision?.allowed) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Every assignee must have access to this issue's project.",
      });
    }
  }
}
