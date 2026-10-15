import { Prisma, type PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

type Database = PrismaClient | Prisma.TransactionClient;
export type RuntimeOwnerType = "PERSONAL" | "SERVICE" | "UNASSIGNED";
export type RuntimeLifecycleExpected = {
  id: string;
  expectedWorkspaceId: string;
  expectedOwnerType: RuntimeOwnerType;
  expectedOwnerId: string | null;
  expectedUpdatedAt: Date;
  confirmName: string;
};
export type RuntimeTransferInput = RuntimeLifecycleExpected & {
  targetWorkspaceId: string;
  ownerType: "PERSONAL" | "SERVICE";
  ownerId: string | null;
};

/** Shared browser/MCP policy. Caller must lock/recheck the row before writing. */
export async function assertCanManageRuntime(input: {
  db: Database;
  runtime: {
    workspaceId: string;
    ownerType: RuntimeOwnerType;
    ownerId: string | null;
    instanceShared: boolean;
  };
  userId: string | null;
}) {
  if (!input.userId)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "A human administrator or runtime owner must manage this registration.",
    });
  const user = await input.db.user.findUnique({
    where: { id: input.userId },
    select: { instanceRole: true, deletedAt: true, disabledAt: true, status: true },
  });
  if (!user || user.deletedAt || user.disabledAt || user.status !== "ACTIVE")
    throw new TRPCError({ code: "FORBIDDEN", message: "Active user authority is required." });
  if (user.instanceRole === "INSTANCE_ADMIN") return;
  if (input.runtime.instanceShared || input.runtime.ownerType !== "PERSONAL") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only an instance administrator can change shared, service-owned, or unassigned runtimes.",
    });
  }
  const membership = await input.db.membership.findUnique({
    where: { userId_workspaceId: { userId: input.userId, workspaceId: input.runtime.workspaceId } },
    select: { role: true },
  });
  if (
    !membership ||
    (input.runtime.ownerId !== input.userId && !["OWNER", "ADMIN"].includes(membership.role))
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only the runtime owner or a workspace administrator can manage this personal runtime.",
    });
  }
}

/** Use for scoped mutations, including writes to runtime child configuration. */
export async function lockManagedRuntime(
  tx: Prisma.TransactionClient,
  id: string,
  workspaceId: string,
  userId: string | null,
) {
  await tx.$queryRaw`SELECT "id" FROM "Runtime" WHERE "id" = ${id} FOR UPDATE`;
  const runtime = await tx.runtime.findFirst({ where: { id, workspaceId } });
  if (!runtime)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Runtime not found in this workspace. Refresh before editing.",
    });
  await assertCanManageRuntime({ db: tx, runtime, userId });
  // Child configuration writes must invalidate a reviewed lifecycle snapshot
  // too. This helper is only used on mutation paths, inside their transaction.
  return tx.runtime.update({ where: { id }, data: {
    updatedAt: new Date(Math.max(Date.now(), runtime.updatedAt.getTime() + 1)),
  } });
}

const runtimeSnapshot = {
  id: true,
  name: true,
  workspaceId: true,
  ownerType: true,
  ownerId: true,
  instanceShared: true,
  archivedAt: true,
  disabledAt: true,
  updatedAt: true,
  owner: { select: { id: true, name: true, email: true } },
  workspace: { select: { id: true, name: true, slug: true, key: true } },
} satisfies Prisma.RuntimeSelect;

/** Read-only, metadata-only impact. Mutations repeat this inside locked transactions. */
export async function runtimeLifecycleImpact(db: Database, id: string, targetWorkspaceId?: string) {
  const runtime = await db.runtime.findUnique({ where: { id }, select: runtimeSnapshot });
  if (!runtime) throw new TRPCError({ code: "NOT_FOUND", message: "Runtime not found." });
  const agentWhere: Prisma.AgentWhereInput = {
    OR: [{ runtimeId: id }, { profile: { runtimeId: id } }],
  };
  const runWhere: Prisma.AgentRunWhereInput = {
    OR: [{ agent: agentWhere }, { connection: { runtimeId: id } }],
  };
  const deliveryWhere: Prisma.WorkSessionWhereInput = {
    OR: [
      { ownerAgent: agentWhere },
      { ownerConnection: { runtimeId: id } },
      { participants: { some: { connection: { runtimeId: id } } } },
    ],
  };
  const [
    agents,
    profiles,
    connections,
    connectorSessions,
    diagnostics,
    secrets,
    repos,
    runHistory,
    deliveryHistory,
    activeRuns,
    activeDelivery,
    activeConnections,
    activeConnectorSessions,
    pendingDiagnostics,
    sensitive,
  ] = await Promise.all([
    db.agent.count({ where: agentWhere }),
    db.agentProfile.count({ where: { runtimeId: id } }),
    db.agentConnection.count({ where: { runtimeId: id } }),
    db.connectorSession.count({ where: { runtimeId: id } }),
    db.runtimeDiagnosticAttempt.count({ where: { runtimeId: id } }),
    db.runtimeSecret.count({ where: { runtimeId: id } }),
    db.runtimeRepo.count({ where: { runtimeId: id } }),
    db.agentRun.count({ where: runWhere }),
    db.workSession.count({ where: deliveryWhere }),
    db.agentRun.count({ where: { ...runWhere, status: { notIn: ["COMPLETED", "ABANDONED"] } } }),
    db.workSession.count({ where: { ...deliveryWhere, endedAt: null } }),
    db.agentConnection.count({
      where: { runtimeId: id, revokedAt: null, status: { notIn: ["REVOKED", "DISCONNECTED"] } },
    }),
    db.connectorSession.count({ where: { runtimeId: id, lifecycle: { not: "CLOSED" } } }),
    db.runtimeDiagnosticAttempt.count({ where: { runtimeId: id, completedAt: null } }),
    db.runtime.findUniqueOrThrow({
      where: { id },
      select: { secret: true, config: true, githubAppId: true, endpoint: true },
    }),
  ]);
  const counts = {
    agents,
    profiles,
    connections,
    connectorSessions,
    diagnostics,
    secrets,
    repos,
    runHistory,
    deliveryHistory,
  };
  const common: string[] = [];
  if (!runtime.archivedAt || !runtime.disabledAt)
    common.push(
      "Archive and disable this runtime before changing ownership, moving it, or removing its registration.",
    );
  if (agents)
    common.push(
      `${agents} workspace agent association(s) still use this runtime. Reconfigure those agents first; archived associations also count.`,
    );
  if (profiles)
    common.push(
      `${profiles} agent definition(s) still use this runtime. Choose another execution host or clear their runtime first.`,
    );
  if (activeRuns)
    common.push(
      `${activeRuns} nonterminal run(s) remain. Complete or explicitly abandon them before proceeding.`,
    );
  if (activeDelivery)
    common.push(
      `${activeDelivery} active delivery session(s) remain. Resolve their ownership and disposition first.`,
    );
  if (activeConnections)
    common.push(
      `${activeConnections} connection(s) are active or unconfirmed. Disconnect or revoke them explicitly; silence is not completion.`,
    );
  if (activeConnectorSessions)
    common.push(
      `${activeConnectorSessions} connector session(s) are not closed. Close them before proceeding.`,
    );
  if (pendingDiagnostics)
    common.push(
      `${pendingDiagnostics} diagnostic request(s) are unfinished. Wait for completion or resolve the requests first.`,
    );
  const transferBlockers = [...common];
  const hasAdapterConfig = !!sensitive.config && Object.keys(sensitive.config).length > 0;
  let hasEndpointCredentialHints = false;
  if (sensitive.endpoint) {
    try {
      const endpoint = new URL(sensitive.endpoint);
      hasEndpointCredentialHints = !!(endpoint.username || endpoint.password || endpoint.search);
    } catch {
      hasEndpointCredentialHints = true;
    }
  }
  if (
    secrets ||
    repos ||
    sensitive.secret ||
    hasAdapterConfig ||
    sensitive.githubAppId ||
    hasEndpointCredentialHints
  ) {
    transferBlockers.push(
      "Credential or execution configuration is still attached (secrets, repositories, GitHub App, inline secret, adapter configuration, or endpoint credentials/query parameters). Review and remove it in the current home before transfer; no configuration or credentials are moved implicitly.",
    );
  }
  if (
    targetWorkspaceId &&
    targetWorkspaceId !== runtime.workspaceId &&
    (connections || connectorSessions || diagnostics || runHistory || deliveryHistory)
  ) {
    transferBlockers.push(
      "Historical workspace-scoped connections, sessions, diagnostics, runs, or delivery records remain. Keep this registration in its original home; create a new runtime in the target workspace instead.",
    );
  }
  const removeBlockers = [...common];
  if (connections || connectorSessions || diagnostics || runHistory || deliveryHistory) {
    removeBlockers.push(
      "This runtime has connection, session, diagnostic, run, or delivery history. Keep it archived to preserve evidence; permanent removal is only available for unused registrations.",
    );
  }
  return {
    runtime,
    counts,
    transferBlockers,
    removeBlockers,
    configuration: {
      hasInlineSecret: !!sensitive.secret,
      hasAdapterConfig,
      hasEndpointCredentialHints,
      hasGithubApp: !!sensitive.githubAppId,
    },
  };
}

/** Lock parent resources first, then the runtime and reference rows in stable order. */
async function lockRuntimeLifecycle(
  tx: Prisma.TransactionClient,
  input: RuntimeLifecycleExpected,
  targetWorkspaceId?: string,
) {
  const workspaceIds = [
    ...new Set([input.expectedWorkspaceId, targetWorkspaceId].filter((id): id is string => !!id)),
  ].sort();
  await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" IN (${Prisma.join(workspaceIds)}) ORDER BY "id" FOR UPDATE`;
  const locked = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT "id" FROM "Runtime" WHERE "id" = ${input.id} FOR UPDATE`;
  if (!locked.length) throw new TRPCError({ code: "NOT_FOUND", message: "Runtime not found." });
  const runtime = await tx.runtime.findUniqueOrThrow({
    where: { id: input.id },
    select: runtimeSnapshot,
  });
  if (
    runtime.workspaceId !== input.expectedWorkspaceId ||
    runtime.ownerType !== input.expectedOwnerType ||
    runtime.ownerId !== input.expectedOwnerId ||
    runtime.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Runtime ownership or configuration changed. Refresh the impact preview and confirm again.",
    });
  }
  if (runtime.name !== input.confirmName)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Type the exact runtime name to confirm.",
    });
  // Parent FK locks stop new references. Lock retained history too, so a
  // concurrent resume cannot turn a terminal connection/session/run live
  // between the impact read and the ownership change.
  await tx.$queryRaw`SELECT "id" FROM "AgentConnection" WHERE "runtimeId" = ${input.id} ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "ConnectorSession" WHERE "runtimeId" = ${input.id} ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "RuntimeDiagnosticAttempt" WHERE "runtimeId" = ${input.id} ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT r."id" FROM "AgentRun" r JOIN "AgentConnection" c ON c."id" = r."connectionId" WHERE c."runtimeId" = ${input.id} ORDER BY r."id" FOR UPDATE OF r`;
  await tx.$queryRaw`SELECT w."id" FROM "WorkSession" w WHERE w."ownerConnectionId" IN (SELECT "id" FROM "AgentConnection" WHERE "runtimeId" = ${input.id}) OR w."id" IN (SELECT p."workSessionId" FROM "WorkSessionParticipant" p JOIN "AgentConnection" c ON c."id" = p."connectionId" WHERE c."runtimeId" = ${input.id}) ORDER BY w."id" FOR UPDATE OF w`;
  return runtime;
}

export async function transferRuntime(
  tx: Prisma.TransactionClient,
  input: RuntimeTransferInput,
  actorId: string,
) {
  const before = await lockRuntimeLifecycle(tx, input, input.targetWorkspaceId);
  const target = await tx.workspace.findUnique({
    where: { id: input.targetWorkspaceId },
    select: { id: true, deletedAt: true },
  });
  if (!target || target.deletedAt)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose an active destination workspace.",
    });
  if ((input.ownerType === "PERSONAL") !== !!input.ownerId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Personal ownership requires a user; service ownership must not have a personal owner.",
    });
  }
  if (input.ownerId) {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.ownerId} FOR UPDATE`;
    const owner = await tx.user.findUnique({
      where: { id: input.ownerId },
      select: { id: true, deletedAt: true, disabledAt: true, status: true },
    });
    const member = await tx.membership.findUnique({
      where: {
        userId_workspaceId: { userId: input.ownerId, workspaceId: input.targetWorkspaceId },
      },
    });
    if (!owner || owner.deletedAt || owner.disabledAt || owner.status !== "ACTIVE" || !member) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "The personal owner must be an active member of the destination workspace.",
      });
    }
  }
  const impact = await runtimeLifecycleImpact(tx, input.id, input.targetWorkspaceId);
  if (impact.transferBlockers.length)
    throw new TRPCError({ code: "CONFLICT", message: impact.transferBlockers.join(" ") });
  const updated = await tx.runtime.update({
    where: { id: input.id },
    data: {
      workspaceId: input.targetWorkspaceId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
    },
    select: runtimeSnapshot,
  });
  await tx.instanceAuditLog.create({
    data: {
      actorId,
      action: "runtime.lifecycle.transfer",
      metadata: {
        runtimeId: input.id,
        before: {
          workspaceId: before.workspaceId,
          ownerType: before.ownerType,
          ownerId: before.ownerId,
        },
        after: {
          workspaceId: updated.workspaceId,
          ownerType: updated.ownerType,
          ownerId: updated.ownerId,
        },
      },
    },
  });
  return updated;
}

export async function removeRuntime(
  tx: Prisma.TransactionClient,
  input: RuntimeLifecycleExpected,
  actorId: string,
) {
  const before = await lockRuntimeLifecycle(tx, input);
  const impact = await runtimeLifecycleImpact(tx, input.id);
  if (impact.removeBlockers.length)
    throw new TRPCError({ code: "CONFLICT", message: impact.removeBlockers.join(" ") });
  await tx.runtime.delete({ where: { id: input.id } });
  await tx.instanceAuditLog.create({
    data: {
      actorId,
      action: "runtime.lifecycle.remove",
      metadata: {
        runtimeId: before.id,
        name: before.name,
        workspaceId: before.workspaceId,
        ownerType: before.ownerType,
        ownerId: before.ownerId,
        removedConfiguration: impact.counts,
        externalHostStopped: false,
      },
    },
  });
  return { removed: true as const, id: input.id, externalHostStopped: false as const };
}

export async function prepareRuntimeLifecycle(
  tx: Prisma.TransactionClient,
  input: RuntimeLifecycleExpected,
  actorId: string,
) {
  const before = await lockRuntimeLifecycle(tx, input);
  const now = new Date();
  const runtime = await tx.runtime.update({
    where: { id: input.id },
    data: {
      archivedAt: before.archivedAt ?? now,
      disabledAt: before.disabledAt ?? now,
    },
    select: runtimeSnapshot,
  });
  await tx.instanceAuditLog.create({
    data: {
      actorId,
      action: "runtime.lifecycle.prepare",
      metadata: {
        runtimeId: input.id,
        workspaceId: before.workspaceId,
        externalHostStopped: false,
      },
    },
  });
  return { runtime, externalHostStopped: false as const };
}
