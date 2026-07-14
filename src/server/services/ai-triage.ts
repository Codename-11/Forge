import "server-only";
import { AiTriageStatus, AgentRole } from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { runTriage } from "@/server/services/ai";
import { resolveWorkspaceProviderClient } from "@/server/services/ai-providers";

/**
 * Background-runnable triage routine. Loads the issue + workspace context,
 * calls the AI service, persists the suggestion. Always idempotent: a
 * second run for the same issue is a no-op once `aiTriageStatus` is non-null.
 *
 * Caller is responsible for fire-and-forget — this function never throws
 * out (it logs and writes ERROR status on failure).
 */
export async function triageIssue(issueId: string): Promise<void> {
  let claimStartedAt: Date | null = null;
  try {
    const issue = await db.issue.findUnique({
      where: { id: issueId },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        description: true,
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
    // Atomic claim: two create/rerun workers can observe the same null state,
    // but only one is allowed to transition it to PENDING and call the model.
    claimStartedAt = new Date();
    const claimed = await db.issue.updateMany({
      where: { id: issueId, aiTriageStatus: null },
      data: {
        aiTriageStatus: AiTriageStatus.PENDING,
        aiTriagedAt: claimStartedAt,
      },
    });
    if (claimed.count === 0) {
      claimStartedAt = null;
      return;
    }

    const providerClient = await resolveWorkspaceProviderClient(
      db,
      issue.workspaceId,
      issue.workspace.aiProvider,
    );
    if (!providerClient) {
      await db.issue.updateMany({
        where: {
          id: issueId,
          aiTriageStatus: AiTriageStatus.PENDING,
          aiTriagedAt: claimStartedAt,
        },
        data: {
          aiTriageStatus: AiTriageStatus.ERROR,
          aiTriageReasoning: `The “${issue.workspace.aiProvider ?? "hermes"}” AI provider isn't configured for this workspace. Set it up in Settings → Workspace → AI.`,
          aiTriagedAt: new Date(),
        },
      });
      return;
    }

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

    const suggestion = await runTriage(providerClient, {
      title: issue.title,
      description: issue.description,
      workspaceLabels: labels,
      agents,
      recentTitles: recent.map((r) => r.title),
      provider: issue.workspace.aiProvider,
      model: issue.workspace.aiModel,
    });

    if (!suggestion) {
      await db.issue.updateMany({
        where: {
          id: issueId,
          aiTriageStatus: AiTriageStatus.PENDING,
          aiTriagedAt: claimStartedAt,
        },
        data: {
          aiTriageStatus: AiTriageStatus.ERROR,
          aiTriageReasoning:
            "The model didn't return a usable triage suggestion. Try Re-run, or switch the AI provider/model in Settings → Workspace → AI.",
          aiTriagedAt: new Date(),
        },
      });
      return;
    }

    await db.issue.updateMany({
      where: {
        id: issueId,
        aiTriageStatus: AiTriageStatus.PENDING,
        aiTriagedAt: claimStartedAt,
      },
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
    if (!claimStartedAt) return;
    await db.issue
      .updateMany({
        where: {
          id: issueId,
          aiTriageStatus: AiTriageStatus.PENDING,
          aiTriagedAt: claimStartedAt,
        },
        data: {
          aiTriageStatus: AiTriageStatus.ERROR,
          aiTriageReasoning:
            "Triage failed unexpectedly. Try Re-run, or check the AI provider in Settings → Workspace → AI.",
          aiTriagedAt: new Date(),
        },
      })
      .catch(() => undefined);
  }
}
