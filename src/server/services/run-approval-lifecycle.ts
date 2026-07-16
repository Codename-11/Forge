import "server-only";

import { EventKind, Prisma } from "@prisma/client";
import { recordChange } from "@/server/audit";
import { appendRunEvent } from "@/server/services/agent-run";

type Tx = Prisma.TransactionClient;

export type PendingRunApproval = {
  command: string | null;
  description: string | null;
  choices: string[];
};

/** Claim and persist a runtime approval exactly once. */
export async function captureRunApproval(
  tx: Tx,
  params: {
    runId: string;
    workspaceId: string;
    issueId: string;
    agentId: string;
    approval: PendingRunApproval | null;
    source: "poll" | "subscription";
    lastEvent?: string | null;
  },
): Promise<boolean> {
  const claimed = await tx.agentRun.updateMany({
    where: { id: params.runId, awaitingApprovalAt: null },
    data: {
      awaitingApprovalAt: new Date(),
      ...(params.approval ? { pendingApproval: params.approval } : {}),
    },
  });
  if (claimed.count === 0) {
    // The poller may have won with only a generic "waiting" state before
    // the subscription delivered the command. Enrich the canonical row but
    // do not append a second BLOCKED event.
    if (params.approval) {
      await tx.agentRun.updateMany({
        where: {
          id: params.runId,
          awaitingApprovalAt: { not: null },
          pendingApproval: { equals: Prisma.DbNull },
        },
        data: { pendingApproval: params.approval },
      });
    }
    return false;
  }

  await appendRunEvent(tx, {
    runId: params.runId,
    workspaceId: params.workspaceId,
    issueId: params.issueId,
    agentId: params.agentId,
    kind: "BLOCKED",
    currentStep: "waiting for approval",
    payload: {
      issueId: params.issueId,
      reason: "runtime-approval-required",
      source: params.source,
      approval: params.approval,
      lastEvent: params.lastEvent ?? null,
    },
  });
  await recordChange(tx, {
    workspaceId: params.workspaceId,
    actorId: null,
    actorAgentId: null,
    entity: "AgentRun",
    entityId: params.runId,
    action: "runtime-approval-required",
    after: {
      awaitingApproval: true,
      pendingApproval: params.approval,
    },
    eventKind: EventKind.AGENT_RUN_BLOCKED,
    subjectType: "agent-run",
    subjectId: params.runId,
    payload: {
      runId: params.runId,
      issueId: params.issueId,
      agentId: params.agentId,
      reason: params.approval?.description ?? "Runtime approval required",
      command: params.approval?.command ?? null,
      choices: params.approval?.choices ?? [],
      source: params.source,
    },
  });
  return true;
}

/**
 * Clear a pending approval exactly once. Provider callbacks and the human
 * response mutation can race; only the winner publishes the resolution.
 */
export async function resolveRunApproval(
  tx: Tx,
  params: {
    runId: string;
    workspaceId: string;
    issueId: string;
    agentId: string;
    source: "subscription" | "operator";
    decision?: string | null;
    currentStep: string;
  },
): Promise<boolean> {
  const claimed = await tx.agentRun.updateMany({
    where: { id: params.runId, awaitingApprovalAt: { not: null } },
    data: { awaitingApprovalAt: null, pendingApproval: Prisma.DbNull },
  });
  if (claimed.count === 0) return false;

  await appendRunEvent(tx, {
    runId: params.runId,
    workspaceId: params.workspaceId,
    issueId: params.issueId,
    agentId: params.agentId,
    kind: "STEP",
    currentStep: params.currentStep,
    payload: {
      issueId: params.issueId,
      approvalResolved: true,
      source: params.source,
      decision: params.decision ?? null,
    },
  });
  return true;
}
