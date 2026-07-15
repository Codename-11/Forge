import "server-only";

import {
  ActionRequestKind,
  ActionRequestStatus,
  EventKind,
  NotificationSeverity,
  WorkSessionStatus,
} from "@prisma/client";
import type { Prisma, PrismaClient, WorkSessionSource } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { recordChange } from "@/server/audit";
import { createActionRequest } from "@/server/services/action-request-service";

type DbClient = PrismaClient | Prisma.TransactionClient;

export const ACTIVE_WORK_SESSION_STATUSES: readonly WorkSessionStatus[] = [
  WorkSessionStatus.CLAIMED,
  WorkSessionStatus.IN_PROGRESS,
  WorkSessionStatus.PR_OPEN,
  WorkSessionStatus.IN_REVIEW,
  WorkSessionStatus.READY_TO_MERGE,
  WorkSessionStatus.MERGED,
  WorkSessionStatus.RELEASED,
  WorkSessionStatus.DEPLOYED,
  WorkSessionStatus.STALE,
];

const DELIVERY_STATUSES = new Set<WorkSessionStatus>([
  WorkSessionStatus.MERGED,
  WorkSessionStatus.RELEASED,
  WorkSessionStatus.DEPLOYED,
  WorkSessionStatus.VERIFIED,
]);

const STALEABLE_WORK_SESSION_STATUSES: readonly WorkSessionStatus[] = [
  WorkSessionStatus.CLAIMED,
  WorkSessionStatus.IN_PROGRESS,
  WorkSessionStatus.PR_OPEN,
  WorkSessionStatus.IN_REVIEW,
  WorkSessionStatus.READY_TO_MERGE,
];

export type WorkSessionActor = {
  userId: string | null;
  agentId?: string | null;
};

async function resolveStaleRequest(
  db: PrismaClient,
  workspaceId: string,
  sessionId: string,
  resolution: string,
) {
  await db.actionRequest.updateMany({
    where: {
      workspaceId,
      dedupeKey: `work-session-stale:${sessionId}`,
      status: ActionRequestStatus.OPEN,
    },
    data: {
      status: ActionRequestStatus.RESOLVED,
      resolvedAt: new Date(),
      resolution,
    },
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function auditJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isPassingChecks(metadata: unknown): boolean {
  const checks = record(record(metadata).checks);
  return (
    checks.source === "api-aggregate" &&
    checks.status === "completed" &&
    typeof checks.conclusion === "string" &&
    ["success", "neutral", "skipped"].includes(checks.conclusion)
  );
}

function reviewDecision(metadata: unknown): string | null {
  const meta = record(metadata);
  const review = record(meta.review);
  return typeof meta.reviewDecision === "string"
    ? meta.reviewDecision
    : typeof review.decision === "string"
      ? review.decision
      : null;
}

export function deriveWorkSessionPrStatus(resource: {
  state: string;
  metadata: unknown;
}): WorkSessionStatus {
  if (resource.state === "merged") return WorkSessionStatus.MERGED;
  if (resource.state === "draft") return WorkSessionStatus.PR_OPEN;
  const meta = record(resource.metadata);
  const decision = reviewDecision(resource.metadata);
  const mergeable = typeof meta.mergeableState === "string" ? meta.mergeableState : null;
  if (
    resource.state === "open" &&
    decision === "APPROVED" &&
    isPassingChecks(resource.metadata) &&
    mergeable !== "dirty" &&
    mergeable !== "blocked"
  ) {
    return WorkSessionStatus.READY_TO_MERGE;
  }
  return WorkSessionStatus.IN_REVIEW;
}

async function auditSession(
  db: DbClient,
  session: { id: string; workspaceId: string; issueId: string },
  actor: WorkSessionActor,
  action: string,
  before: unknown,
  after: unknown,
) {
  await recordChange(db, {
    workspaceId: session.workspaceId,
    actorId: actor.userId,
    actorAgentId: actor.agentId ?? null,
    entity: "WorkSession",
    entityId: session.id,
    action,
    before: auditJson(before),
    after: auditJson(after),
    eventKind: EventKind.ISSUE_UPDATED,
    subjectType: "issue",
    subjectId: session.issueId,
    payload: { action, workSessionId: session.id },
  });
}

export async function claimWorkSession(
  db: PrismaClient,
  input: {
    workspaceId: string;
    issueId: string;
    repoFullName: string;
    branch: string;
    baseBranch?: string;
    worktreePath?: string | null;
    source: WorkSessionSource;
    actor: WorkSessionActor;
  },
) {
  if (!input.actor.userId && !input.actor.agentId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "A work-session owner is required." });
  }
  const result = await db.$transaction(async (tx) => {
    const issue = await tx.issue.findFirst({
      where: { id: input.issueId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!issue) throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found." });

    const active = await tx.workSession.findFirst({
      where: { issueId: input.issueId, status: { in: [...ACTIVE_WORK_SESSION_STATUSES] } },
      include: {
        ownerUser: { select: { id: true, name: true, email: true } },
        ownerAgent: { select: { id: true, name: true, profileKey: true } },
      },
    });
    if (active) {
      const sameOwner = input.actor.agentId
        ? active.ownerAgentId === input.actor.agentId
        : active.ownerUserId === input.actor.userId;
      if (
        sameOwner &&
        active.repoFullName === input.repoFullName &&
        active.branch === input.branch
      ) {
        return tx.workSession.update({
          where: { id: active.id },
          data: {
            lastHeartbeatAt: new Date(),
            staleAt: null,
            status:
              active.status === WorkSessionStatus.STALE
                ? WorkSessionStatus.IN_PROGRESS
                : active.status,
            worktreePath: input.worktreePath ?? active.worktreePath,
          },
        });
      }
      const owner =
        active.ownerAgent?.name ??
        active.ownerUser?.name ??
        active.ownerUser?.email ??
        "another task";
      throw new TRPCError({
        code: "CONFLICT",
        message: `${owner} already owns active work on ${active.branch}. Continue that session or abandon it before starting another.`,
      });
    }

    const created = await tx.workSession.create({
      data: {
        workspaceId: input.workspaceId,
        issueId: input.issueId,
        ownerUserId: input.actor.userId,
        ownerAgentId: input.actor.agentId ?? null,
        source: input.source,
        status: WorkSessionStatus.CLAIMED,
        repoFullName: input.repoFullName,
        branch: input.branch,
        baseBranch: input.baseBranch || "main",
        worktreePath: input.worktreePath ?? null,
      },
    });
    await auditSession(tx, created, input.actor, "work-session-claimed", undefined, created);
    return created;
  });
  await resolveStaleRequest(db, input.workspaceId, result.id, "Work session resumed.");
  return result;
}

export async function listIssueWorkSessions(
  db: PrismaClient,
  workspaceId: string,
  issueId: string,
) {
  const issue = await db.issue.findFirst({
    where: { id: issueId, workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!issue) throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found." });

  const sessions = await db.workSession.findMany({
    where: { workspaceId, issueId },
    orderBy: { createdAt: "desc" },
    include: {
      ownerUser: { select: { id: true, name: true, email: true, image: true } },
      ownerAgent: { select: { id: true, name: true, profileKey: true, avatar: true } },
      pullRequest: {
        select: {
          id: true,
          number: true,
          repoFullName: true,
          url: true,
          title: true,
          state: true,
          metadata: true,
          lastSyncedAt: true,
          syncLastError: true,
        },
      },
    },
  });

  // Auto-bind an IMPLEMENTS PR whose head branch matches the session. This is
  // intentionally a repair path: explicit linking remains preferred.
  const unbound = sessions.find(
    (session) => !session.pullRequestId && !DELIVERY_STATUSES.has(session.status),
  );
  if (unbound) {
    const links = await db.externalResourceLink.findMany({
      where: {
        workspaceId,
        issueId,
        kind: "IMPLEMENTS",
        externalResource: { resourceType: "PULL_REQUEST" },
      },
      include: { externalResource: true },
    });
    const match = links.find(
      (link) => record(record(link.externalResource.metadata).head).ref === unbound.branch,
    );
    if (match) {
      await attachPullRequest(db, {
        workspaceId,
        sessionId: unbound.id,
        externalResourceId: match.externalResourceId,
        actor: { userId: null },
      });
      return listIssueWorkSessions(db, workspaceId, issueId);
    }
  }
  return sessions;
}

export async function touchWorkSession(
  db: PrismaClient,
  input: {
    workspaceId: string;
    sessionId: string;
    actor: WorkSessionActor;
    headSha?: string | null;
    worktreePath?: string | null;
  },
) {
  const session = await db.workSession.findFirst({
    where: { id: input.sessionId, workspaceId: input.workspaceId },
  });
  if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Work session not found." });
  const updated = await db.workSession.update({
    where: { id: session.id },
    data: {
      lastHeartbeatAt: new Date(),
      staleAt: null,
      status:
        session.status === WorkSessionStatus.CLAIMED || session.status === WorkSessionStatus.STALE
          ? WorkSessionStatus.IN_PROGRESS
          : session.status,
      ...(input.headSha !== undefined ? { headSha: input.headSha } : {}),
      ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
    },
  });
  await resolveStaleRequest(db, input.workspaceId, session.id, "Work session resumed.");
  return updated;
}

export async function attachPullRequest(
  db: PrismaClient,
  input: {
    workspaceId: string;
    sessionId: string;
    externalResourceId: string;
    actor: WorkSessionActor;
  },
) {
  const result = await db.$transaction(async (tx) => {
    const session = await tx.workSession.findFirst({
      where: { id: input.sessionId, workspaceId: input.workspaceId },
    });
    if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Work session not found." });
    const resource = await tx.externalResource.findFirst({
      where: {
        id: input.externalResourceId,
        workspaceId: input.workspaceId,
        resourceType: "PULL_REQUEST",
      },
    });
    if (!resource) throw new TRPCError({ code: "NOT_FOUND", message: "Pull request not found." });
    const head = record(record(resource.metadata).head);
    if (typeof head.ref === "string" && head.ref !== session.branch) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `PR branch ${head.ref} does not match work session branch ${session.branch}.`,
      });
    }
    const derived = deriveWorkSessionPrStatus(resource);
    const now = new Date();
    const updated = await tx.workSession.update({
      where: { id: session.id },
      data: {
        pullRequestId: resource.id,
        headSha: typeof head.sha === "string" ? head.sha : session.headSha,
        status: DELIVERY_STATUSES.has(session.status) ? session.status : derived,
        lastHeartbeatAt: now,
        ...(derived === WorkSessionStatus.MERGED
          ? {
              mergedAt:
                typeof record(resource.metadata).mergedAt === "string"
                  ? new Date(record(resource.metadata).mergedAt as string)
                  : now,
            }
          : {}),
      },
    });
    await auditSession(tx, session, input.actor, "work-session-pr-linked", session, updated);
    return updated;
  });
  return result;
}

/** Mirror authoritative native GitHub PR state onto every attached session. */
export async function syncWorkSessionsFromPullRequest(
  db: DbClient,
  resource: {
    id: string;
    workspaceId: string;
    resourceType: string;
    state: string;
    metadata: unknown;
  },
): Promise<number> {
  if (resource.resourceType !== "PULL_REQUEST") return 0;
  const sessions = await db.workSession.findMany({
    where: { workspaceId: resource.workspaceId, pullRequestId: resource.id },
  });
  const derived = deriveWorkSessionPrStatus(resource);
  const meta = record(resource.metadata);
  const head = record(meta.head);
  let count = 0;
  for (const session of sessions) {
    if (DELIVERY_STATUSES.has(session.status) && derived !== WorkSessionStatus.MERGED) continue;
    const next = DELIVERY_STATUSES.has(session.status) ? session.status : derived;
    await db.workSession.update({
      where: { id: session.id },
      data: {
        status: next,
        headSha: typeof head.sha === "string" ? head.sha : session.headSha,
        lastHeartbeatAt: new Date(),
        staleAt: null,
        ...(derived === WorkSessionStatus.MERGED && !session.mergedAt
          ? {
              mergedAt: typeof meta.mergedAt === "string" ? new Date(meta.mergedAt) : new Date(),
            }
          : {}),
      },
    });
    count += 1;
  }
  return count;
}

export async function advanceWorkSession(
  db: PrismaClient,
  input: {
    workspaceId: string;
    sessionId: string;
    actor: WorkSessionActor;
    status: "RELEASED" | "DEPLOYED" | "VERIFIED" | "ABANDONED";
    releasedVersion?: string | null;
    deployedSha?: string | null;
  },
) {
  const result = await db.$transaction(async (tx) => {
    const session = await tx.workSession.findFirst({
      where: { id: input.sessionId, workspaceId: input.workspaceId },
    });
    if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Work session not found." });
    const next = WorkSessionStatus[input.status];
    if (next !== WorkSessionStatus.ABANDONED) {
      const allowed =
        (next === WorkSessionStatus.RELEASED && session.status === WorkSessionStatus.MERGED) ||
        (next === WorkSessionStatus.DEPLOYED && session.status === WorkSessionStatus.RELEASED) ||
        (next === WorkSessionStatus.VERIFIED && session.status === WorkSessionStatus.DEPLOYED);
      if (!allowed) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Cannot move ${session.status.toLowerCase()} work directly to ${input.status.toLowerCase()}.`,
        });
      }
    }
    const releasedVersion = input.releasedVersion?.trim();
    if (next === WorkSessionStatus.RELEASED && !releasedVersion) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "A release version is required before work can be marked released.",
      });
    }
    const deployedSha = input.deployedSha?.trim();
    if (next === WorkSessionStatus.DEPLOYED && !deployedSha) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "The exact deployed commit SHA is required before work can be marked deployed.",
      });
    }
    const now = new Date();
    const updated = await tx.workSession.update({
      where: { id: session.id },
      data: {
        status: next,
        lastHeartbeatAt: now,
        ...(next === WorkSessionStatus.RELEASED
          ? { releasedAt: now, releasedVersion }
          : {}),
        ...(next === WorkSessionStatus.DEPLOYED
          ? { deployedAt: now, deployedSha }
          : {}),
        ...(next === WorkSessionStatus.VERIFIED ? { verifiedAt: now, endedAt: now } : {}),
        ...(next === WorkSessionStatus.ABANDONED ? { endedAt: now } : {}),
      },
    });
    await auditSession(
      tx,
      session,
      input.actor,
      `work-session-${input.status.toLowerCase()}`,
      session,
      updated,
    );
    return updated;
  });
  if (input.status === "ABANDONED" || input.status === "VERIFIED") {
    await resolveStaleRequest(
      db,
      input.workspaceId,
      input.sessionId,
      input.status === "VERIFIED" ? "Deployment verified." : "Work session abandoned.",
    );
  }
  return result;
}

export async function sweepStaleWorkSessions(db: PrismaClient): Promise<number> {
  const workspaces = await db.workspace.findMany({
    where: { deletedAt: null, workSessionStaleMinutes: { gt: 0 } },
    select: { id: true, workSessionStaleMinutes: true },
  });
  let count = 0;
  for (const workspace of workspaces) {
    const cutoff = new Date(Date.now() - workspace.workSessionStaleMinutes * 60_000);
    const sessions = await db.workSession.findMany({
      where: {
        workspaceId: workspace.id,
        status: { in: [...STALEABLE_WORK_SESSION_STATUSES] },
        lastHeartbeatAt: { lt: cutoff },
      },
    });
    for (const session of sessions) {
      const markedStale = await db.$transaction(async (tx) => {
        const claimed = await tx.workSession.updateMany({
          where: {
            id: session.id,
            status: { in: [...STALEABLE_WORK_SESSION_STATUSES] },
            lastHeartbeatAt: { lt: cutoff },
          },
          data: { status: WorkSessionStatus.STALE, staleAt: new Date() },
        });
        if (claimed.count === 0) return null;
        const updated = await tx.workSession.findUniqueOrThrow({ where: { id: session.id } });
        await auditSession(tx, session, { userId: null }, "work-session-stale", session, updated);
        return updated;
      });
      if (!markedStale) continue;
      const issue = await db.issue.findUnique({
        where: { id: session.issueId },
        select: { authorId: true, workspace: { select: { key: true } }, number: true },
      });
      await createActionRequest(db, {
        workspaceId: workspace.id,
        actorId: null,
        title: `Work on ${issue ? `${issue.workspace.key}-${issue.number}` : "an issue"} went quiet`,
        body:
          `${session.repoFullName}:${session.branch} has not checked in for ` +
          `${workspace.workSessionStaleMinutes} minutes. Resume the existing session or abandon it before starting replacement work.`,
        severity: NotificationSeverity.WARNING,
        kind: ActionRequestKind.FREE_FORM,
        assignedUserId: markedStale.ownerUserId ?? issue?.authorId ?? null,
        assignedAgentId: markedStale.ownerAgentId,
        sourceType: "work-session",
        sourceId: session.id,
        dedupeKey: `work-session-stale:${session.id}`,
        issueId: session.issueId,
      });
      count += 1;
    }
  }
  return count;
}
