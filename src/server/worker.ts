/**
 * BullMQ workers — run as a separate process: `pnpm worker`.
 *
 * Responsibilities:
 *   - webhook-delivery: pick up WebhookDelivery rows with status=PENDING,
 *     attempt HTTP delivery with exponential backoff, mark SUCCESS/FAILED.
 *   - metric-rollup: run at cron intervals to populate MetricAggregate.
 *   - sla-scan: emit SLA breach events for overdue issues.
 *
 * This file is a scaffold — swap in BullMQ Queue/Worker instances once
 * Redis is live and you want durable retries. Kept intentionally small so
 * the shape of the system is visible without pulling in too much.
 */
import "server-only";
import { Queue, Worker, QueueEvents } from "bullmq";
import { db } from "@/server/db";
import {
  AGENT_DISPATCH_WEBHOOK_URL,
  AGENT_DISPATCH_WEBHOOK_URL_PREFIX,
} from "@/server/audit";
import { deliverWebhook } from "@/server/services/plugin-runtime";
import { sweepIdleAgents } from "@/server/services/heartbeat";
import { logger } from "@/server/logger";

const connection = { url: process.env.REDIS_URL ?? "redis://localhost:6379" };

/**
 * Interval (ms) between heartbeat sweeps. Fixed at 60s — the dispatcher
 * only consults `Agent.status` at pick time so we can be aggressive here
 * without hammering the DB; one workspace query + one candidate query per
 * ws per minute is negligible at realistic workspace counts.
 */
const HEARTBEAT_SWEEP_INTERVAL_MS = 60_000;

/**
 * Fixed jobId for the repeatable heartbeat sweep. Registering with a
 * stable id means every worker restart upserts the same schedule instead
 * of stacking duplicate repeat entries — see the BullMQ "repeat" docs.
 */
const HEARTBEAT_SWEEP_JOB_ID = "heartbeat-sweep";

export const webhookQueue = new Queue("webhooks", { connection });
export const webhookEvents = new QueueEvents("webhooks", { connection });

export const webhookWorker = new Worker(
  "webhooks",
  async (job) => {
    const deliveryId = job.data.deliveryId as string;
    const delivery = await db.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { webhook: true, event: true },
    });
    if (!delivery || !delivery.webhook.active) return;

    // Agent-dispatch pseudo-webhook — resolve the real target URL from
    // either the subject issue's assignee (generic `agent:dispatch` shim)
    // or the explicit agent id embedded in the url suffix
    // (`agent:dispatch:{agentId}`; used for comment @mentions + priority
    // escalations). The per-agent `webhookUrl` is the source of truth.
    let targetUrl = delivery.webhook.url;
    let targetSecret = delivery.webhook.secret;
    if (
      targetUrl === AGENT_DISPATCH_WEBHOOK_URL ||
      targetUrl.startsWith(AGENT_DISPATCH_WEBHOOK_URL_PREFIX)
    ) {
      // Resolve the target agent id. For the per-agent shim, the suffix
      // is the source of truth; for the generic shim, walk the subject
      // issue's `assignedAgentId`.
      let agentId: string | null = null;
      if (targetUrl.startsWith(AGENT_DISPATCH_WEBHOOK_URL_PREFIX)) {
        agentId = targetUrl.slice(AGENT_DISPATCH_WEBHOOK_URL_PREFIX.length) || null;
      } else {
        if (delivery.event.subjectType !== "issue") {
          await db.webhookDelivery.update({
            where: { id: deliveryId },
            data: {
              attempt: { increment: 1 },
              status: "DEAD_LETTER",
              responseBody: "agent-dispatch: non-issue subject",
            },
          });
          return;
        }
        const issue = await db.issue.findUnique({
          where: { id: delivery.event.subjectId },
          select: { assignedAgentId: true },
        });
        agentId = issue?.assignedAgentId ?? null;
      }

      if (!agentId) {
        await db.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            attempt: { increment: 1 },
            status: "DEAD_LETTER",
            responseBody: "agent-dispatch: no agent resolved",
          },
        });
        return;
      }

      const agent = await db.agent.findUnique({
        where: { id: agentId },
        select: { webhookUrl: true, webhookSecret: true },
      });
      if (!agent?.webhookUrl) {
        await db.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            attempt: { increment: 1 },
            status: "DEAD_LETTER",
            responseBody: "agent-dispatch: target agent has no webhookUrl",
          },
        });
        return;
      }
      targetUrl = agent.webhookUrl;
      // Prefer the per-agent HMAC secret when present; fall back to the
      // synthetic workspace-level secret so deliveries still sign against
      // something stable if the agent hasn't been rotated yet.
      targetSecret = agent.webhookSecret ?? delivery.webhook.secret;
    }

    const res = await deliverWebhook({
      url: targetUrl,
      secret: targetSecret,
      body: {
        id: delivery.event.id,
        kind: delivery.event.kind,
        subjectType: delivery.event.subjectType,
        subjectId: delivery.event.subjectId,
        payload: delivery.event.payload,
        createdAt: delivery.event.createdAt,
      },
    });

    await db.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attempt: { increment: 1 },
        status: res.ok ? "SUCCESS" : delivery.attempt >= 5 ? "DEAD_LETTER" : "FAILED",
        responseStatus: res.status,
        responseBody: res.responseBody?.slice(0, 8_000),
        deliveredAt: res.ok ? new Date() : null,
      },
    });

    if (!res.ok) throw new Error(`Delivery failed (${res.status}).`);
  },
  { connection, concurrency: 10 },
);

webhookWorker.on("failed", (job, err) => {
  logger.warn({ jobId: job?.id, err }, "webhook job failed");
});

// ---------------------------------------------------------------------------
// Maintenance queue: periodic sweeps (heartbeat auto-offline, etc.)
//
// Kept on a separate queue so it doesn't share concurrency budget with the
// webhook fan-out; this queue is low-volume (one job per minute) and the
// handlers touch different tables so a stuck webhook won't delay a sweep.
// ---------------------------------------------------------------------------

export const maintenanceQueue = new Queue("maintenance", { connection });

export const maintenanceWorker = new Worker(
  "maintenance",
  async (job) => {
    switch (job.name) {
      case "heartbeat-sweep": {
        const res = await sweepIdleAgents();
        return res;
      }
      default:
        logger.warn({ jobName: job.name }, "maintenance: unknown job");
        return null;
    }
  },
  { connection, concurrency: 1 },
);

maintenanceWorker.on("failed", (job, err) => {
  logger.warn({ jobId: job?.id, jobName: job?.name, err }, "maintenance job failed");
});

/**
 * Register the recurring heartbeat sweep on the maintenance queue. Uses a
 * stable `jobId` so repeated calls (e.g. worker restarts) upsert rather
 * than stack the schedule. Exported so tests / a boot script can wait on
 * registration before running.
 */
export async function registerHeartbeatSweepJob(): Promise<void> {
  await maintenanceQueue.add(
    "heartbeat-sweep",
    {},
    {
      jobId: HEARTBEAT_SWEEP_JOB_ID,
      repeat: { every: HEARTBEAT_SWEEP_INTERVAL_MS },
      // Keep the job table small — we don't need long history for a tick.
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86_400, count: 50 },
    },
  );
}

// Auto-register recurring jobs when this module loads (i.e. when
// `pnpm worker` boots). Fire-and-forget — a Redis outage at boot should
// not crash the worker; BullMQ will retry internally on the next op.
void registerHeartbeatSweepJob().catch((err) => {
  logger.warn({ err }, "failed to register heartbeat-sweep job");
});

if (import.meta.url === `file://${process.argv[1]}`) {
  logger.info("workers running");
}
