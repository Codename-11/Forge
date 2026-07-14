import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { AgentRole, AiTriageStatus, EventKind } from "@prisma/client";
import type { EngagementMode } from "@prisma/client";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { triageIssue } from "@/server/services/ai-triage";
import { listProviders, runDescriptionDraft, runDescriptionEnhance } from "@/server/services/ai";
import {
  resolveWorkspaceProviderClient,
  workspaceChatProviderAvailability,
} from "@/server/services/ai-providers";
import { recordManualDispatchReason } from "@/server/services/dispatcher";
import { resolveEngagementMode } from "@/server/services/engagement-mode";
import { maybeApplyAgentTemplate } from "@/server/services/agent-template";
import { abandonRunsForAgentReassignment } from "@/server/services/agent-run";
import { setIssueAgentWakeTarget } from "@/server/services/issue-watchers";
import { encryptSecret } from "@/server/crypto";
import { isAiTriagePendingStale } from "@/lib/ai-triage";

/** Providers that accept a DB-backed key (hermes is a runtime, not a key). */
const CREDENTIAL_PROVIDER_IDS = ["openai", "anthropic", "custom"] as const;

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
    const ws = await ctx.db.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: { aiProvider: true, aiModel: true },
    });
    const isAvailable = await workspaceChatProviderAvailability(ctx.db, ctx.workspaceId);
    const providers = listProviders().map((provider) => ({
      ...provider,
      available: isAvailable(provider.id),
      unavailableReason: isAvailable(provider.id) ? undefined : provider.unavailableReason,
    }));
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
   * Full Coach health for the settings panel: is it armed, can it reach a
   * model, does the Coach agent exist, which trigger events are active vs
   * disabled, and when it last fired. Answers "it's on but not doing
   * anything / where's the backend".
   */
  coachStatus: workspaceProcedure.query(async ({ ctx }) => {
    const ws = await ctx.db.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: {
        aiEnabled: true,
        aiCoachEnabled: true,
        aiProvider: true,
        aiModel: true,
        assignmentSlaMinutes: true,
        requiredAckSeconds: true,
        slaEnforcementEnabled: true,
      },
    });
    const coach = await ctx.db.agent.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        role: AgentRole.COACH,
        archivedAt: null,
      },
      select: { id: true, profileKey: true, name: true, status: true },
    });
    const isAvailable = await workspaceChatProviderAvailability(ctx.db, ctx.workspaceId);
    const providers = listProviders().map((candidate) => ({
      ...candidate,
      available: isAvailable(candidate.id),
      unavailableReason: isAvailable(candidate.id) ? undefined : candidate.unavailableReason,
    }));
    const provider = providers.find((p) => p.id === (ws.aiProvider ?? "hermes")) ?? providers[0];

    let lastFired: {
      issueId: string;
      issueNumber: number;
      at: Date;
    } | null = null;
    if (coach) {
      const last = await ctx.db.comment.findFirst({
        where: { authoringAgentId: coach.id, workspaceId: ctx.workspaceId },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, issue: { select: { id: true, number: true } } },
      });
      if (last?.issue) {
        lastFired = {
          issueId: last.issue.id,
          issueNumber: last.issue.number,
          at: last.createdAt,
        };
      }
    }

    return {
      enabled: ws.aiEnabled && ws.aiCoachEnabled,
      aiEnabled: ws.aiEnabled,
      coachToggle: ws.aiCoachEnabled,
      provider: {
        id: provider.id,
        label: provider.label,
        available: provider.available,
        reason: provider.unavailableReason ?? null,
      },
      model: ws.aiModel || provider.defaultModel,
      agent: coach,
      triggers: {
        stalled: {
          enabled: ws.assignmentSlaMinutes > 0,
          minutes: ws.assignmentSlaMinutes,
        },
        noack: {
          enabled: ws.requiredAckSeconds > 0,
          seconds: ws.requiredAckSeconds,
        },
        sla: { enabled: ws.slaEnforcementEnabled },
      },
      lastFired,
    };
  }),

  /**
   * Per-workspace chat-model credentials (DB-backed, key encrypted). Lets the
   * Streaming engine work with no env config. Keys are NEVER returned — only
   * `hasKey`. Workspace-admin gated.
   */
  credentials: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.providerCredential.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: {
        providerId: true,
        label: true,
        baseUrl: true,
        defaultModel: true,
        enabled: true,
        apiKeyEnc: true,
        updatedAt: true,
      },
      orderBy: { providerId: "asc" },
    });
    return rows.map(({ apiKeyEnc, ...r }) => ({ ...r, hasKey: !!apiKeyEnc }));
  }),

  setCredential: adminProcedure
    .input(
      z.object({
        providerId: z.enum(CREDENTIAL_PROVIDER_IDS),
        // Empty string = leave an existing key unchanged; a value sets/replaces it.
        apiKey: z.string().max(400).optional(),
        baseUrl: z.string().url().max(500).nullable().optional().or(z.literal("")),
        defaultModel: z.string().max(120).nullable().optional().or(z.literal("")),
        label: z.string().max(120).nullable().optional().or(z.literal("")),
        enabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const enc = input.apiKey ? encryptSecret(input.apiKey) : undefined;
      const norm = (v: string | null | undefined) =>
        v === undefined ? undefined : v === "" ? null : v;
      const baseUrl = norm(input.baseUrl);
      const defaultModel = norm(input.defaultModel);
      const label = norm(input.label);
      // An enabled custom credential is unusable without its endpoint. Check
      // the effective value so partial edits can keep an existing base URL,
      // while a new/cleared credential cannot be reported as available.
      if (input.providerId === "custom") {
        const existing = await ctx.db.providerCredential.findUnique({
          where: {
            workspaceId_providerId: {
              workspaceId: ctx.workspaceId,
              providerId: input.providerId,
            },
          },
          select: { baseUrl: true, enabled: true },
        });
        const effectiveBaseUrl = baseUrl === undefined ? existing?.baseUrl : baseUrl;
        const effectiveEnabled = input.enabled ?? existing?.enabled ?? true;
        if (effectiveEnabled && !effectiveBaseUrl) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "An enabled custom provider needs a base URL.",
          });
        }
      }
      const row = await ctx.db.providerCredential.upsert({
        where: {
          workspaceId_providerId: {
            workspaceId: ctx.workspaceId,
            providerId: input.providerId,
          },
        },
        create: {
          workspaceId: ctx.workspaceId,
          providerId: input.providerId,
          apiKeyEnc: enc ?? null,
          baseUrl: baseUrl ?? null,
          defaultModel: defaultModel ?? null,
          label: label ?? null,
          enabled: input.enabled ?? true,
        },
        update: {
          ...(enc !== undefined ? { apiKeyEnc: enc } : {}),
          ...(baseUrl !== undefined ? { baseUrl } : {}),
          ...(defaultModel !== undefined ? { defaultModel } : {}),
          ...(label !== undefined ? { label } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        },
        select: { providerId: true, apiKeyEnc: true },
      });
      return { providerId: row.providerId, hasKey: !!row.apiKeyEnc };
    }),

  removeCredential: adminProcedure
    .input(z.object({ providerId: z.enum(CREDENTIAL_PROVIDER_IDS) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.providerCredential
        .delete({
          where: {
            workspaceId_providerId: {
              workspaceId: ctx.workspaceId,
              providerId: input.providerId,
            },
          },
        })
        .catch(() => undefined); // already gone — idempotent
      return { ok: true };
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
      if (!input.applyPriority && !input.applyLabels && !input.applyAgent) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Select at least one suggestion to apply.",
        });
      }
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
        // Claim the decision before emitting side effects. Concurrent Apply
        // requests serialize on this row; exactly one can move READY→APPLIED.
        const claimed = await tx.issue.updateMany({
          where: { id: issue.id, aiTriageStatus: AiTriageStatus.READY },
          data: {
            aiTriageStatus: AiTriageStatus.APPLIED,
            aiTriageDecidedAt: new Date(),
          },
        });
        if (claimed.count === 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This triage suggestion was already decided.",
          });
        }

        const updates: {
          priority?: typeof issue.priority;
          assignedAgentId?: string | null;
        } = {};
        const previousPriority = issue.priority;
        const previousAgentId = issue.assignedAgentId;
        let assignedAgent: {
          id: string;
          profileKey: string;
          engagementMode: EngagementMode | null;
        } | null = null;
        let previousLabelIds: string[] = [];
        let addedLabelIds: string[] = [];

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
            select: { id: true, profileKey: true, engagementMode: true },
          });
          if (agent) {
            assignedAgent = agent;
            updates.assignedAgentId = agent.id;
          }
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
          const toAdd = validLabels.map((l) => l.id).filter((id) => !existingSet.has(id));
          if (toAdd.length > 0) {
            await tx.issueLabel.createMany({
              data: toAdd.map((labelId) => ({
                issueId: issue.id,
                labelId,
              })),
              skipDuplicates: true,
            });
            previousLabelIds = Array.from(existingSet);
            addedLabelIds = toAdd;
          }
        }

        // Activity events for the operator-visible changes.
        if (updates.priority) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
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
        if (addedLabelIds.length > 0) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: issue.id,
            action: "ai-triage-apply-labels",
            before: { labelIds: previousLabelIds },
            after: { labelIds: [...previousLabelIds, ...addedLabelIds] },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "issue",
            subjectId: issue.id,
            payload: {
              labelIds: addedLabelIds,
              operation: "add",
              source: "ai-triage",
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }
        if (updates.assignedAgentId && assignedAgent) {
          const manualReason = await recordManualDispatchReason(tx, {
            issueId: issue.id,
            agentProfileKey: assignedAgent.profileKey,
            actorId: ctx.session.user.id,
          });
          const ws = await tx.workspace.findUniqueOrThrow({
            where: { id: ctx.workspaceId },
            select: {
              assignmentEngagementMode: true,
              mentionEngagementPolicy: true,
              mentionDefaultMode: true,
            },
          });
          const resolved = resolveEngagementMode({
            surface: "assignment",
            workspace: {
              ...ws,
              assignmentAgentEngagementMode: assignedAgent.engagementMode,
            },
          });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
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
              dispatchReason: manualReason,
              engagementMode: resolved.mode,
              engagementSource: resolved.source,
              source: "ai-triage",
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          if (previousAgentId) {
            await abandonRunsForAgentReassignment(tx, {
              workspaceId: ctx.workspaceId,
              issueId: issue.id,
              agentId: previousAgentId,
              actorId: ctx.session.user.id,
              actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
              summary: "Abandoned because AI triage reassigned the issue to another agent.",
            });
          }
          await maybeApplyAgentTemplate(tx, issue.id, assignedAgent.id);
          await setIssueAgentWakeTarget(tx, {
            workspaceId: ctx.workspaceId,
            issueId: issue.id,
            agentId: assignedAgent.id,
          });
        }

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
        select: { id: true, aiTriageStatus: true, aiTriagedAt: true },
      });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND" });
      if (
        issue.aiTriageStatus === AiTriageStatus.PENDING &&
        !isAiTriagePendingStale(issue.aiTriagedAt)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "AI triage is already running for this issue.",
        });
      }
      // Reset state so the runner doesn't short-circuit.
      const reset = await ctx.db.issue.updateMany({
        where: { id: issue.id, aiTriageStatus: issue.aiTriageStatus },
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
      if (reset.count === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "The triage state changed. Try again.",
        });
      }
      void triageIssue(issue.id);
      return { ok: true };
    }),

  /**
   * Draft an issue description from its title. Read-only — returns Markdown the
   * client stages for the operator to Apply (via `issue.update`); never
   * persists here. Gated on workspace `aiEnabled`.
   */
  draftDescription: workspaceProcedure
    .input(z.object({ issueId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findFirst({
        where: { id: input.issueId, workspaceId: ctx.workspaceId, deletedAt: null },
        select: {
          title: true,
          description: true,
          workspace: {
            select: { aiEnabled: true, aiProvider: true, aiModel: true },
          },
        },
      });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND" });
      if (!issue.workspace.aiEnabled)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "AI is off for this workspace. Enable it in Settings → Workspace → AI.",
        });
      const providerClient = await resolveWorkspaceProviderClient(
        ctx.db,
        ctx.workspaceId,
        issue.workspace.aiProvider,
      );
      const markdown = providerClient
        ? await runDescriptionDraft(providerClient, {
            title: issue.title,
            description: issue.description,
            provider: issue.workspace.aiProvider,
            model: issue.workspace.aiModel,
          })
        : null;
      if (!markdown)
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message:
            "The AI provider didn't return a description. Check the provider/model in Settings → Workspace → AI.",
        });
      return { markdown };
    }),

  /**
   * Enhance the current description (clarity/structure, preserving intent and
   * facts). Returns both the original and the suggestion so the client can show
   * a diff. Read-only; falls back to a fresh draft when empty.
   */
  enhanceDescription: workspaceProcedure
    .input(z.object({ issueId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findFirst({
        where: { id: input.issueId, workspaceId: ctx.workspaceId, deletedAt: null },
        select: {
          title: true,
          description: true,
          workspace: {
            select: { aiEnabled: true, aiProvider: true, aiModel: true },
          },
        },
      });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND" });
      if (!issue.workspace.aiEnabled)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "AI is off for this workspace. Enable it in Settings → Workspace → AI.",
        });
      const providerClient = await resolveWorkspaceProviderClient(
        ctx.db,
        ctx.workspaceId,
        issue.workspace.aiProvider,
      );
      const markdown = providerClient
        ? await runDescriptionEnhance(providerClient, {
            title: issue.title,
            description: issue.description,
            provider: issue.workspace.aiProvider,
            model: issue.workspace.aiModel,
          })
        : null;
      if (!markdown)
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message:
            "The AI provider didn't return a result. Check the provider/model in Settings → Workspace → AI.",
        });
      return { original: issue.description ?? "", markdown };
    }),

  /**
   * Native Hermes command passthrough — proxies the gateway's real
   * `/api/skills`, `/api/memory`, and `/health/detailed` endpoints so the
   * `/hermes skills|memory|status` chat commands return live data instead
   * of a prose approximation. Server-side so the gateway token never
   * reaches the client. `agentProfileKey` is forwarded as the memory-scope
   * session key so multi-profile gateways answer for the right agent.
   * Native commands without an API (`/usage`, `/yolo`) stay prose-bridged.
   */
  hermesInfo: workspaceProcedure
    .input(
      z.object({
        resource: z.enum(["skills", "memory", "health"]),
        agentProfileKey: z.string().max(120).optional(),
      }),
    )
    .query(async ({ input }) => {
      const base =
        process.env.HERMES_GATEWAY_URL ??
        `http://127.0.0.1:${process.env.HERMES_GATEWAY_PORT ?? "8642"}/v1`;
      const root = base.replace(/\/v1\/?$/, "");
      const path =
        input.resource === "skills"
          ? "/api/skills"
          : input.resource === "memory"
            ? "/api/memory"
            : "/health/detailed";
      const headers: Record<string, string> = {
        accept: "application/json",
        authorization: `Bearer ${process.env.HERMES_GATEWAY_TOKEN ?? ""}`,
      };
      if (input.agentProfileKey) headers["x-session-key"] = input.agentProfileKey;
      let res: Response;
      try {
        res = await fetch(`${root}${path}`, { headers });
      } catch (e) {
        return {
          ok: false as const,
          markdown: `_Couldn't reach the Hermes gateway: ${e instanceof Error ? e.message : "error"}._`,
        };
      }
      if (!res.ok) {
        return {
          ok: false as const,
          markdown: `_Hermes ${input.resource} returned HTTP ${res.status}._`,
        };
      }
      const data: unknown = await res.json().catch(() => null);
      return { ok: true as const, markdown: formatHermesInfo(input.resource, data) };
    }),
});

/** Format a Hermes gateway response into a compact markdown block. */
function formatHermesInfo(resource: "skills" | "memory" | "health", data: unknown): string {
  if (data == null) return `_No ${resource} data returned._`;
  if (resource === "skills") {
    const list = Array.isArray(data)
      ? data
      : Array.isArray((data as { skills?: unknown[] }).skills)
        ? (data as { skills: unknown[] }).skills
        : [];
    if (list.length === 0) return "_No skills reported._";
    const names = list.map((s) => {
      if (typeof s === "string") return s;
      const o = s as Record<string, unknown>;
      const name = String(o.name ?? o.id ?? "skill");
      const desc = typeof o.description === "string" ? ` — ${o.description}` : "";
      return `${name}${desc}`;
    });
    return `### Skills (${names.length})\n\n${names.map((n) => `- ${n}`).join("\n")}`;
  }
  if (resource === "memory") {
    const entries = Array.isArray(data)
      ? data
      : Array.isArray((data as { entries?: unknown[] }).entries)
        ? (data as { entries: unknown[] }).entries
        : null;
    if (entries) {
      if (entries.length === 0) return "_Memory is empty._";
      const lines = entries.slice(0, 20).map((e) => {
        if (typeof e === "string") return `- ${e}`;
        const o = e as Record<string, unknown>;
        return `- ${String(o.text ?? o.content ?? o.key ?? JSON.stringify(o)).slice(0, 160)}`;
      });
      return `### Memory (${entries.length})\n\n${lines.join("\n")}`;
    }
    return "### Memory\n\n```json\n" + JSON.stringify(data, null, 2).slice(0, 1200) + "\n```";
  }
  const o = (typeof data === "object" && data ? data : {}) as Record<string, unknown>;
  return (
    `### Hermes gateway\n\n- **status:** ${String(o.status ?? "unknown")}\n\n` +
    "```json\n" +
    JSON.stringify(data, null, 2).slice(0, 800) +
    "\n```"
  );
}
