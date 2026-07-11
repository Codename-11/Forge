import "server-only";
import { EventKind, type PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { recordChange } from "@/server/audit";
import { extractMentions } from "@/server/services/mentions";
import { materializeStepAsIssueTx } from "@/server/services/execution-step-issue-service";

export async function listExecutionStepComments(
  db: PrismaClient,
  params: { workspaceId: string; stepId: string },
) {
  const step = await db.executionStep.findFirst({
    where: { id: params.stepId, workspaceId: params.workspaceId },
    select: { id: true },
  });
  if (!step) throw new TRPCError({ code: "NOT_FOUND", message: "Execution step not found." });
  return db.comment.findMany({
    where: {
      workspaceId: params.workspaceId,
      executionStepId: params.stepId,
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
    include: {
      author: { select: { id: true, name: true, image: true } },
      authoringAgent: {
        select: { id: true, name: true, profileKey: true, avatar: true },
      },
    },
  });
}

export async function createExecutionStepComment(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    actorAgentId?: string | null;
    stepId: string;
    body: string;
    ip?: string | null;
    userAgent?: string | null;
  },
) {
  const step = await db.executionStep.findFirst({
    where: { id: params.stepId, workspaceId: params.workspaceId },
    select: { id: true, planId: true, issueId: true },
  });
  if (!step) throw new TRPCError({ code: "NOT_FOUND", message: "Execution step not found." });

  return db.$transaction(async (tx) => {
    const tokens = extractMentions(params.body);
    const matches = tokens.length
      ? await tx.agent.findMany({
          where: {
            workspaceId: params.workspaceId,
            profileKey: { in: tokens },
            archivedAt: null,
          },
          select: { id: true, profileKey: true },
        })
      : [];
    const mentions = matches.map((agent) => ({
      agentId: agent.id,
      profileKey: agent.profileKey,
    }));

    // Agent work is issue-backed in Forge. An explicit step @mention is an
    // intentional handoff, so materialize a pure orchestration step before
    // opening canonical work for the mentioned agent.
    let issueId = step.issueId;
    if (mentions.length > 0 && !issueId) {
      const materialized = await materializeStepAsIssueTx(tx, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        actorAgentId: params.actorAgentId ?? null,
        stepId: step.id,
      });
      issueId = materialized.issueId;
    }

    const comment = await tx.comment.create({
      data: {
        workspaceId: params.workspaceId,
        executionStepId: step.id,
        authorId: params.actorAgentId ? null : params.actorId,
        authoringAgentId: params.actorAgentId ?? null,
        body: params.body,
      },
      include: {
        author: { select: { id: true, name: true, image: true } },
        authoringAgent: {
          select: { id: true, name: true, profileKey: true, avatar: true },
        },
      },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      actorAgentId: params.actorAgentId ?? null,
      entity: "Comment",
      entityId: comment.id,
      action: "create",
      after: comment,
      eventKind: EventKind.COMMENT_CREATED,
      subjectType: "execution-step",
      subjectId: step.id,
      payload: {
        commentId: comment.id,
        executionStepId: step.id,
        planId: step.planId,
        issueId,
        body: params.body,
        preview: params.body.slice(0, 120),
        mentions,
      },
      ip: params.ip,
      userAgent: params.userAgent,
    });
    return comment;
  });
}
