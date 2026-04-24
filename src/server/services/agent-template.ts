import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { EventKind } from "@prisma/client";
import { recordChange } from "@/server/audit";

/**
 * Per-agent issue templates.
 *
 * When an agent is assigned to an issue and the agent has a
 * `templateMarkdown` configured, we auto-populate the issue's description
 * with that template — but ONLY when the description is empty or
 * whitespace-only. Human-authored content is never overwritten.
 *
 * Callers must pass the open transaction client that performed the
 * assignment, so the template write, audit row, and activity event all
 * commit (or roll back) together with the original assignment.
 *
 * Design choice: we write an audit-only marker via `recordChange()` with
 * `eventKind = ISSUE_UPDATED` and `payload.fromAgentTemplate = true`
 * rather than emitting a system comment. The codebase already routes
 * ISSUE_UPDATED through the activity stream and webhook fan-out; a
 * synthetic Comment row would need a fake author (there's no system
 * user) and would show up in human comment threads as noise. The audit
 * payload marker is enough for the UI's Activity tab and for replaying
 * the decision from the event log alone.
 */
export async function maybeApplyAgentTemplate(
  tx: PrismaClient | Prisma.TransactionClient,
  issueId: string,
  agentId: string,
): Promise<{ applied: boolean; reason: string }> {
  const agent = await tx.agent.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      workspaceId: true,
      profileKey: true,
      templateMarkdown: true,
    },
  });
  if (!agent) return { applied: false, reason: "agent-not-found" };
  const template = agent.templateMarkdown;
  if (template === null || template === undefined || template === "") {
    return { applied: false, reason: "no-template" };
  }

  const issue = await tx.issue.findUnique({
    where: { id: issueId },
    select: {
      id: true,
      workspaceId: true,
      description: true,
    },
  });
  if (!issue) return { applied: false, reason: "issue-not-found" };
  // Defensive cross-tenant guard — an agent from one workspace should
  // never end up assigned to an issue in another, but belt-and-braces.
  if (issue.workspaceId !== agent.workspaceId) {
    return { applied: false, reason: "cross-tenant" };
  }

  // Treat null, empty, and whitespace-only descriptions as "empty" — any
  // real human-authored content (even a single character) is preserved.
  const existing = issue.description ?? "";
  if (existing.trim().length > 0) {
    return { applied: false, reason: "description-not-empty" };
  }

  await tx.issue.update({
    where: { id: issue.id },
    data: { description: template },
  });

  // Audit-only marker. See file-level comment for the rationale.
  await recordChange(tx, {
    workspaceId: issue.workspaceId,
    actorId: null,
    entity: "Issue",
    entityId: issue.id,
    action: "apply-agent-template",
    before: { description: null },
    after: { description: template },
    eventKind: EventKind.ISSUE_UPDATED,
    subjectType: "issue",
    subjectId: issue.id,
    payload: {
      fromAgentTemplate: true,
      agentId: agent.id,
      profileKey: agent.profileKey,
    },
  });

  return { applied: true, reason: "applied" };
}
