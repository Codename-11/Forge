import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { AgentStatus, EventKind } from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { recordChange } from "@/server/audit";

/**
 * Heartbeat-driven agent auto-offline.
 *
 * Agents are expected to POST to `agent.heartbeat` (see `src/server/routers/
 * agent.ts`) which bumps `Agent.lastHeartbeatAt`. If an agent stops
 * heartbeating for longer than its workspace's `agentIdleTimeoutMinutes`,
 * we flip its `status` to OFFLINE so the auto-dispatcher stops picking it.
 *
 * A workspace-level timeout of `0` disables the sweep for that workspace —
 * matching how the idle-release knob is interpreted elsewhere. The sweep
 * is tenant-scoped so each workspace applies its own threshold.
 *
 * Scheduled by `src/server/worker.ts` as a repeatable BullMQ job.
 */

/**
 * Result of a single sweep. `flipped` is the ids of agents whose status
 * changed to OFFLINE during this tick; `workspacesScanned` is the count of
 * workspaces that had a non-zero timeout (i.e. were eligible for sweep).
 */
export interface HeartbeatSweepResult {
  workspacesScanned: number;
  flipped: string[];
}

/**
 * Flip idle agents to OFFLINE across every workspace that has configured
 * an `agentIdleTimeoutMinutes` > 0. Per-workspace so the threshold is
 * evaluated with that workspace's own value — we do NOT collapse into a
 * single global query because the cutoff differs per tenant.
 *
 * Safe to call concurrently; the status-flip uses a guarded `updateMany`
 * so only agents that are still non-OFFLINE are touched, and the audit
 * event fires exactly once per actual transition.
 */
export async function sweepIdleAgents(
  client: PrismaClient | Prisma.TransactionClient = db,
): Promise<HeartbeatSweepResult> {
  const now = new Date();
  const workspaces = await client.workspace.findMany({
    where: { agentIdleTimeoutMinutes: { gt: 0 }, deletedAt: null },
    select: { id: true, agentIdleTimeoutMinutes: true },
  });

  const flipped: string[] = [];

  for (const ws of workspaces) {
    const cutoff = new Date(
      now.getTime() - ws.agentIdleTimeoutMinutes * 60_000,
    );
    // Candidate set — non-OFFLINE, non-archived agents whose heartbeat is
    // either missing or older than the workspace cutoff. An agent that has
    // never heartbeated but was manually flipped ONLINE in the UI is still
    // considered idle (we have no signal to trust the manual flip past
    // the first cycle).
    const candidates = await client.agent.findMany({
      where: {
        workspaceId: ws.id,
        archivedAt: null,
        status: { not: AgentStatus.OFFLINE },
        OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: cutoff } }],
      },
      select: { id: true, status: true, lastHeartbeatAt: true, profileKey: true },
    });

    for (const agent of candidates) {
      // Guarded update — re-check `status != OFFLINE` so a racing heartbeat
      // that lands between findMany and update doesn't get clobbered.
      const res = await client.agent.updateMany({
        where: {
          id: agent.id,
          status: { not: AgentStatus.OFFLINE },
        },
        data: { status: AgentStatus.OFFLINE },
      });
      if (res.count === 0) continue;

      flipped.push(agent.id);

      try {
        await recordChange(client, {
          workspaceId: ws.id,
          actorId: null,
          entity: "Agent",
          entityId: agent.id,
          action: "auto-offline",
          before: { status: agent.status },
          after: { status: AgentStatus.OFFLINE },
          eventKind: EventKind.AGENT_STATUS_CHANGED,
          subjectType: "agent",
          subjectId: agent.id,
          payload: {
            profileKey: agent.profileKey,
            from: agent.status,
            to: AgentStatus.OFFLINE,
            reason: "heartbeat-timeout",
            lastHeartbeatAt: agent.lastHeartbeatAt?.toISOString() ?? null,
            timeoutMinutes: ws.agentIdleTimeoutMinutes,
          },
        });
      } catch (err) {
        // Audit failure shouldn't block the status flip — log and move on.
        logger.warn(
          { err, agentId: agent.id, workspaceId: ws.id },
          "heartbeat sweep: audit failed",
        );
      }
    }
  }

  if (flipped.length) {
    logger.info(
      { flipped: flipped.length, workspaces: workspaces.length },
      "heartbeat sweep: agents flipped to OFFLINE",
    );
  }

  return { workspacesScanned: workspaces.length, flipped };
}

/**
 * Record a successful agent delivery as a presence signal.
 *
 * Push-dispatch model: every successful POST to an agent's webhook URL
 * is treated as proof the agent is reachable, so we bump
 * `lastHeartbeatAt` and (if the agent was OFFLINE) flip to ONLINE plus
 * emit `AGENT_STATUS_CHANGED` so the timeline + uptime ribbon pick up
 * the transition.
 *
 * Best-effort: any failure here is swallowed and logged. The caller is
 * the webhook delivery worker, which has already updated the delivery
 * row; presence drift is acceptable, dropping the delivery is not.
 */
export async function recordAgentReachable(
  agentId: string,
  client: PrismaClient | Prisma.TransactionClient = db,
): Promise<void> {
  try {
    const before = await client.agent.findUnique({
      where: { id: agentId },
      select: { id: true, status: true, workspaceId: true, profileKey: true },
    });
    if (!before) return;

    const now = new Date();
    if (before.status === AgentStatus.ONLINE) {
      await client.agent.update({
        where: { id: agentId },
        data: { lastHeartbeatAt: now },
      });
      return;
    }

    // Status transition. Bump heartbeat + flip status, then audit.
    await client.agent.update({
      where: { id: agentId },
      data: { lastHeartbeatAt: now, status: AgentStatus.ONLINE },
    });

    await recordChange(client, {
      workspaceId: before.workspaceId,
      actorId: null,
      entity: "Agent",
      entityId: agentId,
      action: "delivery-online",
      before: { status: before.status },
      after: { status: AgentStatus.ONLINE },
      eventKind: EventKind.AGENT_STATUS_CHANGED,
      subjectType: "agent",
      subjectId: agentId,
      payload: {
        profileKey: before.profileKey,
        from: before.status,
        to: AgentStatus.ONLINE,
        reason: "delivery-success",
      },
    });
  } catch (err) {
    logger.warn({ err, agentId }, "recordAgentReachable failed");
  }
}

/**
 * Propagate a managed runtime's heartbeat onto the agents it hosts.
 *
 * A `runtime-heartbeat` runtime (the Forge local daemon today) proves it's
 * alive by calling `runtimes.heartbeat` on an interval. Its **persistent**
 * agents have no heartbeat of their own — without this they'd read a
 * permanent "on-demand". Mirroring the runtime heartbeat onto each agent's
 * `lastHeartbeatAt` (and flipping OFFLINE → ONLINE) makes them resolve to
 * real online/offline presence — and `sweepIdleAgents` flips them back to
 * OFFLINE once the runtime stops heartbeating (its agents go stale together).
 *
 * Only PERSISTENT agents are touched: an EPHEMERAL (session) agent on the
 * same runtime keeps its session presence. BUSY agents keep their status and
 * just get a fresh heartbeat so the sweep doesn't reap them mid-task.
 *
 * Best-effort and idempotent: called every heartbeat tick, so the no-change
 * path (already ONLINE) is a single cheap bump with no event.
 */
export async function recordRuntimeHeartbeatPresence(
  runtimeId: string,
  now: Date,
  client: PrismaClient | Prisma.TransactionClient = db,
): Promise<void> {
  try {
    const agents = await client.agent.findMany({
      where: {
        runtimeId,
        runtimeMode: "PERSISTENT",
        archivedAt: null,
      },
      select: { id: true, status: true, workspaceId: true, profileKey: true },
    });

    for (const agent of agents) {
      // ONLINE / BUSY → just refresh the heartbeat (preserve a working agent's
      // BUSY status; the sweep treats both as live).
      if (
        agent.status === AgentStatus.ONLINE ||
        agent.status === AgentStatus.BUSY
      ) {
        await client.agent.update({
          where: { id: agent.id },
          data: { lastHeartbeatAt: now },
        });
        continue;
      }

      // OFFLINE → ONLINE transition with an audit + event (matches the
      // delivery-presence path so the timeline/uptime ribbon pick it up).
      await client.agent.update({
        where: { id: agent.id },
        data: { lastHeartbeatAt: now, status: AgentStatus.ONLINE },
      });
      await recordChange(client, {
        workspaceId: agent.workspaceId,
        actorId: null,
        entity: "Agent",
        entityId: agent.id,
        action: "runtime-online",
        before: { status: agent.status },
        after: { status: AgentStatus.ONLINE },
        eventKind: EventKind.AGENT_STATUS_CHANGED,
        subjectType: "agent",
        subjectId: agent.id,
        payload: {
          profileKey: agent.profileKey,
          from: agent.status,
          to: AgentStatus.ONLINE,
          reason: "runtime-heartbeat",
        },
      });
    }
  } catch (err) {
    logger.warn({ err, runtimeId }, "recordRuntimeHeartbeatPresence failed");
  }
}
