import "server-only";
import { AgentStatus, EventKind, Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { recordChange } from "@/server/audit";

/**
 * Archive EPHEMERAL agents idle past their workspace's
 * `ephemeralAgentIdleMinutes` (0 = disabled). A session CLI that connected as
 * an ephemeral agent and then vanished otherwise lingers forever — the
 * heartbeat/idle presence sweep only touches PERSISTENT agents. Archive is
 * reversible (unarchive / re-bind), so this just keeps abandoned session rows
 * out of the lists.
 *
 * Guards: BUSY agents are skipped (don't reap a session mid-task); an agent is
 * only reaped once it has *existed* past the cutoff (`createdAt < cutoff`), so a
 * freshly-created binding gets a full idle window to connect before it can be
 * archived for never having heartbeated.
 */
export async function sweepIdleEphemeralAgents(
  now: Date = new Date(),
  client: PrismaClient | Prisma.TransactionClient = db,
): Promise<{ workspacesScanned: number; archived: string[] }> {
  const workspaces = await client.workspace.findMany({
    where: { ephemeralAgentIdleMinutes: { gt: 0 } },
    select: { id: true, ephemeralAgentIdleMinutes: true },
  });

  const archived: string[] = [];

  for (const ws of workspaces) {
    const cutoff = new Date(now.getTime() - ws.ephemeralAgentIdleMinutes * 60_000);
    const candidates = await client.agent.findMany({
      where: {
        workspaceId: ws.id,
        runtimeMode: "EPHEMERAL",
        archivedAt: null,
        status: { not: AgentStatus.BUSY },
        createdAt: { lt: cutoff },
        OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: cutoff } }],
      },
      select: { id: true, profileKey: true },
    });

    for (const agent of candidates) {
      try {
        await client.agent.update({
          where: { id: agent.id },
          data: { archivedAt: now, status: AgentStatus.OFFLINE },
        });
        await recordChange(client, {
          workspaceId: ws.id,
          actorId: null,
          actorAgentId: null,
          entity: "Agent",
          entityId: agent.id,
          action: "delete",
          before: { profileKey: agent.profileKey },
          eventKind: EventKind.AGENT_DELETED,
          subjectType: "agent",
          subjectId: agent.id,
          payload: { profileKey: agent.profileKey, archived: "ephemeral-idle" },
        });
        archived.push(agent.id);
      } catch (err) {
        logger.warn(
          { err, agentId: agent.id, workspaceId: ws.id },
          "ephemeral-idle-sweep: failed to archive idle ephemeral agent",
        );
      }
    }
  }

  if (archived.length > 0) {
    logger.info({ archived: archived.length }, "ephemeral-idle-sweep: archived idle ephemeral agents");
  }
  return { workspacesScanned: workspaces.length, archived };
}
