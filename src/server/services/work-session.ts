import "server-only";

import {
  ActionRequestKind,
  ActionRequestStatus,
  CommentKind,
  DeliveryTimelinePolicy,
  EventKind,
  NotificationSeverity,
  WorkSessionStatus,
} from "@prisma/client";
import type { Prisma, PrismaClient, WorkSessionSource } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { recordChange } from "@/server/audit";
import { createActionRequest } from "@/server/services/action-request-service";
import { autoWatchActor } from "@/server/services/issue-watchers";
import { finishRun } from "@/server/services/agent-run";
import { IMPLEMENTATION_LINK_KINDS } from "@/server/services/github/types";

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
  connectionId?: string | null;
};

export type DeliveryTimelineUpdate = {
  body: string;
};

async function resolveRecoveryRequests(
  db: DbClient,
  workspaceId: string,
  sessionId: string,
  resolution: string,
) {
  await db.actionRequest.updateMany({
    where: {
      workspaceId,
      dedupeKey: {
        in: [`work-session-stale:${sessionId}`, `work-session-mcp-quiet:${sessionId}`],
      },
      status: ActionRequestStatus.OPEN,
    },
    data: {
      status: ActionRequestStatus.RESOLVED,
      resolvedAt: new Date(),
      resolution,
    },
  });
}

/**
 * Any authenticated signal from an MCP connection renews its observation
 * lease. Clear delivery recovery asks for sessions that connection still owns,
 * even when the signal was a generic MCP ping/tool call rather than an explicit
 * workSessions heartbeat.
 */
export async function resolveMcpQuietRequestsForConnection(
  db: PrismaClient,
  workspaceId: string,
  connectionId: string,
  resolution = "MCP connection resumed.",
) {
  const sessions = await db.workSession.findMany({
    where: {
      workspaceId,
      ownerConnectionId: connectionId,
      endedAt: null,
      status: { in: [...ACTIVE_WORK_SESSION_STATUSES] },
    },
    select: { id: true },
  });
  if (sessions.length === 0) return 0;
  const now = new Date();
  const result = await db.actionRequest.updateMany({
    where: {
      workspaceId,
      status: ActionRequestStatus.OPEN,
      dedupeKey: {
        in: sessions.map((session) => `work-session-mcp-quiet:${session.id}`),
      },
    },
    data: {
      status: ActionRequestStatus.RESOLVED,
      resolvedAt: now,
      resolution,
    },
  });
  return result.count;
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

/**
 * A merged implementation PR is authoritative evidence that the implementation
 * attempt has ended. MCP clients are not guaranteed to call `runs.complete`
 * after GitHub merges, so reconcile live EXECUTE runs at this delivery
 * boundary. Runs opened after the merge are deliberately excluded: those may
 * represent release/deploy work and have their own lifecycle.
 */
async function reconcileMergedImplementationRuns(
  db: DbClient,
  input: { workspaceId: string; issueId: string; mergedAt: Date },
): Promise<number> {
  const runs = await db.agentRun.findMany({
    where: {
      workspaceId: input.workspaceId,
      issueId: input.issueId,
      status: { in: ["ACTIVE", "WAITING"] },
      engagementMode: "EXECUTE",
      startedAt: { lte: input.mergedAt },
    },
    select: { id: true, agentId: true },
  });
  let completed = 0;
  for (const run of runs) {
    const result = await finishRun(db, {
      runId: run.id,
      workspaceId: input.workspaceId,
      issueId: input.issueId,
      agentId: run.agentId,
      status: "COMPLETED",
      summary: "Implementation completed when the linked pull request merged.",
    });
    if (result?.status === "COMPLETED") completed += 1;
  }
  return completed;
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
      // A concrete endpoint is the delivery lease owner. Two runtimes/MCP
      // clients bound to the same Agent are distinct and must explicitly hand
      // off instead of silently sharing primary execution authority.
      const exactConnectionOwner = Boolean(
        active.ownerConnectionId &&
        input.actor.connectionId &&
        active.ownerConnectionId === input.actor.connectionId,
      );
      // Legacy FORGE_AGENT sessions predate connection ownership. The first
      // concrete connection for the already-linked logical agent may resume
      // and atomically adopt that lease; a different agent still conflicts.
      const resumableLegacyAgentOwner = Boolean(
        !active.ownerConnectionId &&
        input.actor.connectionId &&
        input.actor.agentId &&
        active.ownerAgentId === input.actor.agentId,
      );
      if (resumableLegacyAgentOwner) {
        const actorConnection = await tx.agentConnection.findFirst({
          where: {
            id: input.actor.connectionId!,
            workspaceId: input.workspaceId,
            agentId: input.actor.agentId!,
            revokedAt: null,
          },
          select: { id: true },
        });
        if (!actorConnection) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "The connection does not belong to the work-session agent.",
          });
        }
      }
      const connectionScoped = Boolean(active.ownerConnectionId || input.actor.connectionId);
      const sameOwner = connectionScoped
        ? exactConnectionOwner || resumableLegacyAgentOwner
        : input.actor.agentId
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
            ...(resumableLegacyAgentOwner
              ? {
                  ownerConnectionId: input.actor.connectionId,
                  participants: {
                    upsert: {
                      where: {
                        workSessionId_connectionId: {
                          workSessionId: active.id,
                          connectionId: input.actor.connectionId!,
                        },
                      },
                      create: {
                        workspaceId: input.workspaceId,
                        agentId: input.actor.agentId!,
                        connectionId: input.actor.connectionId!,
                        role: "PRIMARY",
                      },
                      update: {
                        agentId: input.actor.agentId!,
                        role: "PRIMARY",
                        leftAt: null,
                      },
                    },
                  },
                }
              : {}),
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
        ownerConnectionId: input.actor.connectionId ?? null,
        source: input.source,
        status: WorkSessionStatus.CLAIMED,
        repoFullName: input.repoFullName,
        branch: input.branch,
        baseBranch: input.baseBranch || "main",
        worktreePath: input.worktreePath ?? null,
        ...(input.actor.connectionId && input.actor.agentId
          ? {
              participants: {
                create: {
                  workspaceId: input.workspaceId,
                  agentId: input.actor.agentId,
                  connectionId: input.actor.connectionId,
                  role: "PRIMARY",
                },
              },
            }
          : {}),
      },
    });
    await auditSession(tx, created, input.actor, "work-session-claimed", undefined, created);
    return created;
  });
  await resolveRecoveryRequests(db, input.workspaceId, result.id, "Work session resumed.");
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
      ownerConnection: {
        select: {
          id: true,
          kind: true,
          livenessModel: true,
          status: true,
          confidence: true,
          displayName: true,
          clientName: true,
          clientVersion: true,
          lastSeenAt: true,
          disconnectedAt: true,
          agent: { select: { id: true, name: true, profileKey: true } },
          runtime: { select: { id: true, name: true } },
        },
      },
      participants: {
        where: { leftAt: null },
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
        select: {
          id: true,
          role: true,
          joinedAt: true,
          agent: { select: { id: true, name: true, profileKey: true, avatar: true } },
          connection: {
            select: {
              id: true,
              kind: true,
              status: true,
              confidence: true,
              displayName: true,
              clientName: true,
              lastSeenAt: true,
            },
          },
        },
      },
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
  const latestImplementationRun = await db.agentRun.findFirst({
    where: {
      workspaceId,
      issueId,
      engagementMode: "EXECUTE",
      outputStartedAt: { not: null },
    },
    orderBy: [{ lastEventAt: "desc" }, { startedAt: "desc" }],
    select: {
      id: true,
      status: true,
      startedAt: true,
      lastEventAt: true,
      externalRunId: true,
      triggerKind: true,
      runEngine: true,
      runEngineSource: true,
      runtimePolicy: true,
      agent: { select: { id: true, name: true, profileKey: true, avatar: true } },
      connection: {
        select: {
          id: true,
          kind: true,
          displayName: true,
          clientName: true,
          clientVersion: true,
          runtime: { select: { id: true, name: true, adapterKey: true } },
        },
      },
    },
  });
  const observedImplementation = latestImplementationRun
    ? {
        agent: latestImplementationRun.agent,
        observedAt: latestImplementationRun.lastEventAt,
        source: "implementation-run" as const,
        run: {
          id: latestImplementationRun.id,
          status: latestImplementationRun.status,
          startedAt: latestImplementationRun.startedAt,
          externalRunId: latestImplementationRun.externalRunId,
          triggerKind: latestImplementationRun.triggerKind,
          runEngine: latestImplementationRun.runEngine,
          runEngineSource: latestImplementationRun.runEngineSource,
          runtimePolicy: latestImplementationRun.runtimePolicy,
          connection: latestImplementationRun.connection,
        },
      }
    : null;

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
        kind: { in: [...IMPLEMENTATION_LINK_KINDS] },
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
  return sessions.map((session) => ({ ...session, observedImplementation }));
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
  await resolveRecoveryRequests(db, input.workspaceId, session.id, "Work session resumed.");
  return updated;
}

export async function attachPullRequest(
  db: PrismaClient,
  input: {
    workspaceId: string;
    sessionId: string;
    externalResourceId: string;
    actor: WorkSessionActor;
    timelineUpdate?: DeliveryTimelineUpdate;
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
    const workspace = await tx.workspace.findUniqueOrThrow({
      where: { id: input.workspaceId },
      select: { deliveryTimelinePolicy: true },
    });
    const head = record(record(resource.metadata).head);
    if (typeof head.ref === "string" && head.ref !== session.branch) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `PR branch ${head.ref} does not match work session branch ${session.branch}.`,
      });
    }
    const firstAttachment = session.pullRequestId !== resource.id;
    let timelineBody = input.timelineUpdate?.body.trim() || null;
    if (
      firstAttachment &&
      workspace.deliveryTimelinePolicy === DeliveryTimelinePolicy.REQUIRE_ON_PR &&
      !timelineBody
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "This workspace requires a human-readable timelineUpdate when attaching a pull request.",
      });
    }
    if (
      firstAttachment &&
      workspace.deliveryTimelinePolicy === DeliveryTimelinePolicy.AUTO_ON_PR &&
      !timelineBody
    ) {
      const base = record(record(resource.metadata).base);
      const draft = record(resource.metadata).draft === true || resource.state === "draft";
      timelineBody =
        `Opened [${draft ? "draft " : ""}PR #${resource.number ?? "—"}: ${resource.title ?? "Implementation"}](${resource.url}) for this work session.\n\n` +
        `Branch \`${session.branch}\` targets \`${typeof base.ref === "string" ? base.ref : session.baseBranch}\`. CI and review remain authoritative in GitHub.`;
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
    let timelineCommentId: string | null = null;
    if (firstAttachment && timelineBody) {
      const issue = await tx.issue.findFirstOrThrow({
        where: { id: session.issueId, workspaceId: input.workspaceId, deletedAt: null },
        select: { id: true, number: true, title: true, workspace: { select: { key: true } } },
      });
      const comment = await tx.comment.create({
        data: {
          workspaceId: input.workspaceId,
          issueId: issue.id,
          authorId: input.actor.userId,
          authoringAgentId: input.actor.agentId ?? null,
          body: timelineBody,
          kind: CommentKind.BODY,
        },
      });
      timelineCommentId = comment.id;
      await autoWatchActor(tx, {
        workspaceId: input.workspaceId,
        issueId: issue.id,
        userId: input.actor.userId,
        callerAgentId: input.actor.agentId ?? null,
      });
      await recordChange(tx, {
        workspaceId: input.workspaceId,
        actorId: input.actor.userId,
        actorAgentId: input.actor.agentId ?? null,
        entity: "Comment",
        entityId: comment.id,
        action: "create-delivery-update",
        after: comment,
        eventKind: EventKind.COMMENT_CREATED,
        subjectType: "issue",
        subjectId: issue.id,
        payload: {
          commentId: comment.id,
          issueId: issue.id,
          issuePrefix: `${issue.workspace.key}-${issue.number}`,
          number: issue.number,
          title: issue.title,
          preview: timelineBody.slice(0, 120),
          workSessionId: session.id,
          externalResourceId: resource.id,
          mentions: { agentIds: [], userIds: [], agents: [] },
          mentionsCount: 0,
          agentRequests: [],
        },
      });
    }
    await auditSession(tx, session, input.actor, "work-session-pr-linked", session, updated);
    const shouldRecommend =
      firstAttachment &&
      !timelineCommentId &&
      workspace.deliveryTimelinePolicy === DeliveryTimelinePolicy.RECOMMEND;
    return {
      ...updated,
      timeline: {
        policy: workspace.deliveryTimelinePolicy,
        commentId: timelineCommentId,
        recommended: shouldRecommend,
        nextAction: shouldRecommend ? "comments.create" : null,
        issueId: session.issueId,
        suggestedComment: shouldRecommend
          ? `Implemented work for this issue and opened [PR #${resource.number ?? "—"}: ${resource.title ?? "Implementation"}](${resource.url}).\n\nValidation: _add checks run and any caveats_.`
          : null,
      },
    };
  });
  if (result.status === WorkSessionStatus.MERGED && result.mergedAt) {
    await reconcileMergedImplementationRuns(db, {
      workspaceId: input.workspaceId,
      issueId: result.issueId,
      mergedAt: result.mergedAt,
    });
    await resolveRecoveryRequests(
      db,
      input.workspaceId,
      result.id,
      "Implementation pull request merged.",
    );
  }
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
    if (derived === WorkSessionStatus.MERGED) {
      const mergedAt =
        typeof meta.mergedAt === "string"
          ? new Date(meta.mergedAt)
          : (session.mergedAt ?? new Date());
      await reconcileMergedImplementationRuns(db, {
        workspaceId: resource.workspaceId,
        issueId: session.issueId,
        mergedAt,
      });
      await resolveRecoveryRequests(
        db,
        resource.workspaceId,
        session.id,
        "Implementation pull request merged.",
      );
    }
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
        ...(next === WorkSessionStatus.RELEASED ? { releasedAt: now, releasedVersion } : {}),
        ...(next === WorkSessionStatus.DEPLOYED ? { deployedAt: now, deployedSha } : {}),
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
    await resolveRecoveryRequests(
      db,
      input.workspaceId,
      input.sessionId,
      input.status === "VERIFIED" ? "Deployment verified." : "Work session abandoned.",
    );
  }
  return result;
}

export async function sweepStaleWorkSessions(db: PrismaClient): Promise<number> {
  // Repair requests created before merge-time cleanup was introduced. Query
  // from the small open-request set rather than scanning delivery history on
  // every worker tick.
  const openRecoveryRequests = await db.actionRequest.findMany({
    where: {
      status: ActionRequestStatus.OPEN,
      sourceType: "work-session",
      OR: [
        { dedupeKey: { startsWith: "work-session-stale:" } },
        { dedupeKey: { startsWith: "work-session-mcp-quiet:" } },
      ],
    },
    select: { workspaceId: true, sourceId: true },
  });
  const recoverySessionIds = [
    ...new Set(
      openRecoveryRequests
        .map((request) => request.sourceId)
        .filter((sourceId): sourceId is string => Boolean(sourceId)),
    ),
  ];
  if (recoverySessionIds.length > 0) {
    const deliveredSessions = await db.workSession.findMany({
      where: {
        id: { in: recoverySessionIds },
        status: { in: ["MERGED", "RELEASED", "DEPLOYED", "VERIFIED", "ABANDONED"] },
      },
      select: { id: true, workspaceId: true, status: true },
    });
    for (const session of deliveredSessions) {
      await resolveRecoveryRequests(
        db,
        session.workspaceId,
        session.id,
        session.status === WorkSessionStatus.ABANDONED
          ? "Work session abandoned."
          : "Implementation pull request merged.",
      );
    }
  }

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
      include: { ownerConnection: { select: { id: true, kind: true, status: true } } },
    });
    for (const session of sessions) {
      if (session.ownerConnection?.kind === "MCP_CLIENT") {
        // MCP silence is an expired observation lease, not proof that the
        // client process failed. Keep delivery ownership intact so the
        // dispatcher cannot start a competing branch while status is unknown.
        // Always materialize the idempotent action request, even when the run
        // watchdog already changed the shared connection to QUIET first.
        await db.agentConnection.updateMany({
          where: { id: session.ownerConnection.id, status: "ACTIVE" },
          data: { status: "QUIET", confidence: "UNCONFIRMED" },
        });
        const issue = await db.issue.findUnique({
          where: { id: session.issueId },
          select: { authorId: true, workspace: { select: { key: true } }, number: true },
        });
        await createActionRequest(db, {
          workspaceId: workspace.id,
          actorId: null,
          title: `MCP status for ${issue ? `${issue.workspace.key}-${issue.number}` : "an issue"} is unconfirmed`,
          body:
            `${session.repoFullName}:${session.branch} has not sent a lifecycle signal for ` +
            `${workspace.workSessionStaleMinutes} minutes. Delivery remains owned; request status, hand off, or abandon it explicitly.`,
          severity: NotificationSeverity.WARNING,
          kind: ActionRequestKind.FREE_FORM,
          assignedUserId: session.ownerUserId ?? issue?.authorId ?? null,
          assignedAgentId: session.ownerAgentId,
          sourceType: "work-session",
          sourceId: session.id,
          dedupeKey: `work-session-mcp-quiet:${session.id}`,
          issueId: session.issueId,
        });
        continue;
      }
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
