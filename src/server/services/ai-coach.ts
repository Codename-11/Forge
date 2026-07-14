import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { AgentRole, EventKind } from "@prisma/client";
import { logger } from "@/server/logger";
import { runCoachComment } from "@/server/services/ai";
import { resolveWorkspaceProviderClient } from "@/server/services/ai-providers";
import { recordChange } from "@/server/audit";

/**
 * Coach service. Hooks into the three task-follow-through events
 * (ISSUE_STALLED, AGENT_NOACK, ISSUE_SLA_BREACH) and posts a short
 * diagnostic comment when:
 *   - the workspace has aiEnabled = true AND aiCoachEnabled = true
 *   - a COACH-role agent exists for the workspace
 *   - the selected workspace provider is available via a stored credential
 *     or environment fallback
 *
 * Failures are swallowed and logged. The Coach is decorative — never
 * blocks the underlying event flow.
 */

type CoachKind = "ISSUE_STALLED" | "AGENT_NOACK" | "ISSUE_SLA_BREACH";

export async function coachOnEvent(
  client: PrismaClient | Prisma.TransactionClient,
  params: {
    workspaceId: string;
    issueId: string;
    eventKind: CoachKind;
  },
): Promise<void> {
  try {
    const ws = await client.workspace.findUnique({
      where: { id: params.workspaceId },
      select: {
        aiEnabled: true,
        aiCoachEnabled: true,
        aiProvider: true,
        aiModel: true,
      },
    });
    if (!ws?.aiEnabled || !ws.aiCoachEnabled) return;

    const coach = await client.agent.findFirst({
      where: {
        workspaceId: params.workspaceId,
        role: AgentRole.COACH,
        archivedAt: null,
      },
      select: { id: true, profileKey: true, name: true },
    });
    if (!coach) return;

    // Dedup: don't re-coach the same issue within a day. The trigger sweeps
    // can re-emit ISSUE_STALLED for an issue that's still stalled, which used
    // to spam one issue with multiple comments (AXI-84 got 4 in 4 hours).
    // Checked before the LLM call so we don't burn tokens either.
    const dedupSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const alreadyCoached = await client.comment.findFirst({
      where: {
        issueId: params.issueId,
        authoringAgentId: coach.id,
        createdAt: { gte: dedupSince },
      },
      select: { id: true },
    });
    if (alreadyCoached) return;

    const issue = await client.issue.findUnique({
      where: { id: params.issueId },
      select: {
        id: true,
        number: true,
        title: true,
        description: true,
        priority: true,
        createdAt: true,
        updatedAt: true,
        status: { select: { name: true } },
        labels: { select: { label: { select: { name: true } } } },
        assignedAgent: { select: { profileKey: true, name: true } },
        comments: {
          select: { body: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
    });
    if (!issue) return;

    const recentCommentBodies = issue.comments
      .slice()
      .reverse()
      .map((c) => c.body);

    const providerClient = await resolveWorkspaceProviderClient(
      client,
      params.workspaceId,
      ws.aiProvider,
    );
    if (!providerClient) return;

    const body = await runCoachComment(providerClient, {
      eventKind: params.eventKind,
      issue: {
        id: issue.id,
        number: issue.number,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        statusName: issue.status.name,
        labels: issue.labels.map((l) => l.label.name),
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      },
      agent: issue.assignedAgent,
      recentCommentBodies,
      provider: ws.aiProvider,
      model: ws.aiModel,
    });
    if (!body) return;

    // We need a User to satisfy Comment.authorId NOT NULL — find any owner
    // of the workspace as the system actor. Coach attribution is via
    // authoringAgentId; authorId just keeps the FK valid.
    const ownerMembership = await client.membership.findFirst({
      where: { workspaceId: params.workspaceId, role: "OWNER" },
      select: { userId: true },
    });
    const fallbackUser =
      ownerMembership ??
      (await client.membership.findFirst({
        where: { workspaceId: params.workspaceId },
        select: { userId: true },
      }));
    if (!fallbackUser) {
      logger.warn(
        { workspaceId: params.workspaceId },
        "ai-coach: no membership found for comment authorship",
      );
      return;
    }

    const comment = await client.comment.create({
      data: {
        workspaceId: params.workspaceId,
        issueId: issue.id,
        authorId: fallbackUser.userId,
        authoringAgentId: coach.id,
        body,
      },
    });

    await recordChange(client, {
      workspaceId: params.workspaceId,
      actorId: null,
      actorAgentId: coach.id,
      entity: "Comment",
      entityId: comment.id,
      action: "ai-coach",
      after: { issueId: issue.id, authoringAgentId: coach.id },
      eventKind: EventKind.COMMENT_CREATED,
      subjectType: "issue",
      subjectId: issue.id,
      payload: {
        commentId: comment.id,
        agentId: coach.id,
        authoringAgentId: coach.id,
        coachEvent: params.eventKind,
      },
    });
  } catch (err) {
    logger.warn({ err, ...params }, "ai-coach: failure (swallowed)");
  }
}
