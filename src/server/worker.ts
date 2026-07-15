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
import { AGENT_DISPATCH_WEBHOOK_URL, AGENT_DISPATCH_WEBHOOK_URL_PREFIX } from "@/server/audit";
import { deliverWebhook } from "@/server/services/plugin-runtime";
import { sweepIdleAgents, recordAgentReachable } from "@/server/services/heartbeat";
import { sweepRuntimeHealth } from "@/server/services/runtime-health";
import { sweepOrchestrationBudget } from "@/server/services/orchestration-service";
import { sweepStaleWork } from "@/server/services/stale-work";
import { checkRequiredAck } from "@/server/services/required-ack";
import { sweepSlaBreaches } from "@/server/services/sla-breach";
import { sweepStalledRuns } from "@/server/services/agent-run-stale";
import { recordWakeAttempt } from "@/server/services/agent-dispatch-inbox";
import { sweepChatCompaction } from "@/server/services/chat-compaction";
import { ingestRunsDispatch } from "@/server/services/dispatch/run-dispatcher";
import { purgeExpiredSessionKeys } from "@/server/services/api-key-purge";
import { sweepIdleEphemeralAgents } from "@/server/services/ephemeral-idle";
import { sweepCompletionCandidates } from "@/server/services/completion-candidate";
import { sweepGitHubStatusReconciliation } from "@/server/services/github/reconciliation";
import { recoverGenericGitHubAttachments } from "@/server/services/github/resource-sync";
import { sweepScheduledTasks } from "@/server/services/scheduled-task";
import { sweepStaleWorkSessions } from "@/server/services/work-session";
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
const CHAT_COMPACTION_SWEEP_INTERVAL_MS = 5 * 60_000;

const RUNS_DISPATCH_SWEEP_INTERVAL_MS = 5_000;
const RUNS_DISPATCH_SWEEP_JOB_ID = "runs-dispatch-sweep";
const CHAT_COMPACTION_SWEEP_JOB_ID = "chat-compaction-sweep";
const RUNTIME_HEALTH_SWEEP_INTERVAL_MS = 60_000;
const RUNTIME_HEALTH_SWEEP_JOB_ID = "runtime-health-sweep";
const ORCH_WATCHDOG_SWEEP_INTERVAL_MS = 60_000;
const ORCH_WATCHDOG_SWEEP_JOB_ID = "orchestration-watchdog-sweep";
const EXPIRED_KEY_PURGE_INTERVAL_MS = 60 * 60_000;
const EXPIRED_KEY_PURGE_JOB_ID = "expired-key-purge-sweep";
const EPHEMERAL_IDLE_SWEEP_INTERVAL_MS = 5 * 60_000;
const EPHEMERAL_IDLE_SWEEP_JOB_ID = "ephemeral-idle-sweep";
const COMPLETION_CANDIDATE_SWEEP_INTERVAL_MS = 5 * 60_000;
const COMPLETION_CANDIDATE_SWEEP_JOB_ID = "completion-candidate-sweep";
const GITHUB_RECONCILIATION_SWEEP_INTERVAL_MS = 5 * 60_000;
const GITHUB_RECONCILIATION_SWEEP_JOB_ID = "github-reconciliation-sweep";
const SCHEDULED_TASK_SWEEP_INTERVAL_MS = 60_000;
const SCHEDULED_TASK_SWEEP_JOB_ID = "scheduled-task-sweep";
const WORK_SESSION_SWEEP_INTERVAL_MS = 5 * 60_000;
const WORK_SESSION_SWEEP_JOB_ID = "work-session-stale-sweep";

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

    // Wake telemetry: agent-targeted deliveries (success OR failure)
    // bump the canonical work row's lastWake* fields so the inbox
    // diagnostic rail can surface "wake failed 3 times" or "wake
    // delivered at 14:23". Canonical work was created at event time in
    // audit.recordChange, so this branch never has to open the first
    // AgentRun — that's already happened.
    if (presenceAgentId) {
      if (delivery.event.subjectType === "issue") {
        await db.$transaction(async (tx) => {
          await recordWakeAttempt(tx, {
            workspaceId: delivery.event.workspaceId,
            agentId: presenceAgentId!,
            target: { kind: "issue", issueId: delivery.event.subjectId },
            deliveryId,
            eventId: delivery.event.id,
            eventKind: delivery.event.kind,
            ok: res.ok,
          });
        });
      } else if (delivery.event.subjectType === "execution-step") {
        await db.$transaction(async (tx) => {
          await recordWakeAttempt(tx, {
            workspaceId: delivery.event.workspaceId,
            agentId: presenceAgentId!,
            target: { kind: "execution-step", stepId: delivery.event.subjectId },
            deliveryId,
            eventId: delivery.event.id,
            eventKind: delivery.event.kind,
            ok: res.ok,
          });
        });
      } else if (delivery.event.subjectType === "chat-thread") {
        // The user ChatMessage that triggered the dispatch carries the
        // wake bookkeeping; resolve it from the event payload before
        // updating. Falls through silently if the payload is malformed.
        const payload = (delivery.event.payload ?? {}) as { messageId?: string };
        if (payload.messageId) {
          await db.$transaction(async (tx) => {
            await recordWakeAttempt(tx, {
              workspaceId: delivery.event.workspaceId,
              agentId: presenceAgentId!,
              target: { kind: "chat-message", chatMessageId: payload.messageId! },
              deliveryId,
              eventId: delivery.event.id,
              eventKind: delivery.event.kind,
              ok: res.ok,
            });
          });
        }
      }
    }

    // Push-dispatch presence: every successful delivery to an agent's
    // webhook URL is proof the agent is reachable, so bump its
    // `lastHeartbeatAt` and (if it was OFFLINE) flip it back to ONLINE.
    // Best-effort — failures here are logged but don't fail the job.
    if (res.ok && presenceAgentId) {
      await recordAgentReachable(presenceAgentId);

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
      case "chat-compaction-sweep": {
        const res = await sweepChatCompaction(db);
        return res;
      }
      case "runs-dispatch-sweep": {
        const res = await ingestRunsDispatch();
        return res;
      }
      case "runtime-health-sweep": {
        const res = await sweepRuntimeHealth();
        return res;
      }
      case "orchestration-watchdog-sweep": {
        const res = await sweepOrchestrationBudget();
        return res;
      }
      case "expired-key-purge-sweep": {
        const res = await purgeExpiredSessionKeys();
        return res;
      }
      case "ephemeral-idle-sweep": {
        const res = await sweepIdleEphemeralAgents();
        return res;
      }
      case "completion-candidate-sweep": {
        return sweepCompletionCandidates(db);
      }
      case "github-reconciliation-sweep": {
        const recoveredAttachments = await recoverGenericGitHubAttachments(db);
        const reconciliation = await sweepGitHubStatusReconciliation(db);
        return { recoveredAttachments, reconciliation };
      }
      case "scheduled-task-sweep": {
        return sweepScheduledTasks();
      }
      case "work-session-stale-sweep": {
        return sweepStaleWorkSessions(db);
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

/** Periodic chat compaction sweep. Keeps long agent conversations bounded. */
export async function registerChatCompactionSweepJob(): Promise<void> {
  await maintenanceQueue.add(
    "chat-compaction-sweep",
    {},
    {
      jobId: CHAT_COMPACTION_SWEEP_JOB_ID,
      repeat: { every: CHAT_COMPACTION_SWEEP_INTERVAL_MS },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86_400, count: 50 },
    },
  );
}

/**
 * Drive dispatch-via-runs: start provider runs for fresh RUNS-engine
 * assignments and poll live ones onto their AgentRun. Polls every 5s —
 * frequent enough for a live Mission Control pulse, cheap (bounded
 * batches), and restart-safe (no in-memory subscription state).
 */
export async function registerRunsDispatchSweepJob(): Promise<void> {
  await maintenanceQueue.add(
    "runs-dispatch-sweep",
    {},
    {
      jobId: RUNS_DISPATCH_SWEEP_JOB_ID,
      repeat: { every: RUNS_DISPATCH_SWEEP_INTERVAL_MS },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86_400, count: 50 },
    },
  );
}

/**
 * Periodic health probe for outbound managed runtimes (the Codex app server).
 * A reachable endpoint is treated as a heartbeat — bumps the runtime + its
 * persistent agents so they read true online/offline. Same cadence as the
 * other presence sweeps.
 */
export async function registerRuntimeHealthSweepJob(): Promise<void> {
  await maintenanceQueue.add(
    "runtime-health-sweep",
    {},
    {
      jobId: RUNTIME_HEALTH_SWEEP_JOB_ID,
      repeat: { every: RUNTIME_HEALTH_SWEEP_INTERVAL_MS },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86_400, count: 50 },
    },
  );
}

/**
 * Periodic orchestration watchdog. Enforces plan WALL-TIME budgets independent
 * of cost reporting (a plan whose agents never report cost otherwise never has
 * its time cap checked) and logs plans that appear wedged.
 */
export async function registerOrchestrationWatchdogSweepJob(): Promise<void> {
  await maintenanceQueue.add(
    "orchestration-watchdog-sweep",
    {},
    {
      jobId: ORCH_WATCHDOG_SWEEP_JOB_ID,
      repeat: { every: ORCH_WATCHDOG_SWEEP_INTERVAL_MS },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86_400, count: 50 },
    },
  );
}

/**
 * Periodic purge of expired SESSION keys. Makes the documented "SESSION keys
 * are auto-purged when expired" contract real — expiry is otherwise only
 * enforced lazily at auth, so expired rows would linger in the DB + Clients UI.
 */
export async function registerExpiredKeyPurgeSweepJob(): Promise<void> {
  await maintenanceQueue.add(
    "expired-key-purge-sweep",
    {},
    {
      jobId: EXPIRED_KEY_PURGE_JOB_ID,
      repeat: { every: EXPIRED_KEY_PURGE_INTERVAL_MS },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86_400, count: 50 },
    },
  );
}

/**
 * Periodic archive of idle EPHEMERAL agents (session CLIs that vanished). Uses
 * each workspace's `ephemeralAgentIdleMinutes` (0 = disabled). Archive-only and
 * reversible; PERSISTENT agents are never touched.
 */
export async function registerEphemeralIdleSweepJob(): Promise<void> {
  await maintenanceQueue.add(
    "ephemeral-idle-sweep",
    {},
    {
      jobId: EPHEMERAL_IDLE_SWEEP_JOB_ID,
      repeat: { every: EPHEMERAL_IDLE_SWEEP_INTERVAL_MS },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86_400, count: 50 },
    },
  );
}

/** Reconcile missed or newly-unblocked completion/recovery decisions. */
export async function registerCompletionCandidateSweepJob(): Promise<void> {
  await maintenanceQueue.add(
    "completion-candidate-sweep",
    {},
    {
      jobId: COMPLETION_CANDIDATE_SWEEP_JOB_ID,
      repeat: { every: COMPLETION_CANDIDATE_SWEEP_INTERVAL_MS },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86_400, count: 50 },
    },
  );
}

/** Webhook repair loop for stale native GitHub implementation links. */
export async function registerGitHubReconciliationSweepJob(): Promise<void> {
  await maintenanceQueue.add(
    "github-reconciliation-sweep",
    {},
    {
      jobId: GITHUB_RECONCILIATION_SWEEP_JOB_ID,
      repeat: { every: GITHUB_RECONCILIATION_SWEEP_INTERVAL_MS },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86_400, count: 50 },
    },
  );
}

/** Claim and execute due first-class scheduled automation tasks. */
export async function registerScheduledTaskSweepJob(): Promise<void> {
  await maintenanceQueue.add(
    "scheduled-task-sweep",
    {},
    {
      jobId: SCHEDULED_TASK_SWEEP_JOB_ID,
      repeat: { every: SCHEDULED_TASK_SWEEP_INTERVAL_MS },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86_400, count: 50 },
    },
  );
}

/** Mark abandoned branch/worktree leases stale without silently releasing them. */
export async function registerWorkSessionSweepJob(): Promise<void> {
  await maintenanceQueue.add(
    "work-session-stale-sweep",
    {},
    {
      jobId: WORK_SESSION_SWEEP_JOB_ID,
      repeat: { every: WORK_SESSION_SWEEP_INTERVAL_MS },
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
void registerChatCompactionSweepJob().catch((err) => {
  logger.warn({ err }, "failed to register chat-compaction-sweep job");
});
void registerRunsDispatchSweepJob().catch((err) => {
  logger.warn({ err }, "failed to register runs-dispatch-sweep job");
});
void registerRuntimeHealthSweepJob().catch((err) => {
  logger.warn({ err }, "failed to register runtime-health-sweep job");
});
void registerOrchestrationWatchdogSweepJob().catch((err) => {
  logger.warn({ err }, "failed to register orchestration-watchdog-sweep job");
});
void registerExpiredKeyPurgeSweepJob().catch((err) => {
  logger.warn({ err }, "failed to register expired-key-purge-sweep job");
});
void registerEphemeralIdleSweepJob().catch((err) => {
  logger.warn({ err }, "failed to register ephemeral-idle-sweep job");
});
void registerCompletionCandidateSweepJob().catch((err) => {
  logger.warn({ err }, "failed to register completion-candidate-sweep job");
});
void registerGitHubReconciliationSweepJob().catch((err) => {
  logger.warn({ err }, "failed to register github-reconciliation-sweep job");
});
void registerScheduledTaskSweepJob().catch((err) => {
  logger.warn({ err }, "failed to register scheduled-task-sweep job");
});
void registerWorkSessionSweepJob().catch((err) => {
  logger.warn({ err }, "failed to register work-session-stale-sweep job");
});

if (import.meta.url === `file://${process.argv[1]}`) {
  logger.info("workers running");
}
