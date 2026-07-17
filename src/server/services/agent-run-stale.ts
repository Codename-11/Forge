import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { AgentRunStatus } from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { finishRun } from "@/server/services/agent-run";

/**
 * Stalled-AgentRun watchdog. Sweeps every minute (scheduled by
 * `src/server/worker.ts`). For each workspace where
 * `agentRunStaleMinutes > 0`, finds ACTIVE runs whose `lastEventAt` is
 * older than the threshold and closes them with status STALLED.
 *
 * Closing is delegated to `finishRun()` so each transition emits an
 * `AGENT_RUN_STALLED` event (audit log + ActivityEvent + SSE), and the
 * live pulse strip on the issue page updates in real time.
 *
 * Idempotent by design: once a run flips to STALLED, the next sweep
 * skips it because the `status: ACTIVE` filter excludes it.
 *
 * WAITING runs are intentionally excluded — the agent has self-blocked
 * via `runs.setWaiting` and is patiently waiting on the operator. The
 * watchdog would misclassify a patient agent as dead otherwise. When
 * the WAITING run flips back to ACTIVE (via `runs.resumeWork` or any
 * agent activity routed through `openOrTouchRun`), `lastEventAt`
 * is bumped to `now`, so the stale timer restarts fresh.
 */

export interface StalledRunSweepResult {
  workspacesScanned: number;
  stalled: string[];
  /** Lease-backed MCP attempts whose lifecycle is unknown, not failed. */
  quiet: string[];
  /** Historical comment-only MCP rows repaired without claiming execution. */
  reconciledPassiveMcp: string[];
}

async function reconcilePassivePostMergeMcpRun(
  client: PrismaClient,
  run: {
    id: string;
    workspaceId: string;
    issueId: string;
    agentId: string;
    connectionId: string | null;
    startedAt: Date;
    lastEventAt: Date;
    currentStep: string | null;
    externalRunId: string | null;
    assignmentEventId: string | null;
    triggerEventId: string | null;
    executionStepId: string | null;
    acknowledgedAt: Date | null;
    outputStartedAt: Date | null;
    wakeAttempts: number;
    lastWakeDeliveryId: string | null;
    completionMeta: Prisma.JsonValue | null;
  },
): Promise<boolean> {
  if (
    run.currentStep ||
    run.externalRunId ||
    run.assignmentEventId ||
    run.triggerEventId ||
    run.executionStepId ||
    run.acknowledgedAt ||
    !run.outputStartedAt ||
    run.wakeAttempts > 0 ||
    run.lastWakeDeliveryId
  ) {
    return false;
  }
  return client.$transaction(async (tx) => {
    const events = await tx.agentRunEvent.findMany({
      where: { runId: run.id },
      select: { kind: true },
      orderBy: { createdAt: "asc" },
    });
    if (events.length !== 1 || events[0]?.kind !== "STARTED") return false;
    const mergedDelivery = await tx.workSession.findFirst({
      where: {
        workspaceId: run.workspaceId,
        issueId: run.issueId,
        status: { in: ["MERGED", "RELEASED", "DEPLOYED", "VERIFIED"] },
        mergedAt: { not: null, lte: run.startedAt },
      },
      select: { id: true },
    });
    if (!mergedDelivery) return false;
    const terminalComment = await tx.comment.findFirst({
      where: {
        workspaceId: run.workspaceId,
        issueId: run.issueId,
        authoringAgentId: run.agentId,
        kind: "BODY",
        runId: null,
        deletedAt: null,
        createdAt: {
          gte: new Date(run.startedAt.getTime() - 30_000),
          lte: new Date(run.startedAt.getTime() + 5_000),
        },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!terminalComment) return false;

    const priorMeta =
      run.completionMeta &&
      typeof run.completionMeta === "object" &&
      !Array.isArray(run.completionMeta)
        ? { ...(run.completionMeta as Record<string, unknown>) }
        : {};
    // Claim the unchanged metadata-only row before finishing it. A concurrent
    // status/event touch bumps lastEventAt and makes this CAS fail; once this
    // update acquires the row lock, appendRunEvent cannot revive it after the
    // terminal transition in the same transaction.
    const claimed = await tx.agentRun.updateMany({
      where: {
        id: run.id,
        status: AgentRunStatus.ACTIVE,
        lastEventAt: run.lastEventAt,
        currentStep: null,
        externalRunId: null,
        assignmentEventId: null,
        triggerEventId: null,
        executionStepId: null,
        acknowledgedAt: null,
        outputStartedAt: { not: null },
        wakeAttempts: 0,
        lastWakeDeliveryId: null,
      },
      data: {
        engagementMode: "DISCUSS",
        completionMeta: {
          ...priorMeta,
          terminalCommentId: terminalComment.id,
          completionCommentId: terminalComment.id,
          lifecycleReconciliation: {
            kind: "PASSIVE_MCP_METADATA",
            workSessionId: mergedDelivery.id,
            reconciledAt: new Date().toISOString(),
          },
        } as Prisma.InputJsonValue,
      },
    });
    if (claimed.count !== 1) return false;
    const finished = await finishRun(tx, {
      runId: run.id,
      workspaceId: run.workspaceId,
      issueId: run.issueId,
      agentId: run.agentId,
      status: "COMPLETED",
      summary: "Reconciled passive MCP comment metadata after the implementation merged.",
    });
    return finished?.status === "COMPLETED";
  });
}

export async function sweepStalledRuns(client: PrismaClient = db): Promise<StalledRunSweepResult> {
  const now = new Date();
  const workspaces = await client.workspace.findMany({
    where: { agentRunStaleMinutes: { gt: 0 }, deletedAt: null },
    select: { id: true, agentRunStaleMinutes: true },
  });

  const stalled: string[] = [];
  const quiet: string[] = [];
  const reconciledPassiveMcp: string[] = [];

  for (const ws of workspaces) {
    const cutoff = new Date(now.getTime() - ws.agentRunStaleMinutes * 60_000);
    const candidates = await client.agentRun.findMany({
      where: {
        workspaceId: ws.id,
        status: AgentRunStatus.ACTIVE,
        lastEventAt: { lt: cutoff },
        // A run paused awaiting operator approval is intentionally idle —
        // don't misclassify it as stalled.
        awaitingApprovalAt: null,
      },
      select: {
        id: true,
        workspaceId: true,
        issueId: true,
        agentId: true,
        startedAt: true,
        lastEventAt: true,
        currentStep: true,
        connectionId: true,
        externalRunId: true,
        assignmentEventId: true,
        triggerEventId: true,
        executionStepId: true,
        acknowledgedAt: true,
        outputStartedAt: true,
        wakeAttempts: true,
        lastWakeDeliveryId: true,
        completionMeta: true,
        connection: { select: { kind: true, status: true } },
      },
    });

    for (const run of candidates) {
      try {
        if (run.connection?.kind === "MCP_CLIENT") {
          if (await reconcilePassivePostMergeMcpRun(client, run)) {
            reconciledPassiveMcp.push(run.id);
            continue;
          }
          if (run.connection.status === "QUIET") continue;
          // Streamable HTTP clients do not provide a durable process signal.
          // Silence expires confidence, not the run: external Git/PR work may
          // still be progressing and automatic redispatch would create a
          // competing implementation.
          await client.agentRun.updateMany({
            where: { id: run.id, status: AgentRunStatus.ACTIVE },
            data: { lifecycleConfidence: "UNCONFIRMED" },
          });
          if (run.connectionId) {
            await client.agentConnection.updateMany({
              where: { id: run.connectionId, status: "ACTIVE" },
              data: { status: "QUIET", confidence: "UNCONFIRMED" },
            });
          }
          quiet.push(run.id);
          continue;
        }
        await finishRun(client, {
          runId: run.id,
          workspaceId: ws.id,
          issueId: run.issueId,
          agentId: run.agentId,
          status: "STALLED",
          summary: run.currentStep
            ? `No activity since ${run.lastEventAt.toISOString()} — last step: ${run.currentStep}`
            : `No activity since ${run.lastEventAt.toISOString()}`,
        });
        stalled.push(run.id);
      } catch (err) {
        logger.warn(
          { err, runId: run.id, workspaceId: ws.id },
          "agent-run-stale: failed to close stalled run",
        );
      }
    }
  }

  return { workspacesScanned: workspaces.length, stalled, quiet, reconciledPassiveMcp };
}
