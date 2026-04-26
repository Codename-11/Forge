import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { AgentRole, AiTriageStatus, EventKind } from "@prisma/client";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { triageIssue } from "@/server/services/ai-triage";
import { listProviders } from "@/server/services/ai";

/**
 * AI router — apply / dismiss / re-run for the triage suggestion that
 * lives on the Issue row, plus a `status` query that reports whether
 * AI is wired up at all (so settings UI can show the right copy).
 */
export const aiRouter = router({
  /**
   * Are AI features available in this deployment? Surface to settings UI.
   * Disabled at the workspace level is a separate signal — the settings
   * page reads `workspace.current` for that.
   */
  status: workspaceProcedure.query(async ({ ctx }) => {
    const coach = await ctx.db.agent.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        role: AgentRole.COACH,
        archivedAt: null,
      },
      select: { id: true, profileKey: true, name: true },
    });
    const providers = listProviders();
    const ws = await ctx.db.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: { aiProvider: true, aiModel: true },
    });
    const active = providers.find((p) => p.id === ws.aiProvider) ?? providers[0];
    return {
      coach,
      providers,
      activeProvider: active.id,
      activeProviderAvailable: active.available,
      activeProviderReason: active.unavailableReason,
      // Surfaced for legacy callers that just want a yes/no.
      apiKeyConfigured: active.available,
    };
  }),

  /**
   * Idempotent Coach setup. Finds the workspace's COACH agent or creates
   * one with sensible defaults. Used by the settings UI's "Set up Coach"
   * button so operators don't have to learn the agent CRUD flow.
   */
  ensureCoach: adminProcedure
    .input(
      z
        .object({
          name: z.string().min(1).max(80).optional(),
          profileKey: z
            .string()
            .min(1)
            .max(40)
            .regex(/^[a-z0-9_-]+$/)
            .optional(),
        })
        .default({}),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.agent.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          role: AgentRole.COACH,
          archivedAt: null,
        },
      });
      if (existing) return existing;

      // Avoid colliding with an existing profileKey (a previous WORKER
      // agent named "coach" for example).
      const baseKey = input.profileKey ?? "coach";
      let profileKey = baseKey;
      let suffix = 1;
      while (
        await ctx.db.agent.findUnique({
          where: {
            workspaceId_profileKey: {
              workspaceId: ctx.workspaceId,
              profileKey,
            },
          },
        })
      ) {
        profileKey = `${baseKey}-${++suffix}`;
        if (suffix > 10) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Could not allocate a coach profileKey.",
          });
        }
      }

      return ctx.db.agent.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: input.name ?? "Coach",
          profileKey,
          role: AgentRole.COACH,
          description:
            "Diagnostic AI agent. Posts a short comment when an issue stalls, an agent misses an ack, or an SLA is breached. Does not claim work.",
          avatar: "🪶",
          capabilities: ["coach", "diagnostics"],
          maxConcurrent: 0,
        },
      });
    }),

  /**
   * Apply the triage suggestion in full. Atomic: priority + labels +
   * agent assignment in one transaction. Records ISSUE_PRIORITY_CHANGED
   * + AGENT_ASSIGNED events for activity feed.
   */
  triageApply: workspaceProcedure
    .input(
      z.object({
        issueId: z.string().cuid(),
        applyPriority: z.boolean().default(true),
        applyLabels: z.boolean().default(true),
        applyAgent: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const issue = await tx.issue.findFirst({
          where: {
            id: input.issueId,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: {
            id: true,
            priority: true,
            assignedAgentId: true,
            aiTriageStatus: true,
            aiSuggestedPriority: true,
            aiSuggestedLabelIds: true,
            aiSuggestedAgentId: true,
          },
        });
        if (!issue) throw new TRPCError({ code: "NOT_FOUND" });
        if (issue.aiTriageStatus !== AiTriageStatus.READY) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Triage suggestion is not ready or already decided.",
          });
        }

        const updates: {
          priority?: typeof issue.priority;
          assignedAgentId?: string | null;
        } = {};
        const previousPriority = issue.priority;
        const previousAgentId = issue.assignedAgentId;

        if (
          input.applyPriority &&
          issue.aiSuggestedPriority &&
          issue.aiSuggestedPriority !== issue.priority
        ) {
          updates.priority = issue.aiSuggestedPriority;
        }

        if (
          input.applyAgent &&
          issue.aiSuggestedAgentId &&
          issue.aiSuggestedAgentId !== issue.assignedAgentId
        ) {
          // Defensive: confirm agent still exists in this workspace.
          const agent = await tx.agent.findFirst({
            where: {
              id: issue.aiSuggestedAgentId,
              workspaceId: ctx.workspaceId,
              archivedAt: null,
            },
            select: { id: true },
          });
          if (agent) updates.assignedAgentId = agent.id;
        }

        if (Object.keys(updates).length > 0) {
          await tx.issue.update({
            where: { id: issue.id },
            data: updates,
          });
        }

        if (input.applyLabels && issue.aiSuggestedLabelIds.length > 0) {
          // Confirm label ids belong to this workspace before linking.
          const validLabels = await tx.label.findMany({
            where: {
              id: { in: issue.aiSuggestedLabelIds },
              workspaceId: ctx.workspaceId,
            },
            select: { id: true },
          });
          // Insert any not-already-present.
          const existing = await tx.issueLabel.findMany({
            where: { issueId: issue.id },
            select: { labelId: true },
          });
          const existingSet = new Set(existing.map((e) => e.labelId));
          const toAdd = validLabels
            .map((l) => l.id)
            .filter((id) => !existingSet.has(id));
          if (toAdd.length > 0) {
            await tx.issueLabel.createMany({
              data: toAdd.map((labelId) => ({
                issueId: issue.id,
                labelId,
              })),
              skipDuplicates: true,
            });
          }
        }

        // Activity events for the operator-visible changes.
        if (updates.priority) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            entity: "Issue",
            entityId: issue.id,
            action: "ai-triage-apply-priority",
            before: { priority: previousPriority },
            after: { priority: updates.priority },
            eventKind: EventKind.ISSUE_PRIORITY_CHANGED,
            subjectType: "issue",
            subjectId: issue.id,
            payload: {
              from: previousPriority,
              to: updates.priority,
              source: "ai-triage",
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }
        if (updates.assignedAgentId) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            entity: "Issue",
            entityId: issue.id,
            action: "ai-triage-apply-agent",
            after: { assignedAgentId: updates.assignedAgentId },
            eventKind: EventKind.AGENT_ASSIGNED,
            subjectType: "issue",
            subjectId: issue.id,
            payload: {
              agentId: updates.assignedAgentId,
              previousAgentId,
              source: "ai-triage",
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }

        await tx.issue.update({
          where: { id: issue.id },
          data: {
            aiTriageStatus: AiTriageStatus.APPLIED,
            aiTriageDecidedAt: new Date(),
          },
        });

        return { ok: true };
      });
    }),

  /**
   * Dismiss the triage suggestion without applying. Suggestion stays on
   * the issue for audit but is hidden from the UI.
   */
  triageDismiss: workspaceProcedure
    .input(z.object({ issueId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findFirst({
        where: {
          id: input.issueId,
          workspaceId: ctx.workspaceId,
          deletedAt: null,
        },
        select: { id: true, aiTriageStatus: true },
      });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND" });
      if (issue.aiTriageStatus !== AiTriageStatus.READY) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Triage suggestion is not ready or already decided.",
        });
      }
      await ctx.db.issue.update({
        where: { id: issue.id },
        data: {
          aiTriageStatus: AiTriageStatus.DISMISSED,
          aiTriageDecidedAt: new Date(),
        },
      });
      return { ok: true };
    }),

  /**
   * Manually re-run triage on an issue — useful when the title /
   * description was edited substantially after creation, or after the
   * operator added more labels/agents to the workspace.
   */
  triageRerun: workspaceProcedure
    .input(z.object({ issueId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findFirst({
        where: {
          id: input.issueId,
          workspaceId: ctx.workspaceId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND" });
      // Reset state so the runner doesn't short-circuit.
      await ctx.db.issue.update({
        where: { id: issue.id },
        data: {
          aiTriageStatus: null,
          aiTriagedAt: null,
          aiTriageDecidedAt: null,
          aiSuggestedPriority: null,
          aiSuggestedLabelIds: [],
          aiSuggestedAgentId: null,
          aiTriageReasoning: null,
        },
      });
      void triageIssue(issue.id);
      return { ok: true };
    }),
});
