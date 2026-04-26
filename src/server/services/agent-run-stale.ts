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
 */

export interface StalledRunSweepResult {
  workspacesScanned: number;
  stalled: string[];
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

  for (const ws of workspaces) {
    const cutoff = new Date(now.getTime() - ws.agentRunStaleMinutes * 60_000);
    const candidates = await client.agentRun.findMany({
      where: {
        workspaceId: ws.id,
        status: AgentRunStatus.ACTIVE,
        lastEventAt: { lt: cutoff },
      },
      select: {
        id: true,
        issueId: true,
        agentId: true,
        lastEventAt: true,
        currentStep: true,
      },
    });

    for (const run of candidates) {
      try {
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

  return { workspacesScanned: workspaces.length, stalled };
}
