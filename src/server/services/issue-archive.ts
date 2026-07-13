import "server-only";
import { EventKind, ExecutionStepStatus, type Prisma, type PrismaClient } from "@prisma/client";
import { recordChange } from "@/server/audit";
import { finishRunsForIssue } from "@/server/services/agent-run";
import { syncMaterializedStepTerminalFromIssue } from "@/server/services/execution-step-issue-sync";

type Tx = PrismaClient | Prisma.TransactionClient;

export class IssueArchiveNotFoundError extends Error {
  constructor() {
    super("Issue not found in this workspace.");
    this.name = "IssueArchiveNotFoundError";
  }
}

export class IssueArchiveConflictError extends Error {
  constructor() {
    super(
      "Issue is linked to more than one active execution step. Resolve the plan steps before archiving it.",
    );
    this.name = "IssueArchiveConflictError";
  }
}

export interface IssueArchiveActor {
  actorId: string | null;
  actorAgentId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Reversibly archive an Issue while closing every live work surface that
 * could otherwise keep acting on the now-hidden row. Callers should invoke
 * this inside their transaction so the issue, run, step, audit, and activity
 * changes commit together.
 */
export async function archiveIssue(
  tx: Tx,
  params: IssueArchiveActor & {
    workspaceId: string;
    issueId: string;
    action?: string;
    via?: string;
    metadata?: Record<string, string | number | boolean | null>;
    now?: Date;
  },
): Promise<{ archived: boolean; canceledStepId: string | null }> {
  const issue = await tx.issue.findFirst({
    where: { id: params.issueId, workspaceId: params.workspaceId },
    select: {
      id: true,
      deletedAt: true,
      queued: true,
      claimedAt: true,
      claimedById: true,
      claimedByAgentId: true,
      claimExpiresAt: true,
      snoozedUntil: true,
    },
  });
  if (!issue) throw new IssueArchiveNotFoundError();
  if (issue.deletedAt) return { archived: false, canceledStepId: null };

  const activeSteps = await tx.executionStep.findMany({
    where: {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      status: { notIn: [ExecutionStepStatus.DONE, ExecutionStepStatus.CANCELED] },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: 2,
    select: { id: true },
  });
  if (activeSteps.length > 1) throw new IssueArchiveConflictError();

  const stepResult =
    activeSteps.length === 1
      ? await syncMaterializedStepTerminalFromIssue(tx, {
          workspaceId: params.workspaceId,
          issueId: params.issueId,
          category: "CANCELED",
          actorId: params.actorId,
          actorAgentId: params.actorAgentId ?? null,
        })
      : null;

  const now = params.now ?? new Date();
  await tx.issue.update({
    where: { id: issue.id },
    data: {
      deletedAt: now,
      queued: false,
      claimedAt: null,
      claimedById: null,
      claimedByAgentId: null,
      claimExpiresAt: null,
      snoozedUntil: null,
    },
  });
  await finishRunsForIssue(tx, {
    workspaceId: params.workspaceId,
    issueId: issue.id,
    status: "ABANDONED",
    actorId: params.actorId,
    actorAgentId: params.actorAgentId ?? null,
  });
  await recordChange(tx, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    actorAgentId: params.actorAgentId ?? null,
    entity: "Issue",
    entityId: issue.id,
    action: params.action ?? "archive",
    before: {
      deletedAt: null,
      queued: issue.queued,
      claimedAt: issue.claimedAt,
      claimedById: issue.claimedById,
      claimedByAgentId: issue.claimedByAgentId,
      claimExpiresAt: issue.claimExpiresAt,
      snoozedUntil: issue.snoozedUntil,
    },
    after: {
      deletedAt: now,
      queued: false,
      claimedAt: null,
      claimedById: null,
      claimedByAgentId: null,
      claimExpiresAt: null,
      snoozedUntil: null,
    },
    eventKind: EventKind.ISSUE_DELETED,
    subjectType: "issue",
    subjectId: issue.id,
    payload: {
      archivedAt: now.toISOString(),
      canceledStepId: stepResult?.stepId ?? null,
      ...(params.via ? { via: params.via } : {}),
      ...(params.metadata ?? {}),
    },
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
  });
  return { archived: true, canceledStepId: stepResult?.stepId ?? null };
}

/** Restore visibility only. Prior claims, queue state, runs, and plan steps stay closed. */
export async function restoreIssue(
  tx: Tx,
  params: IssueArchiveActor & {
    workspaceId: string;
    issueId: string;
    now?: Date;
  },
): Promise<{ restored: boolean }> {
  const issue = await tx.issue.findFirst({
    where: { id: params.issueId, workspaceId: params.workspaceId },
    select: { id: true, deletedAt: true },
  });
  if (!issue) throw new IssueArchiveNotFoundError();
  if (!issue.deletedAt) return { restored: false };

  await tx.issue.update({ where: { id: issue.id }, data: { deletedAt: null } });
  const restoredAt = params.now ?? new Date();
  await recordChange(tx, {
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    actorAgentId: params.actorAgentId ?? null,
    entity: "Issue",
    entityId: issue.id,
    action: "restore",
    before: { deletedAt: issue.deletedAt },
    after: { deletedAt: null },
    eventKind: EventKind.ISSUE_UPDATED,
    subjectType: "issue",
    subjectId: issue.id,
    payload: { restoredAt: restoredAt.toISOString() },
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
  });
  return { restored: true };
}
