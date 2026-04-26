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
import { Worker, QueueEvents } from "bullmq";
import { db } from "@/server/db";
import {
  AGENT_DISPATCH_WEBHOOK_URL,
  AGENT_DISPATCH_WEBHOOK_URL_PREFIX,
} from "@/server/audit";
import { deliverWebhook } from "@/server/services/plugin-runtime";
import { sweepIdleAgents, recordAgentReachable } from "@/server/services/heartbeat";
import { sweepStaleWork } from "@/server/services/stale-work";
import { checkRequiredAck } from "@/server/services/required-ack";
import { sweepSlaBreaches } from "@/server/services/sla-breach";
import { sweepStalledRuns } from "@/server/services/agent-run-stale";
import { recordAgentAction } from "@/server/services/agent-run";
import { logger } from "@/server/logger";
import { webhookQueue, maintenanceQueue } from "@/server/queues";

const connection = { url: process.env.REDIS_URL ?? "redis://localhost:6379" };

const HEARTBEAT_SWEEP_INTERVAL_MS = 60_000;
const HEARTBEAT_SWEEP_JOB_ID = "heartbeat-sweep";
const DELIVERY_DRAIN_INTERVAL_MS = 5_000;
const DELIVERY_DRAIN_JOB_ID = "delivery-drain";
const DELIVERY_DRAIN_BATCH = 100;
const STALE_WORK_SWEEP_INTERVAL_MS = 60_000;
const STALE_WORK_SWEEP_JOB_ID = "stale-work-sweep";
const SLA_BREACH_SWEEP_INTERVAL_MS = 60_000;
const SLA_BREACH_SWEEP_JOB_ID = "sla-breach-sweep";
const AGENT_RUN_STALE_SWEEP_INTERVAL_MS = 60_000;
const AGENT_RUN_STALE_SWEEP_JOB_ID = "agent-run-stale-sweep";

export { webhookQueue, maintenanceQueue };
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
    let presenceAgentId: string | null = null;
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
      presenceAgentId = agentId;
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

    // Push-dispatch presence: every successful delivery to an agent's
    // webhook URL is proof the agent is reachable, so bump its
    // `lastHeartbeatAt` and (if it was OFFLINE) flip it back to ONLINE.
    // Best-effort — failures here are logged but don't fail the job.
    if (res.ok && presenceAgentId) {
      await recordAgentReachable(presenceAgentId);

      // AgentRun lifecycle: a successful agent webhook delivery against
      // an issue subject is the canonical "agent picked up the work"
      // signal. Open (or touch) the run so the live pulse strip starts
      // showing activity, even if the agent hasn't yet posted a status
      // comment. AGENT_ASSIGNED gets a STARTED kind; everything else
      // (priority bump, mention) gets DISPATCH so the timeline still
      // distinguishes them.
      if (delivery.event.subjectType === "issue") {
        await db.$transaction(async (tx) => {
          await recordAgentAction(tx, {
            workspaceId: delivery.event.workspaceId,
            issueId: delivery.event.subjectId,
            agentId: presenceAgentId!,
            kind:
              delivery.event.kind === "AGENT_ASSIGNED"
                ? "DISPATCH_RECEIVED"
                : `DISPATCH_${delivery.event.kind}`,
            assignmentEventId:
              delivery.event.kind === "AGENT_ASSIGNED" ? delivery.event.id : null,
            payload: { eventId: delivery.event.id, eventKind: delivery.event.kind },
          });
        });
      }
      // Required-ack window: if the workspace opted in, schedule a
      // delayed maintenance job that checks whether the agent actually
      // moved/commented on the issue. Stable jobId per delivery so a
      // double-deliver doesn't stack two checks.
      if (delivery.event.kind === "AGENT_ASSIGNED") {
        const workspace = await db.workspace.findUnique({
          where: { id: delivery.event.workspaceId },
          select: { requiredAckSeconds: true },
        });
        if (workspace && workspace.requiredAckSeconds > 0) {
          await maintenanceQueue.add(
            "required-ack-check",
            { agentAssignedEventId: delivery.event.id },
            {
              delay: workspace.requiredAckSeconds * 1000,
              jobId: `ack-check-${delivery.event.id}`,
              removeOnComplete: { age: 3600, count: 200 },
              removeOnFail: { age: 86_400, count: 50 },
            },
          );
        }
      }
    }

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

export const maintenanceWorker = new Worker(
  "maintenance",
  async (job) => {
    switch (job.name) {
      case "heartbeat-sweep": {
        const res = await sweepIdleAgents();
        return res;
      }
      case "delivery-drain": {
        const res = await drainPendingDeliveries();
        return res;
      }
      case "stale-work-sweep": {
        const res = await sweepStaleWork();
        return res;
      }
      case "sla-breach-sweep": {
        const res = await sweepSlaBreaches();
        return res;
      }
      case "agent-run-stale-sweep": {
        const res = await sweepStalledRuns();
        return res;
      }
      case "required-ack-check": {
        const eventId = job.data?.agentAssignedEventId as string | undefined;
        if (!eventId) return null;
        const res = await checkRequiredAck({ agentAssignedEventId: eventId });
        return res;
      }
      default:
        logger.warn({ jobName: job.name }, "maintenance: unknown job");
        return null;
    }
  },
  { connection, concurrency: 1 },
);

/**
 * Pick up any `WebhookDelivery` rows that are still PENDING (createMany
 * in `audit.recordChange` writes them but doesn't enqueue) and add them
 * to the BullMQ webhook queue with a small per-job dedupe key so a
 * second drain on the same row is a no-op. Bounded batch keeps the loop
 * predictable; the queue itself handles backoff + DLQ on failure.
 */
async function drainPendingDeliveries(): Promise<{ enqueued: number }> {
  const rows = await db.webhookDelivery.findMany({
    where: { status: "PENDING" },
    select: { id: true },
    orderBy: { scheduledAt: "asc" },
    take: DELIVERY_DRAIN_BATCH,
  });
  let enqueued = 0;
  for (const r of rows) {
    await webhookQueue.add(
      "deliver",
      { deliveryId: r.id },
      { jobId: r.id, removeOnComplete: { age: 3600, count: 500 } },
    );
    enqueued++;
  }
  if (enqueued > 0) {
    logger.info({ enqueued }, "delivery-drain: enqueued PENDING rows");
  }
  return { enqueued };
}

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

/**
 * Periodic drain of PENDING `WebhookDelivery` rows. `recordChange()`
 * writes these synchronously inside its transaction but doesn't (and
 * can't) reach into BullMQ from there — the drain bridges that gap.
 */
export async function registerDeliveryDrainJob(): Promise<void> {
  await maintenanceQueue.add(
    "delivery-drain",
    {},
    {
      jobId: DELIVERY_DRAIN_JOB_ID,
      repeat: { every: DELIVERY_DRAIN_INTERVAL_MS },
      removeOnComplete: { age: 600, count: 50 },
      removeOnFail: { age: 3600, count: 50 },
    },
  );
}

/**
 * Periodic stale-work watchdog. Flips assigned-but-not-started issues to
 * `ISSUE_STALLED` once they've sat in BACKLOG/TODO past the workspace's
 * `assignmentSlaMinutes`. Sibling of the heartbeat sweep; same cadence.
 */
export async function registerStaleWorkSweepJob(): Promise<void> {
  await maintenanceQueue.add(
    "stale-work-sweep",
    {},
    {
      jobId: STALE_WORK_SWEEP_JOB_ID,
      repeat: { every: STALE_WORK_SWEEP_INTERVAL_MS },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86_400, count: 50 },
    },
  );
}

/**
 * Periodic SLA-breach sweep. Emits `ISSUE_SLA_BREACH` for any open issue
 * whose age exceeds its `slaMinutes` target. Workspace-gated by
 * `slaEnforcementEnabled`; per-issue gate is `Issue.slaMinutes` itself.
 */
export async function registerSlaBreachSweepJob(): Promise<void> {
  await maintenanceQueue.add(
    "sla-breach-sweep",
    {},
    {
      jobId: SLA_BREACH_SWEEP_JOB_ID,
      repeat: { every: SLA_BREACH_SWEEP_INTERVAL_MS },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86_400, count: 50 },
    },
  );
}

/**
 * Periodic stalled-AgentRun sweep. Closes any ACTIVE run whose
 * `lastEventAt` is older than the workspace's `agentRunStaleMinutes`,
 * flipping it to STALLED + emitting AGENT_RUN_STALLED. The live pulse
 * strip on the issue page reacts in real time via the SSE bus.
 */
export async function registerAgentRunStaleSweepJob(): Promise<void> {
  await maintenanceQueue.add(
    "agent-run-stale-sweep",
    {},
    {
      jobId: AGENT_RUN_STALE_SWEEP_JOB_ID,
      repeat: { every: AGENT_RUN_STALE_SWEEP_INTERVAL_MS },
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
void registerDeliveryDrainJob().catch((err) => {
  logger.warn({ err }, "failed to register delivery-drain job");
});
void registerStaleWorkSweepJob().catch((err) => {
  logger.warn({ err }, "failed to register stale-work-sweep job");
});
void registerSlaBreachSweepJob().catch((err) => {
  logger.warn({ err }, "failed to register sla-breach-sweep job");
});
void registerAgentRunStaleSweepJob().catch((err) => {
  logger.warn({ err }, "failed to register agent-run-stale-sweep job");
});

if (import.meta.url === `file://${process.argv[1]}`) {
  logger.info("workers running");
}
