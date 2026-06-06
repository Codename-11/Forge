import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { probeRuntime } from "@/server/services/dispatch/runtime-probe";
import { sanitizeRuntimeProbeDetail, supportsRuntimeProbe } from "@/server/services/runtime-status";
import { recordRuntimeHeartbeatPresence } from "@/server/services/heartbeat";

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

const PROBE_TIMEOUT_MS = 6_000;

export async function sweepRuntimeHealth(
  client: PrismaClient | Prisma.TransactionClient = db,
): Promise<RuntimeHealthSweepResult> {
  const runtimes = await client.runtime.findMany({
    where: { archivedAt: null, disabledAt: null, endpoint: { not: null } },
    select: { id: true, adapterKey: true, endpoint: true, secret: true },
  });

  const targets = runtimes.filter((rt) => supportsRuntimeProbe(rt.adapterKey));

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
        const now = new Date();
        const probeData = {
          lastProbeAt: now,
          lastProbeAttempted: res.attempted,
          lastProbeReachable: res.reachable,
          lastProbeDetail: sanitizeRuntimeProbeDetail(res.detail),
        };
        if (!res.reachable) {
          await client.runtime.updateMany({
            where: { id: rt.id },
            data: probeData,
          });
          return;
        }
        reachable += 1;
        const updated = await client.runtime.updateMany({
          where: { id: rt.id },
          data: { ...probeData, heartbeatAt: now },
        });
        if (updated.count > 0) {
          await recordRuntimeHeartbeatPresence(rt.id, now, client);
        }
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
