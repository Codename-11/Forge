import { TRPCError } from "@trpc/server";
import { Prisma, type PrismaClient } from "@prisma/client";

export type ProfileOwnerType = "PERSONAL" | "SERVICE";
export type AgentPolicyMode = "DISABLED" | "APPROVAL_REQUIRED" | "SELF_SERVICE";
export type ProfileDb = PrismaClient | Prisma.TransactionClient;

export async function readAgentPolicy(db: ProfileDb) {
  const row = await db.instanceAgentPolicy.findUnique({ where: { id: "default" } });
  return { personalAgentCreation: row?.personalAgentCreation ?? ("APPROVAL_REQUIRED" as const) };
}

export async function assertActiveProfileOwner(db: ProfileDb, ownerId: string) {
  const owner = await db.user.findFirst({
    where: { id: ownerId, status: "ACTIVE", deletedAt: null, disabledAt: null },
    select: { id: true },
  });
  if (!owner)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose an active user as the personal agent owner.",
    });
}

export async function assertProfileRuntimeAvailable(
  db: ProfileDb,
  runtimeId: string | null | undefined,
  ownerType: ProfileOwnerType,
  ownerId: string | null,
) {
  if (!runtimeId) return;
  const runtime = await db.runtime.findFirst({
    where: {
      id: runtimeId,
      ...profileRuntimeOptionsWhere(ownerType, ownerId),
    },
    select: { id: true },
  });
  if (!runtime)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "The runtime is not available to this owner. Clear the runtime before transferring ownership, or choose an authorized runtime.",
    });
}

export function profileRuntimeOptionsWhere(
  ownerType: ProfileOwnerType,
  ownerId: string | null,
): Prisma.RuntimeWhereInput {
  return {
    archivedAt: null,
    disabledAt: null,
    ownerType: { not: "UNASSIGNED" },
    OR: [
      { instanceShared: true },
      ...(ownerType === "SERVICE"
        ? [{ ownerType: "SERVICE" as const }]
        : ownerId
          ? [{ ownerType: "PERSONAL" as const, ownerId }]
          : []),
    ],
  };
}

export async function auditAgentProfile(
  db: ProfileDb,
  actor: { actorId: string; ip: string | null; userAgent: string | null },
  action: string,
  metadata: Prisma.InputJsonObject,
) {
  await db.instanceAuditLog.create({
    data: {
      actorId: actor.actorId,
      action,
      metadata,
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    },
  });
}

/** A stale policy, owner, or duplicate key must never silently widen authority. */
export async function profileTransaction<T>(
  db: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  isolationLevel: Prisma.TransactionIsolationLevel = Prisma.TransactionIsolationLevel.Serializable,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.$transaction(work, { isolationLevel });
    } catch (error) {
      // Serializable policy/ownership operations have only transactional DB
      // effects. Retry predicate conflicts; the caller's expected snapshot is
      // still rechecked and never refreshed automatically. Binding operations
      // publish activity, so their explicit row-lock transaction is not retried.
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2034" && isolationLevel === "Serializable" && attempt < 2) continue;
        if (error.code === "P2034" || error.code === "P2002") {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The agent or its ownership policy changed, or this owner already has that agent key. Refresh and try again.",
          });
        }
      }
      throw error;
    }
  }
}
