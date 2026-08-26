import "server-only";
import {
  RuntimeDiagnosticExecutor,
  RuntimeDiagnosticKind,
  RuntimeDiagnosticTrigger,
  type Prisma,
  type PrismaClient,
  type RuntimeSelfTestStatus,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { runtimeDiagnosticQueue } from "@/server/queues";
import { getRuntimeAdapter } from "@/server/runtimes/adapters";
import { probeRuntime } from "@/server/services/dispatch/runtime-probe";
import { recordRuntimeHeartbeatPresence } from "@/server/services/heartbeat";
import { runtimeInfoUpdateData } from "@/server/services/runtime-info";
import { runRuntimeSelfTest } from "@/server/services/runtime-self-test";
import { sanitizeRuntimeProbeDetail } from "@/server/services/runtime-status";

export type RuntimeDiagnosticJob = {
  requestId: string;
  workspaceId: string;
  runtimeId: string;
};

export type RequestRuntimeDiagnosticInput = {
  workspaceId: string;
  runtimeId: string;
  kind: RuntimeDiagnosticKind;
  trigger: RuntimeDiagnosticTrigger;
  requestedById?: string | null;
};

const HISTORY_LIMIT = 200;

export async function requestRuntimeDiagnostic(
  input: RequestRuntimeDiagnosticInput,
  client: PrismaClient | Prisma.TransactionClient = db,
): Promise<string> {
  const requestId = randomUUID();
  await client.runtimeDiagnosticAttempt.create({
    data: {
      requestId,
      workspaceId: input.workspaceId,
      runtimeId: input.runtimeId,
      kind: input.kind,
      trigger: input.trigger,
      requestedById: input.requestedById ?? null,
    },
  });
  try {
    await runtimeDiagnosticQueue.add(
      "runtime-diagnostic",
      { requestId, workspaceId: input.workspaceId, runtimeId: input.runtimeId },
      {
        jobId: `runtime-diagnostic-${requestId}`,
        removeOnComplete: { age: 3600, count: 200 },
        removeOnFail: { age: 86_400, count: 200 },
      },
    );
  } catch (error) {
    await client.runtimeDiagnosticAttempt.update({
      where: { requestId },
      data: {
        attempted: false,
        detail: sanitizeRuntimeProbeDetail(
          `Runtime diagnostic could not be queued: ${error instanceof Error ? error.message : "queue unavailable"}`,
        ),
        completedAt: new Date(),
      },
    });
    throw error;
  }
  return requestId;
}

export async function waitForRuntimeDiagnostic(
  requestId: string,
  opts: {
    timeoutMs: number;
    client?: PrismaClient | Prisma.TransactionClient;
    pollMs?: number;
  },
) {
  const client = opts.client ?? db;
  const deadline = Date.now() + opts.timeoutMs;
  do {
    const attempt = await client.runtimeDiagnosticAttempt.findUnique({ where: { requestId } });
    if (attempt?.completedAt) return attempt;
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 125));
  } while (Date.now() < deadline);
  throw new Error(
    "The runtime worker did not finish the diagnostic in time. Check the worker and its outbound network before retrying.",
  );
}

export async function executeRuntimeDiagnostic(
  job: RuntimeDiagnosticJob,
  client: PrismaClient | Prisma.TransactionClient = db,
) {
  const attempt = await client.runtimeDiagnosticAttempt.findFirst({
    where: {
      requestId: job.requestId,
      workspaceId: job.workspaceId,
      runtimeId: job.runtimeId,
    },
  });
  if (!attempt) throw new Error("Runtime diagnostic request was not found.");
  if (attempt.completedAt) return attempt;

  const runtime = await client.runtime.findFirst({
    where: { id: job.runtimeId, workspaceId: job.workspaceId },
  });
  if (!runtime) {
    return client.runtimeDiagnosticAttempt.update({
      where: { id: attempt.id },
      data: { detail: "Runtime not found in this workspace.", completedAt: new Date() },
    });
  }

  const completedAt = new Date();
  if (attempt.kind === RuntimeDiagnosticKind.PROBE) {
    const probe = await probeRuntime({
      adapterKey: runtime.adapterKey,
      endpoint: runtime.endpoint,
      secret: runtime.secret,
    });
    const detail = sanitizeRuntimeProbeDetail(probe.detail);
    const countsAsHeartbeat =
      probe.reachable === true &&
      getRuntimeAdapter(runtime.adapterKey)?.transport === "app-server" &&
      getRuntimeAdapter(runtime.adapterKey)?.capabilities.presence === "runtime-heartbeat";
    await client.runtime.update({
      where: { id: runtime.id },
      data: {
        lastProbeAt: completedAt,
        lastProbeAttempted: probe.attempted,
        lastProbeReachable: probe.reachable,
        lastProbeDetail: detail,
        ...runtimeInfoUpdateData(probe.runtimeInfo, completedAt),
        ...(countsAsHeartbeat ? { heartbeatAt: completedAt } : {}),
      },
    });
    await client.runtimeDiagnosticAttempt.update({
      where: { id: attempt.id },
      data: {
        executor: RuntimeDiagnosticExecutor.WORKER,
        attempted: probe.attempted,
        reachable: probe.reachable,
        detail,
        completedAt,
      },
    });
    if (countsAsHeartbeat) {
      await recordRuntimeHeartbeatPresence(runtime.id, completedAt, client);
    }
  } else {
    const result = await runRuntimeSelfTest(runtime);
    await client.runtime.update({
      where: { id: runtime.id },
      data: {
        lastSelfTestAt: completedAt,
        lastSelfTestStatus: result.status,
        lastSelfTestDetail: result.detail,
        lastSelfTestDurationMs: result.durationMs,
      },
    });
    await client.runtimeDiagnosticAttempt.update({
      where: { id: attempt.id },
      data: {
        executor: RuntimeDiagnosticExecutor.WORKER,
        attempted: result.attempted,
        selfTestStatus: result.status,
        detail: result.detail,
        durationMs: result.durationMs,
        completedAt,
      },
    });
  }

  await pruneRuntimeDiagnosticHistory(runtime.id, client);
  return client.runtimeDiagnosticAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
}

/**
 * Worker boundary for queued diagnostics. Network probes and connector
 * self-tests normally resolve failures as data, but an unexpected executor or
 * persistence error must still close the request so operators do not get an
 * eternal "waiting" row and web callers do not misdiagnose it as worker
 * silence.
 */
export async function executeQueuedRuntimeDiagnostic(
  job: RuntimeDiagnosticJob,
  client: PrismaClient | Prisma.TransactionClient = db,
  execute: (
    job: RuntimeDiagnosticJob,
    client: PrismaClient | Prisma.TransactionClient,
  ) => Promise<unknown> = executeRuntimeDiagnostic,
) {
  try {
    return await execute(job, client);
  } catch (error) {
    const attempt = await client.runtimeDiagnosticAttempt.findFirst({
      where: {
        requestId: job.requestId,
        workspaceId: job.workspaceId,
        runtimeId: job.runtimeId,
        completedAt: null,
      },
      select: { id: true, kind: true },
    });
    if (attempt) {
      const detail = sanitizeRuntimeProbeDetail(
        `Worker diagnostic failed: ${error instanceof Error ? error.message : "unexpected executor error"}`,
      );
      await client.runtimeDiagnosticAttempt.update({
        where: { id: attempt.id },
        data: {
          executor: RuntimeDiagnosticExecutor.WORKER,
          attempted: true,
          reachable: attempt.kind === RuntimeDiagnosticKind.PROBE ? false : undefined,
          selfTestStatus: attempt.kind === RuntimeDiagnosticKind.SELF_TEST ? "FAILED" : undefined,
          detail,
          completedAt: new Date(),
        },
      });
    }
    throw error;
  }
}

export async function runScheduledRuntimeProbe(
  input: { workspaceId: string; runtimeId: string },
  client: PrismaClient | Prisma.TransactionClient = db,
) {
  const requestId = randomUUID();
  await client.runtimeDiagnosticAttempt.create({
    data: {
      requestId,
      workspaceId: input.workspaceId,
      runtimeId: input.runtimeId,
      kind: RuntimeDiagnosticKind.PROBE,
      trigger: RuntimeDiagnosticTrigger.SCHEDULED_SWEEP,
    },
  });
  return executeRuntimeDiagnostic({ requestId, ...input }, client);
}

async function pruneRuntimeDiagnosticHistory(
  runtimeId: string,
  client: PrismaClient | Prisma.TransactionClient,
) {
  const stale = await client.runtimeDiagnosticAttempt.findMany({
    where: { runtimeId },
    orderBy: { createdAt: "desc" },
    skip: HISTORY_LIMIT,
    select: { id: true },
  });
  if (stale.length) {
    await client.runtimeDiagnosticAttempt.deleteMany({
      where: { id: { in: stale.map((row) => row.id) } },
    });
  }
}

export function diagnosticResult(attempt: {
  kind: RuntimeDiagnosticKind;
  attempted: boolean;
  reachable: boolean | null;
  selfTestStatus: RuntimeSelfTestStatus | null;
  detail: string | null;
  durationMs: number | null;
  executor: RuntimeDiagnosticExecutor;
  trigger: RuntimeDiagnosticTrigger;
  completedAt: Date | null;
}) {
  return {
    attempted: attempt.attempted,
    reachable: attempt.reachable,
    status: attempt.selfTestStatus,
    detail: attempt.detail ?? "Runtime diagnostic completed without detail.",
    durationMs: attempt.durationMs,
    executor: attempt.executor,
    trigger: attempt.trigger,
    completedAt: attempt.completedAt,
  };
}
