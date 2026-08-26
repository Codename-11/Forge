import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { runScheduledRuntimeProbe } from "@/server/services/runtime-diagnostics";
import { supportsRuntimeProbe } from "@/server/services/runtime-status";

/**
 * Active health probe for managed runtimes with handshake probes.
 *
 * The local daemon proves its own liveness (`runtimes.heartbeat`). Managed
 * HTTP/WebSocket adapters can be handshaken without starting a run: Codex app
 * server is probed over WebSocket initialize, Hermes gateway over a cheap HTTP
 * GET. The sweep persists every sanitized probe result so operators can tell
 * "gateway/auth unreachable" from "presence heartbeat missing".
 *
 * Only app-server runtimes whose presence is `runtime-heartbeat` use a
 * successful probe as a runtime heartbeat and propagate liveness to hosted
 * persistent agents. Hermes probes are diagnostic-only; agent/runtime presence
 * still comes from forge-presence, agent heartbeat, or webhook delivery.
 *
 * Scheduled by `src/server/worker.ts` as a repeatable BullMQ job.
 */

export interface RuntimeHealthSweepResult {
  /** Runtimes that matched the probe criteria and were pinged this tick. */
  probed: number;
  /** Of those, how many answered (and thus got a heartbeat bump). */
  reachable: number;
}

export async function sweepRuntimeHealth(
  client: PrismaClient | Prisma.TransactionClient = db,
): Promise<RuntimeHealthSweepResult> {
  const runtimes = await client.runtime.findMany({
    where: { archivedAt: null, disabledAt: null, endpoint: { not: null } },
    select: { id: true, workspaceId: true, adapterKey: true, endpoint: true },
  });

  const targets = runtimes.filter((rt) => supportsRuntimeProbe(rt.adapterKey));

  let reachable = 0;
  await Promise.all(
    targets.map(async (rt) => {
      try {
        const res = await runScheduledRuntimeProbe(
          { workspaceId: rt.workspaceId, runtimeId: rt.id },
          client,
        );
        if (res.reachable) reachable += 1;
      } catch (err) {
        // A single bad endpoint shouldn't sink the whole sweep.
        logger.warn({ err, runtimeId: rt.id }, "runtime-health: probe failed");
      }
    }),
  );

  if (targets.length) {
    logger.info({ probed: targets.length, reachable }, "runtime-health sweep");
  }
  return { probed: targets.length, reachable };
}
