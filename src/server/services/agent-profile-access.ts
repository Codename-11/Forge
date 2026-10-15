import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";

type ProfileAccess = {
  ownerId: string | null;
  ownerType: "PERSONAL" | "SERVICE" | "UNASSIGNED";
  instanceShared: boolean;
  archivedAt: Date | null;
  disabledAt: Date | null;
  requestedById: string | null;
  approvedAt: Date | null;
};

/** Read surfaces expose credential presence, never the dispatch credential. */
export function publicAgentDefinition<T extends { webhookSecret: string | null }>(definition: T) {
  const { webhookSecret, ...safe } = definition;
  return { ...safe, hasWebhookSecret: Boolean(webhookSecret) };
}

export function canViewAgentWorkspace(
  workspaceId: string,
  membershipIds: Set<string>,
  isInstanceAdmin: boolean,
) {
  return isInstanceAdmin || membershipIds.has(workspaceId);
}

/** Availability is catalog eligibility; it never grants workspace access. */
export function agentProfileAvailability(profile: ProfileAccess) {
  return {
    scope: profile.instanceShared
      ? ("INSTANCE_CATALOG" as const)
      : profile.ownerType === "SERVICE"
        ? ("ADMIN_ONLY" as const)
        : ("OWNER_ONLY" as const),
    state: profile.archivedAt
      ? ("ARCHIVED" as const)
      : profile.disabledAt
        ? ("DISABLED" as const)
        : profile.requestedById && !profile.approvedAt
          ? ("PENDING_APPROVAL" as const)
          : ("AVAILABLE" as const),
  };
}

export function availableAgentProfilesWhere(
  userId: string,
  isInstanceAdmin: boolean,
): Prisma.AgentProfileWhereInput {
  return {
    archivedAt: null,
    disabledAt: null,
    AND: [
      ...(isInstanceAdmin ? [] : [{ OR: [{ ownerId: userId }, { instanceShared: true }] }]),
      { OR: [{ requestedById: null }, { approvedAt: { not: null } }] },
    ],
  };
}

/** Both setup entrypoints enforce the same lifecycle and availability policy. */
export function assertAgentProfileBindable(
  profile: ProfileAccess | null,
  userId: string,
  isInstanceAdmin: boolean,
): asserts profile is ProfileAccess {
  if (!profile || profile.archivedAt) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found." });
  }
  if (profile.ownerId !== userId && !profile.instanceShared && !isInstanceAdmin) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "That profile isn't available to this workspace.",
    });
  }
  if (profile.disabledAt) {
    throw new TRPCError({ code: "FORBIDDEN", message: "That profile is disabled." });
  }
  if (profile.requestedById && !profile.approvedAt) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "That profile is pending instance-admin approval.",
    });
  }
}
