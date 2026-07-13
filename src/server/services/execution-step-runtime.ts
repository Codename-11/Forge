import "server-only";
import { EventKind, ExecutionStepStatus } from "@prisma/client";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Move a plan step into RUNNING only when its worker has actually started.
 * The READY guard makes this safe for reviewer runs and idempotent retries.
 */
export async function markExecutionStepRunning(
  tx: PrismaClient | Prisma.TransactionClient,
  params: {
    workspaceId: string;
    executionStepId: string | null | undefined;
    runId: string;
    actorAgentId?: string | null;
  },
): Promise<boolean> {
  if (!params.executionStepId) return false;
  const step = await tx.executionStep.findFirst({
    where: {
      id: params.executionStepId,
      workspaceId: params.workspaceId,
      status: ExecutionStepStatus.READY,
    },
    select: { id: true, planId: true },
  });
  if (!step) return false;
  const updated = await tx.executionStep.updateMany({
    where: {
      id: step.id,
      workspaceId: params.workspaceId,
      status: ExecutionStepStatus.READY,
    },
    data: { status: ExecutionStepStatus.RUNNING },
  });
  if (updated.count === 0) return false;
  // Dynamic import avoids audit -> inbox -> lifecycle -> audit initialization
  // cycle; this helper is invoked after event ingestion modules are loaded.
  const { recordChange } = await import("@/server/audit");
  await recordChange(tx, {
    workspaceId: params.workspaceId,
    actorId: null,
    actorAgentId: params.actorAgentId ?? null,
    entity: "ExecutionStep",
    entityId: step.id,
    action: "start",
    before: { status: ExecutionStepStatus.READY },
    after: { status: ExecutionStepStatus.RUNNING },
    eventKind: EventKind.AGENT_RUN_STEP,
    subjectType: "execution-step",
    subjectId: step.id,
    payload: { planId: step.planId, runId: params.runId, status: ExecutionStepStatus.RUNNING },
  });
  const { syncMaterializedIssueStatusFromStep } =
    await import("@/server/services/execution-step-issue-sync");
  await syncMaterializedIssueStatusFromStep(tx, {
    workspaceId: params.workspaceId,
    stepId: step.id,
    actorId: null,
    actorAgentId: params.actorAgentId ?? null,
  });
  return true;
}
