import "server-only";

import {
  EventKind,
  type Prisma,
  type PrismaClient,
  type WorkSessionParticipantRole,
} from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { recordChange } from "@/server/audit";

export type WorkSessionParticipantActor = {
  userId: string | null;
  agentId?: string | null;
};

async function requireConnection(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  connectionId: string,
) {
  const connection = await tx.agentConnection.findFirst({
    where: { id: connectionId, workspaceId, revokedAt: null },
    select: { id: true, agentId: true },
  });
  if (!connection) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Agent connection not found." });
  }
  return connection;
}

/** Join delivery without acquiring primary branch/heartbeat authority. */
export async function joinWorkSession(
  db: PrismaClient,
  input: {
    workspaceId: string;
    sessionId: string;
    connectionId: string;
    role: Exclude<WorkSessionParticipantRole, "PRIMARY">;
    actor: WorkSessionParticipantActor;
  },
) {
  return db.$transaction(async (tx) => {
    const session = await tx.workSession.findFirst({
      where: { id: input.sessionId, workspaceId: input.workspaceId, endedAt: null },
      select: { id: true, issueId: true, ownerConnectionId: true },
    });
    if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Work session not found." });
    const connection = await requireConnection(tx, input.workspaceId, input.connectionId);
    if (session.ownerConnectionId === connection.id) {
      // Joining is collaboration-only. If the lease owner calls it, preserve
      // (and repair, for legacy rows) the canonical PRIMARY participant rather
      // than demoting the owner to the requested secondary role.
      return tx.workSessionParticipant.upsert({
        where: {
          workSessionId_connectionId: {
            workSessionId: session.id,
            connectionId: connection.id,
          },
        },
        create: {
          workspaceId: input.workspaceId,
          workSessionId: session.id,
          connectionId: connection.id,
          agentId: connection.agentId,
          role: "PRIMARY",
        },
        update: { agentId: connection.agentId, role: "PRIMARY", leftAt: null },
      });
    }
    const participant = await tx.workSessionParticipant.upsert({
      where: {
        workSessionId_connectionId: {
          workSessionId: session.id,
          connectionId: connection.id,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        workSessionId: session.id,
        connectionId: connection.id,
        agentId: connection.agentId,
        role: input.role,
      },
      update: { agentId: connection.agentId, role: input.role, leftAt: null },
    });
    await recordChange(tx, {
      workspaceId: input.workspaceId,
      actorId: input.actor.userId,
      actorAgentId: input.actor.agentId ?? null,
      entity: "WorkSessionParticipant",
      entityId: participant.id,
      action: "work-session-participant-joined",
      before: undefined,
      after: { connectionId: connection.id, agentId: connection.agentId, role: input.role },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "issue",
      subjectId: session.issueId,
      payload: {
        workSessionId: session.id,
        connectionId: connection.id,
        agentId: connection.agentId,
        role: input.role,
      },
    });
    return participant;
  });
}

/**
 * Atomically transfer primary execution authority to another connection.
 * The previous primary remains in history with leftAt set; it is never
 * silently converted into a contributor.
 */
export async function handoffWorkSession(
  db: PrismaClient,
  input: {
    workspaceId: string;
    sessionId: string;
    toConnectionId: string;
    actor: WorkSessionParticipantActor;
    reason?: string | null;
  },
) {
  return db.$transaction(async (tx) => {
    // Serialize handoffs for this lease so the partial one-primary index is a
    // final invariant rather than the normal concurrency-control mechanism.
    await tx.$queryRaw`SELECT "id" FROM "WorkSession" WHERE "id" = ${input.sessionId} FOR UPDATE`;
    const session = await tx.workSession.findFirst({
      where: { id: input.sessionId, workspaceId: input.workspaceId, endedAt: null },
      select: {
        id: true,
        issueId: true,
        ownerAgentId: true,
        ownerConnectionId: true,
      },
    });
    if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Work session not found." });
    const target = await requireConnection(tx, input.workspaceId, input.toConnectionId);
    if (session.ownerConnectionId === target.id) {
      return tx.workSession.findUniqueOrThrow({ where: { id: session.id } });
    }

    const now = new Date();
    await tx.workSessionParticipant.updateMany({
      where: { workSessionId: session.id, role: "PRIMARY", leftAt: null },
      data: { leftAt: now },
    });
    await tx.workSessionParticipant.upsert({
      where: {
        workSessionId_connectionId: {
          workSessionId: session.id,
          connectionId: target.id,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        workSessionId: session.id,
        connectionId: target.id,
        agentId: target.agentId,
        role: "PRIMARY",
        joinedAt: now,
      },
      update: { agentId: target.agentId, role: "PRIMARY", joinedAt: now, leftAt: null },
    });
    const updated = await tx.workSession.update({
      where: { id: session.id },
      data: {
        ownerAgentId: target.agentId,
        ownerConnectionId: target.id,
        lastHeartbeatAt: now,
        staleAt: null,
      },
    });
    await recordChange(tx, {
      workspaceId: input.workspaceId,
      actorId: input.actor.userId,
      actorAgentId: input.actor.agentId ?? null,
      entity: "WorkSession",
      entityId: session.id,
      action: "work-session-handed-off",
      before: {
        ownerAgentId: session.ownerAgentId,
        ownerConnectionId: session.ownerConnectionId,
      },
      after: { ownerAgentId: target.agentId, ownerConnectionId: target.id },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "issue",
      subjectId: session.issueId,
      payload: {
        workSessionId: session.id,
        fromConnectionId: session.ownerConnectionId,
        toConnectionId: target.id,
        reason: input.reason?.slice(0, 500) ?? null,
      } as Prisma.InputJsonObject,
    });
    return updated;
  });
}
