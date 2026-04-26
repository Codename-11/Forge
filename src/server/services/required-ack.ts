import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { EventKind } from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { recordChange } from "@/server/audit";
import { maybeAutoDispatch } from "@/server/services/dispatcher";
import { coachOnEvent } from "@/server/services/ai-coach";

/**
 * Required-ack watchdog (P1 layer 2 of task follow-through).
 *
 * Push-dispatch lands an `AGENT_ASSIGNED` webhook on the agent and Hermes
 * returns 202 immediately. We want a stronger signal that the agent
 * actually picked up the work — either a comment from the agent on the
 * issue, or any status transition out of BACKLOG/TODO. If neither
 * happens within `Workspace.requiredAckSeconds`, we treat the wake as
 * missed: emit `AGENT_NOACK` and (optionally) clear `assignedAgentId`
 * so the auto-dispatcher re-picks.
 *
 * Scheduled per AGENT_ASSIGNED delivery by `worker.ts` as a delayed
 * BullMQ job; this function runs the actual check.
 */

export interface RequiredAckCheckResult {
  acked: boolean;
  ackKind?: "comment" | "status_change";
  ackedAt?: Date;
  redispatched: boolean;
}

export async function checkRequiredAck(
  input: { agentAssignedEventId: string },
  client: PrismaClient | Prisma.TransactionClient = db,
): Promise<RequiredAckCheckResult> {
  const event = await client.activityEvent.findUnique({
    where: { id: input.agentAssignedEventId },
    select: {
      id: true,
      kind: true,
      workspaceId: true,
      subjectType: true,
      subjectId: true,
      payload: true,
      createdAt: true,
    },
  });
  if (!event) return { acked: true, redispatched: false };
  if (event.kind !== EventKind.AGENT_ASSIGNED || event.subjectType !== "issue") {
    return { acked: true, redispatched: false };
  }

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const agentId =
    typeof payload.agentId === "string" ? (payload.agentId as string) : null;
  const agentProfileKey =
    typeof payload.agentProfileKey === "string"
      ? (payload.agentProfileKey as string)
      : null;

  const issueId = event.subjectId;

  // Idempotency — once we've already fired AGENT_NOACK for this delivery,
  // a re-run is a no-op. The originalAssignedEventId scopes the search so
  // independent deliveries on the same issue don't collide.
  const existing = await client.activityEvent.findFirst({
    where: {
      workspaceId: event.workspaceId,
      kind: EventKind.AGENT_NOACK,
      subjectType: "issue",
      subjectId: issueId,
      payload: {
        path: ["originalAssignedEventId"],
        equals: event.id,
      } as Prisma.JsonFilter,
    },
    select: { id: true },
  });
  if (existing) return { acked: false, redispatched: false };

  const workspace = await client.workspace.findUnique({
    where: { id: event.workspaceId },
    select: { requiredAckSeconds: true, autoRedispatchOnNoack: true },
  });
  if (!workspace) return { acked: true, redispatched: false };
  if (workspace.requiredAckSeconds <= 0) {
    return { acked: true, redispatched: false };
  }

  const since = event.createdAt;

  // Comment from this specific agent counts. We look for a COMMENT_CREATED
  // event whose Comment row carries `authoringAgentId === agentId`. The
  // join via Comment lets us filter on the persistent agent attribution
  // instead of trusting payload shape.
  const ackComment = agentId
    ? await client.activityEvent.findFirst({
        where: {
          workspaceId: event.workspaceId,
          kind: EventKind.COMMENT_CREATED,
          subjectType: "issue",
          subjectId: issueId,
          createdAt: { gt: since },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, createdAt: true, payload: true, subjectId: true },
      })
    : null;

  let ackedByComment = false;
  let ackAt: Date | null = null;
  if (ackComment && agentId) {
    // The COMMENT_CREATED event's subjectId is the issueId; we still need
    // the Comment row to read authoringAgentId. Fall back to payload if
    // for some reason the event isn't pointing at a real Comment.
    const cp = (ackComment.payload ?? {}) as Record<string, unknown>;
    const commentId =
      typeof cp.commentId === "string" ? (cp.commentId as string) : null;
    if (commentId) {
      const c = await client.comment.findUnique({
        where: { id: commentId },
        select: { authoringAgentId: true, createdAt: true },
      });
      if (c?.authoringAgentId === agentId) {
        ackedByComment = true;
        ackAt = c.createdAt;
      }
    }
  }

  let ackedByStatus = false;
  if (!ackedByComment) {
    const statusEvt = await client.activityEvent.findFirst({
      where: {
        workspaceId: event.workspaceId,
        kind: EventKind.ISSUE_STATUS_CHANGED,
        subjectType: "issue",
        subjectId: issueId,
        createdAt: { gt: since },
        actorId: { not: null },
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    if (statusEvt) {
      ackedByStatus = true;
      ackAt = statusEvt.createdAt;
    }
  }

  if (ackedByComment || ackedByStatus) {
    return {
      acked: true,
      ackKind: ackedByComment ? "comment" : "status_change",
      ackedAt: ackAt ?? undefined,
      redispatched: false,
    };
  }

  // No ack — emit AGENT_NOACK and (optionally) clear the assignment.
  let redispatched = false;
  try {
    const issue = await client.issue.findUnique({
      where: { id: issueId },
      select: { assignedAgentId: true },
    });
    const before = { assignedAgentId: issue?.assignedAgentId ?? null };
    const after = workspace.autoRedispatchOnNoack
      ? { assignedAgentId: null }
      : before;

    await recordChange(client, {
      workspaceId: event.workspaceId,
      actorId: null,
      entity: "Issue",
      entityId: issueId,
      action: "noack",
      before,
      after,
      eventKind: EventKind.AGENT_NOACK,
      subjectType: "issue",
      subjectId: issueId,
      payload: {
        agentId,
        agentProfileKey,
        requiredAckSeconds: workspace.requiredAckSeconds,
        originalAssignedEventId: event.id,
      },
    });

    void coachOnEvent(client, {
      workspaceId: event.workspaceId,
      issueId,
      eventKind: "AGENT_NOACK",
    });

    if (workspace.autoRedispatchOnNoack && issue?.assignedAgentId) {
      await client.issue.update({
        where: { id: issueId },
        data: { assignedAgentId: null },
      });
      redispatched = true;
      // Best-effort re-pick. Same caveat as stale-work: dispatcher
      // short-circuits when auto-dispatch is off / the issue isn't
      // queued — operators can hand-route from there.
      await maybeAutoDispatch(client, issueId);
    }
  } catch (err) {
    logger.warn(
      { err, issueId, workspaceId: event.workspaceId },
      "required-ack: noack emit failed",
    );
  }

  return { acked: false, redispatched };
}
