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
import { AGENT_DISPATCH_WEBHOOK_URL } from "@/server/audit";
import { deliverWebhook } from "@/server/services/plugin-runtime";
import { logger } from "@/server/logger";

const connection = { url: process.env.REDIS_URL ?? "redis://localhost:6379" };

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
    // the subject issue's assigned agent. The per-agent webhookUrl is
    // the source of truth; the Webhook row is a queue shim.
    let targetUrl = delivery.webhook.url;
    const targetSecret = delivery.webhook.secret;
    if (targetUrl === AGENT_DISPATCH_WEBHOOK_URL) {
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
        select: {
          assignedAgent: { select: { webhookUrl: true } },
        },
      });
      const agentUrl = issue?.assignedAgent?.webhookUrl ?? null;
      if (!agentUrl) {
        await db.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            attempt: { increment: 1 },
            status: "DEAD_LETTER",
            responseBody: "agent-dispatch: assigned agent has no webhookUrl",
          },
        });
        return;
      }
      targetUrl = agentUrl;
      // Reuse the synthetic workspace-level secret for HMAC. Future work
      // can promote this to a per-agent secret column on Agent.
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

if (import.meta.url === `file://${process.argv[1]}`) {
  logger.info("workers running");
}
