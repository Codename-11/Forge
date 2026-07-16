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
}

export async function sweepStalledRuns(
  client: PrismaClient | Prisma.TransactionClient = db,
): Promise<StalledRunSweepResult> {
  const now = new Date();
  const workspaces = await client.workspace.findMany({
    where: { agentRunStaleMinutes: { gt: 0 }, deletedAt: null },
    select: { id: true, agentRunStaleMinutes: true },
  });

  const stalled: string[] = [];
  const quiet: string[] = [];

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
        issueId: true,
        agentId: true,
        lastEventAt: true,
        currentStep: true,
        connectionId: true,
        connection: { select: { kind: true, status: true } },
      },
    });

    for (const run of candidates) {
      try {
        if (run.connection?.kind === "MCP_CLIENT") {
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

  return { workspacesScanned: workspaces.length, stalled, quiet };
}
