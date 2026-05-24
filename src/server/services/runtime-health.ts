import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { getRuntimeAdapter } from "@/server/runtimes/adapters";
import { probeRuntime } from "@/server/services/dispatch/runtime-probe";
import { recordRuntimeHeartbeatPresence } from "@/server/services/heartbeat";

/**
 * Active health probe for outbound managed runtimes that can't heartbeat
 * inbound.
 *
 * The local daemon proves its own liveness (`runtimes.heartbeat`), and Hermes
 * agents report at the agent level — both already drive true presence. But a
 * runtime Forge reaches *outbound* (the Codex app server) never calls back, so
 * its agents would read a permanent "on-demand". This sweep pings each such
 * runtime; a reachable endpoint is treated as a heartbeat — it bumps
 * `Runtime.heartbeatAt` and propagates liveness to the hosted persistent
 * agents (same path as `runtimes.heartbeat`), so they read true online/offline.
 * When the endpoint stops answering we simply don't bump, and `sweepIdleAgents`
 * flips the agents OFFLINE once their heartbeat goes stale.
 *
 * Scope: only `transport: "app-server"` runtimes, where endpoint uptime ==
 * agent reachability (the server *is* the agent host). LOCAL_DAEMON self-
 * heartbeats and Hermes (`runs-api`) reports per-agent, so neither is probed —
 * probing them would risk overriding a more accurate signal.
 *
 * Scheduled by `src/server/worker.ts` as a repeatable BullMQ job.
 */

export interface RuntimeHealthSweepResult {
  /** Runtimes that matched the probe criteria and were pinged this tick. */
  probed: number;
  /** Of those, how many answered (and thus got a heartbeat bump). */
  reachable: number;
}

const PROBE_TIMEOUT_MS = 6_000;

export async function sweepRuntimeHealth(
  client: PrismaClient | Prisma.TransactionClient = db,
): Promise<RuntimeHealthSweepResult> {
  const runtimes = await client.runtime.findMany({
    where: { archivedAt: null, disabledAt: null, endpoint: { not: null } },
    select: { id: true, adapterKey: true, endpoint: true, secret: true },
  });

  const targets = runtimes.filter((rt) => {
    const adapter = getRuntimeAdapter(rt.adapterKey);
    return (
      adapter?.transport === "app-server" &&
      adapter.capabilities.presence === "runtime-heartbeat"
    );
  });

  let reachable = 0;
  await Promise.all(
    targets.map(async (rt) => {
      try {
        const res = await probeRuntime({
          adapterKey: rt.adapterKey,
          endpoint: rt.endpoint,
          secret: rt.secret,
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        if (!res.reachable) return;
        reachable += 1;
        const now = new Date();
        await client.runtime.update({
          where: { id: rt.id },
          data: { heartbeatAt: now },
        });
        await recordRuntimeHeartbeatPresence(rt.id, now, client);
      } catch (err) {
        // A single bad endpoint shouldn't sink the whole sweep.
        logger.warn({ err, runtimeId: rt.id }, "runtime-health: probe failed");
      }
    }),
  );

  if (targets.length) {
    logger.info(
      { probed: targets.length, reachable },
      "runtime-health sweep",
    );
  }
  return { probed: targets.length, reachable };
}
