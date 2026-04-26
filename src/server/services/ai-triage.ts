import "server-only";
import { AiTriageStatus, AgentRole } from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { runTriage } from "@/server/services/ai";

/**
 * Background-runnable triage routine. Loads the issue + workspace context,
 * calls the AI service, persists the suggestion. Always idempotent: a
 * second run for the same issue is a no-op once `aiTriageStatus` is
 * non-null and not `PENDING`.
 *
 * Caller is responsible for fire-and-forget — this function never throws
 * out (it logs and writes ERROR status on failure).
 */
export async function triageIssue(issueId: string): Promise<void> {
  try {
    const issue = await db.issue.findUnique({
      where: { id: issueId },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        description: true,
        aiTriageStatus: true,
        workspace: {
          select: {
            aiEnabled: true,
            aiTriageOnCreate: true,
            aiProvider: true,
            aiModel: true,
          },
        },
      },
    });
    if (!issue) return;
    if (!issue.workspace.aiEnabled || !issue.workspace.aiTriageOnCreate) return;
    // Idempotent: if we already ran (or someone is running concurrently),
    // skip. PENDING means a sibling call is in flight.
    if (issue.aiTriageStatus !== null) return;

    await db.issue.update({
      where: { id: issueId },
      data: { aiTriageStatus: AiTriageStatus.PENDING },
    });

    const [labels, agents, recent] = await Promise.all([
      db.label.findMany({
        where: { workspaceId: issue.workspaceId },
        select: { id: true, name: true, color: true },
        orderBy: { name: "asc" },
      }),
      db.agent.findMany({
        where: {
          workspaceId: issue.workspaceId,
          archivedAt: null,
          role: AgentRole.WORKER,
        },
        select: {
          id: true,
          profileKey: true,
          name: true,
          capabilities: true,
        },
      }),
      db.issue.findMany({
        where: {
          workspaceId: issue.workspaceId,
          deletedAt: null,
          id: { not: issueId },
        },
        select: { title: true },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
    ]);

    const suggestion = await runTriage({
      title: issue.title,
      description: issue.description,
      workspaceLabels: labels,
      agents,
      recentTitles: recent.map((r) => r.title),
      provider: issue.workspace.aiProvider,
      model: issue.workspace.aiModel,
    });

    if (!suggestion) {
      await db.issue.update({
        where: { id: issueId },
        data: {
          aiTriageStatus: AiTriageStatus.ERROR,
          aiTriagedAt: new Date(),
        },
      });
      return;
    }

    await db.issue.update({
      where: { id: issueId },
      data: {
        aiTriageStatus: AiTriageStatus.READY,
        aiSuggestedPriority: suggestion.priority,
        aiSuggestedLabelIds: suggestion.labelIds,
        aiSuggestedAgentId: suggestion.agentId,
        aiTriageReasoning: suggestion.reasoning,
        aiTriagedAt: new Date(),
      },
    });
  } catch (err) {
    logger.warn({ err, issueId }, "ai-triage: unexpected failure");
    await db.issue
      .update({
        where: { id: issueId },
        data: {
          aiTriageStatus: AiTriageStatus.ERROR,
          aiTriagedAt: new Date(),
        },
      })
      .catch(() => undefined);
  }
}
