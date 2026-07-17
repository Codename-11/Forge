import { z } from "zod";
import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  AutoDispatchMode,
  ArtifactAgentPublishPolicy,
  CompletionAutomation,
  CycleStatus,
  DefaultIssueAssigneeMode,
  DeliveryTimelinePolicy,
  EngagementMode,
  EventKind,
  InvitationStatus,
  MentionEngagementPolicy,
  Prisma,
  Role,
  RunBudgetAction,
  WorkspaceExperienceProfile,
} from "@prisma/client";
import { router, protectedProcedure, workspaceProcedure, adminProcedure } from "@/server/trpc";
import { rateLimit } from "@/server/rate-limit";
import { recordChange } from "@/server/audit";
import {
  deliverWorkspaceInvitation,
  expireWorkspaceInvitations,
  invitationExpiry,
  invitationTokenHash,
  newInvitationToken,
} from "@/server/services/workspace-invitations";

/**
 * Crypto-strong random token for shared secrets (email-ingest HMAC,
 * etc.). 40 hex chars = 160 bits of entropy. Url-safe.
 */
function randomToken(len = 40): string {
  return randomBytes(Math.ceil(len / 2))
    .toString("hex")
    .slice(0, len);
}
import {
  deleteWorkspaceBucket,
  ensureWorkspaceBucket,
  workspaceQuotaStats,
} from "@/server/services/storage";

const slugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes.");

const keySchema = z
  .string()
  .min(2)
  .max(6)
  .regex(/^[A-Z]+$/, "Key must be uppercase letters.");

async function enforceInvitationRateLimit(
  workspaceId: string,
  userId: string,
  action: "send" | "resend",
  limit: number,
  windowSec: number,
) {
  const [workspaceBucket, userBucket] = await Promise.all([
    rateLimit(`workspace-invitations:${action}:${workspaceId}`, limit * 3, windowSec),
    rateLimit(`workspace-invitations:${action}:${workspaceId}:${userId}`, limit, windowSec),
  ]);
  if (!workspaceBucket.ok || !userBucket.ok) {
    const resetAt = Math.max(workspaceBucket.resetAt, userBucket.resetAt);
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Invitation rate limit exceeded. Retry after ${new Date(resetAt).toISOString()}.`,
    });
  }
}

export const workspaceRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.workspace.findMany({
      where: {
        deletedAt: null,
        memberships: { some: { userId: ctx.session.user.id } },
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        key: true,
        avatarUrl: true,
        experienceProfile: true,
        memberships: {
          where: { userId: ctx.session.user.id },
          select: { role: true },
          take: 1,
        },
      },
    });
  }),

  // Minimal mutation used by the workspace switcher + shell layout to
  // remember the last-visited workspace across sign-ins. Agent C will
  // extend the workspace router with update/archive/delete; this safe
  // one-liner stays in Agent E's lane per the migration plan.
  setLastWorkspace: protectedProcedure
    .input(z.object({ workspaceId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const membership = await ctx.db.membership.findUnique({
        where: {
          userId_workspaceId: {
            userId: ctx.session.user.id,
            workspaceId: input.workspaceId,
          },
        },
      });
      if (!membership) throw new TRPCError({ code: "FORBIDDEN" });
      return ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { lastWorkspaceId: input.workspaceId },
        select: { id: true, lastWorkspaceId: true },
      });
    }),

  current: workspaceProcedure.query(async ({ ctx }) => {
    // NOTE: we used to return all scalar columns via `include`; that
    // changed to a tight select when `emailIngestSecret` was added so
    // the HMAC shared secret never leaks to a non-admin caller. The
    // shape of every previously-included scalar is preserved below.
    return ctx.db.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: {
        id: true,
        slug: true,
        name: true,
        key: true,
        avatarUrl: true,
        experienceProfile: true,
        cycleLengthDays: true,
        cycleCooldownDays: true,
        timeTrackingEnabled: true,
        attachmentQuotaMb: true,
        connectorRequestTimeoutSeconds: true,
        connectorDeliveryMaxAttempts: true,
        connectorProcessingLeaseSeconds: true,
        connectorRetryInitialSeconds: true,
        connectorRetryMaxSeconds: true,
        webhookRetryMaxAttempts: true,
        webhookRetryInitialSeconds: true,
        webhookRetryMaxSeconds: true,
        artifactExternalSharingEnabled: true,
        artifactPublicPublishingEnabled: true,
        artifactDefaultLinkExpiryDays: true,
        artifactPreviewEnabled: true,
        artifactAgentPublishPolicy: true,
        defaultIssueAssigneeMode: true,
        defaultIssueAssigneeUserId: true,
        defaultIssueAssigneeUser: {
          select: { id: true, name: true, email: true, image: true },
        },
        autoDispatch: true,
        autoDispatchMode: true,
        autoStartOnAssign: true,
        agentIdleTimeoutMinutes: true,
        requireApprovalBeforeStart: true,
        assignmentSlaMinutes: true,
        autoRedispatchOnStall: true,
        requiredAckSeconds: true,
        autoRedispatchOnNoack: true,
        slaEnforcementEnabled: true,
        aiEnabled: true,
        aiTriageOnCreate: true,
        aiCoachEnabled: true,
        aiProvider: true,
        aiModel: true,
        agentRunStaleMinutes: true,
        agentProgressUpdateMinutes: true,
        agentRunQuietMinutes: true,
        reviewStartTimeoutMinutes: true,
        ephemeralAgentIdleMinutes: true,
        runTokenBudget: true,
        runCostBudgetUsd: true,
        runMaxMinutes: true,
        runBudgetWarnPct: true,
        runBudgetAction: true,
        startedStatusId: true,
        reviewStatusId: true,
        completionAutomation: true,
        deliveryTimelinePolicy: true,
        completionStatusId: true,
        githubSyncEnabled: true,
        githubSyncStaleMinutes: true,
        githubSyncBatchSize: true,
        githubSyncBackoffMinutes: true,
        githubSyncMaxBackoffMinutes: true,
        githubRequestTimeoutSeconds: true,
        githubSweepBudgetSeconds: true,
        githubClosedReprobeMinutes: true,
        githubManualCooldownSeconds: true,
        workSessionStaleMinutes: true,
        stalledThresholdDays: true,
        agentHeartbeatWarnMinutes: true,
        agentHeartbeatCriticalMinutes: true,
        assignmentEngagementMode: true,
        mentionEngagementPolicy: true,
        mentionDefaultMode: true,
        emailIngestEnabled: true,
        inviteExpiryHours: true,
        // emailIngestSecret intentionally omitted — see note above.
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        statuses: { orderBy: { position: "asc" } },
        _count: { select: { projects: true, issues: true, memberships: true } },
      },
    });
  }),

  create: protectedProcedure
    .input(
      z.object({
        slug: slugSchema,
        name: z.string().min(1).max(80),
        key: keySchema,
        experienceProfile: z
          .nativeEnum(WorkspaceExperienceProfile)
          .default(WorkspaceExperienceProfile.TEAM),
        cycleLengthDays: z.number().int().min(1).max(90).optional(),
        timeTrackingEnabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.workspace.findFirst({
        where: { OR: [{ slug: input.slug }, { key: input.key }] },
      });
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "Slug or key in use." });

      // Governance guardrail for self-service tenant creation. `workspace.create`
      // is open to any signed-in user (intended for onboarding), which lets one
      // user spin up unlimited tenants. `MAX_WORKSPACES_PER_USER` (env, default
      // 0 = unlimited → no behavior change) caps how many a non-instance-admin
      // may own; instance admins are never capped.
      const cap = Number(process.env.MAX_WORKSPACES_PER_USER ?? 0);
      if (cap > 0) {
        const me = await ctx.db.user.findUnique({
          where: { id: ctx.session.user.id },
          select: { instanceRole: true },
        });
        if (me?.instanceRole !== "INSTANCE_ADMIN") {
          const owned = await ctx.db.membership.count({
            where: { userId: ctx.session.user.id, role: Role.OWNER },
          });
          if (owned >= cap) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: `You've reached the limit of ${cap} workspace${cap === 1 ? "" : "s"} you can create. Ask an instance admin to raise it.`,
            });
          }
        }
      }

      const cycleLengthDays = input.cycleLengthDays ?? 7;
      const isPersonal = input.experienceProfile === WorkspaceExperienceProfile.PERSONAL;
      const now = new Date();
      const cycleEndsAt = new Date(now.getTime());
      cycleEndsAt.setUTCDate(cycleEndsAt.getUTCDate() + cycleLengthDays);

      // Seed statuses (warm-earthy colors), starter labels, and an ACTIVE
      // Cycle 1. Bucket creation happens after the row is written, since
      // the slug is needed to name the bucket.
      const workspace = await ctx.db.workspace.create({
        data: {
          slug: input.slug,
          name: input.name,
          key: input.key,
          experienceProfile: input.experienceProfile,
          cycleLengthDays,
          timeTrackingEnabled: input.timeTrackingEnabled ?? false,
          defaultIssueAssigneeMode: isPersonal
            ? DefaultIssueAssigneeMode.CREATOR
            : DefaultIssueAssigneeMode.NONE,
          memberships: { create: { userId: ctx.session.user.id, role: Role.OWNER } },
          statuses: {
            create: [
              { name: "Backlog", category: "BACKLOG", color: "#78716c", position: 0 },
              { name: "Todo", category: "TODO", color: "#a8a29e", position: 1, isDefault: true },
              { name: "In Progress", category: "IN_PROGRESS", color: "#d97706", position: 2 },
              { name: "In Review", category: "IN_REVIEW", color: "#ca8a04", position: 3 },
              { name: "Done", category: "DONE", color: "#65a30d", position: 4 },
              { name: "Canceled", category: "CANCELED", color: "#57534e", position: 5 },
            ],
          },
          labels: {
            create: isPersonal
              ? [
                  { name: "home", color: "#65a30d" },
                  { name: "work", color: "#d97706" },
                  { name: "errand", color: "#0d9488" },
                  { name: "waiting", color: "#78716c" },
                ]
              : [
                  { name: "bug", color: "#b45309" },
                  { name: "feature", color: "#d97706" },
                  { name: "chore", color: "#78716c" },
                  { name: "docs", color: "#0d9488" },
                  { name: "quick-win", color: "#65a30d" },
                ],
          },
          ...(isPersonal
            ? {}
            : {
                cycles: {
                  create: [
                    {
                      name: "Sprint 1",
                      startsAt: now,
                      endsAt: cycleEndsAt,
                      lengthDays: cycleLengthDays,
                      status: CycleStatus.ACTIVE,
                    },
                  ],
                },
              }),
        },
      });
      const completionStatus = await ctx.db.status.findFirst({
        where: { workspaceId: workspace.id, category: "DONE" },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      const configuredWorkspace = completionStatus
        ? await ctx.db.workspace.update({
            where: { id: workspace.id },
            data: { completionStatusId: completionStatus.id },
          })
        : workspace;

      // Best-effort bucket create. If MinIO is unavailable we still return
      // the workspace — attachments simply won't work until ops fixes it.
      await ensureWorkspaceBucket(workspace.id).catch((err) => {
        console.warn(
          `[workspace.create] ensureWorkspaceBucket failed for ${workspace.slug}:`,
          (err as Error).message,
        );
      });

      return configuredWorkspace;
    }),

  // Mutations below are the minimum surface required by the workspace
  // settings UI shipped in Phase 2E. Agent C owns the fuller workspace
  // router overhaul — keep any extensions here tight and additive.
  update: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80).optional(),
        avatarUrl: z.string().url().max(512).nullable().optional(),
        experienceProfile: z.nativeEnum(WorkspaceExperienceProfile).optional(),
        cycleLengthDays: z.number().int().min(1).max(90).optional(),
        cycleCooldownDays: z.number().int().min(0).max(30).optional(),
        timeTrackingEnabled: z.boolean().optional(),
        attachmentQuotaMb: z.number().int().min(0).max(1_024_000).optional(),
        connectorRequestTimeoutSeconds: z.number().int().min(1).max(300).optional(),
        connectorDeliveryMaxAttempts: z.number().int().min(1).max(25).optional(),
        connectorProcessingLeaseSeconds: z.number().int().min(30).max(3600).optional(),
        connectorRetryInitialSeconds: z.number().int().min(1).max(3600).optional(),
        connectorRetryMaxSeconds: z.number().int().min(1).max(86400).optional(),
        webhookRetryMaxAttempts: z.number().int().min(1).max(25).optional(),
        webhookRetryInitialSeconds: z.number().int().min(1).max(3600).optional(),
        webhookRetryMaxSeconds: z.number().int().min(1).max(86400).optional(),
        artifactExternalSharingEnabled: z.boolean().optional(),
        artifactPublicPublishingEnabled: z.boolean().optional(),
        artifactDefaultLinkExpiryDays: z.number().int().min(1).max(365).optional(),
        artifactPreviewEnabled: z.boolean().optional(),
        artifactAgentPublishPolicy: z.nativeEnum(ArtifactAgentPublishPolicy).optional(),
        autoDispatch: z.boolean().optional(),
        autoDispatchMode: z.nativeEnum(AutoDispatchMode).optional(),
        defaultIssueAssigneeMode: z.nativeEnum(DefaultIssueAssigneeMode).optional(),
        defaultIssueAssigneeUserId: z.string().cuid().nullable().optional(),
        agentIdleTimeoutMinutes: z.number().int().min(0).max(1440).optional(),
        assignmentSlaMinutes: z.number().int().min(0).max(10080).optional(),
        agentRunStaleMinutes: z.number().int().min(0).max(10080).optional(),
        agentProgressUpdateMinutes: z.number().int().min(0).max(1440).optional(),
        agentRunQuietMinutes: z.number().int().min(0).max(10080).optional(),
        reviewStartTimeoutMinutes: z.number().int().min(0).max(10080).optional(),
        ephemeralAgentIdleMinutes: z.number().int().min(0).max(10080).optional(),
        // Per-run safety budgets (null = unlimited; opt-in). See run-budget.ts.
        runTokenBudget: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
        runCostBudgetUsd: z.number().min(0).max(100_000).nullable().optional(),
        runMaxMinutes: z.number().int().min(0).max(10080).nullable().optional(),
        runBudgetWarnPct: z.number().int().min(0).max(100).optional(),
        runBudgetAction: z.nativeEnum(RunBudgetAction).optional(),
        autoRedispatchOnStall: z.boolean().optional(),
        requiredAckSeconds: z.number().int().min(0).max(3600).optional(),
        autoRedispatchOnNoack: z.boolean().optional(),
        slaEnforcementEnabled: z.boolean().optional(),
        aiEnabled: z.boolean().optional(),
        aiTriageOnCreate: z.boolean().optional(),
        aiCoachEnabled: z.boolean().optional(),
        aiProvider: z.enum(["hermes", "openai", "anthropic", "custom"]).optional(),
        aiModel: z.string().min(1).max(80).nullable().optional(),
        startedStatusId: z.string().nullable().optional(),
        reviewStatusId: z.string().nullable().optional(),
        completionAutomation: z.nativeEnum(CompletionAutomation).optional(),
        deliveryTimelinePolicy: z.nativeEnum(DeliveryTimelinePolicy).optional(),
        completionStatusId: z.string().nullable().optional(),
        githubSyncEnabled: z.boolean().optional(),
        githubSyncStaleMinutes: z.number().int().min(0).max(10080).optional(),
        githubSyncBatchSize: z.number().int().min(0).max(250).optional(),
        githubSyncBackoffMinutes: z.number().int().min(1).max(1440).optional(),
        githubSyncMaxBackoffMinutes: z.number().int().min(1).max(10080).optional(),
        githubRequestTimeoutSeconds: z.number().int().min(1).max(60).optional(),
        githubSweepBudgetSeconds: z.number().int().min(5).max(300).optional(),
        githubClosedReprobeMinutes: z.number().int().min(60).max(43200).optional(),
        githubManualCooldownSeconds: z.number().int().min(1).max(3600).optional(),
        workSessionStaleMinutes: z.number().int().min(0).max(43200).optional(),
        assignmentEngagementMode: z.nativeEnum(EngagementMode).optional(),
        mentionEngagementPolicy: z.nativeEnum(MentionEngagementPolicy).optional(),
        mentionDefaultMode: z.nativeEnum(EngagementMode).optional(),
        emailIngestEnabled: z.boolean().optional(),
        inviteExpiryHours: z.number().int().min(1).max(720).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const data = { ...input };
      if (
        input.githubSyncBackoffMinutes !== undefined ||
        input.githubSyncMaxBackoffMinutes !== undefined
      ) {
        const current = await ctx.db.workspace.findUniqueOrThrow({
          where: { id: ctx.workspaceId },
          select: {
            githubSyncBackoffMinutes: true,
            githubSyncMaxBackoffMinutes: true,
          },
        });
        const base = input.githubSyncBackoffMinutes ?? current.githubSyncBackoffMinutes;
        const max = input.githubSyncMaxBackoffMinutes ?? current.githubSyncMaxBackoffMinutes;
        if (max < base) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "GitHub maximum backoff must be at least the initial backoff.",
          });
        }
      }
      if (
        input.connectorRetryInitialSeconds !== undefined ||
        input.connectorRetryMaxSeconds !== undefined ||
        input.webhookRetryInitialSeconds !== undefined ||
        input.webhookRetryMaxSeconds !== undefined
      ) {
        const current = await ctx.db.workspace.findUniqueOrThrow({
          where: { id: ctx.workspaceId },
          select: {
            connectorRetryInitialSeconds: true,
            connectorRetryMaxSeconds: true,
            webhookRetryInitialSeconds: true,
            webhookRetryMaxSeconds: true,
          },
        });
        const connectorInitial =
          input.connectorRetryInitialSeconds ?? current.connectorRetryInitialSeconds;
        const connectorMax = input.connectorRetryMaxSeconds ?? current.connectorRetryMaxSeconds;
        const webhookInitial =
          input.webhookRetryInitialSeconds ?? current.webhookRetryInitialSeconds;
        const webhookMax = input.webhookRetryMaxSeconds ?? current.webhookRetryMaxSeconds;
        if (connectorMax < connectorInitial || webhookMax < webhookInitial) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Maximum connector backoff must be at least its initial backoff.",
          });
        }
      }
      // Validate startedStatusId belongs to this workspace and is in the
      // IN_PROGRESS category. Setting null to disable is fine.
      if (input.startedStatusId) {
        const status = await ctx.db.status.findUnique({
          where: { id: input.startedStatusId },
          select: { workspaceId: true, category: true },
        });
        if (!status || status.workspaceId !== ctx.workspaceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "startedStatusId does not belong to this workspace.",
          });
        }
        if (status.category !== "IN_PROGRESS") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "startedStatusId must point at an IN_PROGRESS-category status.",
          });
        }
      }
      // Validate reviewStatusId belongs to this workspace and is in the
      // IN_REVIEW category. Setting null to disable is fine.
      if (input.reviewStatusId) {
        const status = await ctx.db.status.findUnique({
          where: { id: input.reviewStatusId },
          select: { workspaceId: true, category: true },
        });
        if (!status || status.workspaceId !== ctx.workspaceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "reviewStatusId does not belong to this workspace.",
          });
        }
        if (status.category !== "IN_REVIEW") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "reviewStatusId must point at an IN_REVIEW-category status.",
          });
        }
      }
      if (input.completionStatusId) {
        const status = await ctx.db.status.findUnique({
          where: { id: input.completionStatusId },
          select: { workspaceId: true, category: true },
        });
        if (!status || status.workspaceId !== ctx.workspaceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "completionStatusId does not belong to this workspace.",
          });
        }
        if (status.category !== "DONE") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "completionStatusId must point at a DONE-category status.",
          });
        }
      }
      if (
        input.defaultIssueAssigneeMode !== undefined ||
        input.defaultIssueAssigneeUserId !== undefined
      ) {
        const current = await ctx.db.workspace.findUniqueOrThrow({
          where: { id: ctx.workspaceId },
          select: {
            defaultIssueAssigneeMode: true,
            defaultIssueAssigneeUserId: true,
          },
        });
        const nextMode = input.defaultIssueAssigneeMode ?? current.defaultIssueAssigneeMode;
        const nextUserId =
          input.defaultIssueAssigneeUserId === undefined
            ? current.defaultIssueAssigneeUserId
            : input.defaultIssueAssigneeUserId;

        if (nextMode === DefaultIssueAssigneeMode.USER) {
          if (!nextUserId) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Choose a workspace member for the default issue assignee.",
            });
          }
          const member = await ctx.db.membership.findUnique({
            where: {
              userId_workspaceId: {
                userId: nextUserId,
                workspaceId: ctx.workspaceId,
              },
            },
            select: { id: true },
          });
          if (!member) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Default issue assignee must be a workspace member.",
            });
          }
          data.defaultIssueAssigneeUserId = nextUserId;
        } else {
          data.defaultIssueAssigneeUserId = null;
        }
      }
      return ctx.db.workspace.update({
        where: { id: ctx.workspaceId },
        data,
      });
    }),

  /**
   * Whether the email-ingest secret is currently set (without
   * leaking the secret itself). Used by `/settings/connections` to
   * decide whether to show "Generate secret" or "Rotate secret".
   */
  emailIngestStatus: workspaceProcedure.query(async ({ ctx }) => {
    const ws = await ctx.db.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: { emailIngestEnabled: true, emailIngestSecret: true, key: true },
    });
    return {
      enabled: ws.emailIngestEnabled,
      secretSet: !!ws.emailIngestSecret,
      workspaceKey: ws.key,
    };
  }),

  /**
   * Email-to-issue ingest: regenerate the HMAC secret used by
   * `/api/ingest/email`. Rotating invalidates any outstanding
   * inbound integration that was pointing at the old secret. Admin
   * only; the new secret is returned once and then never echoed
   * back through `workspace.current` (it's stored but never selected
   * by the read paths). This proc returns the secret so the UI can
   * show it once and let the operator copy it.
   */
  rotateEmailIngestSecret: adminProcedure.mutation(async ({ ctx }) => {
    const secret = `feis_${randomToken(40)}`;
    await ctx.db.workspace.update({
      where: { id: ctx.workspaceId },
      data: { emailIngestSecret: secret },
    });
    return { secret };
  }),

  archive: adminProcedure.mutation(async ({ ctx }) => {
    if (ctx.membership.role !== Role.OWNER) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Only owners can archive a workspace." });
    }
    return ctx.db.workspace.update({
      where: { id: ctx.workspaceId },
      data: { deletedAt: new Date() },
    });
  }),

  delete: adminProcedure
    .input(z.object({ confirmName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role !== Role.OWNER) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only owners can delete a workspace." });
      }
      const ws = await ctx.db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { id: true, name: true },
      });
      if (input.confirmName !== ws.name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Confirmation name does not match workspace name.",
        });
      }
      // Drop the bucket + objects first while we still have the slug.
      // Swallow failures so a dead MinIO doesn't block a workspace delete.
      await deleteWorkspaceBucket(ctx.workspaceId).catch((err) => {
        console.warn(
          `[workspace.delete] bucket cleanup failed for ${ctx.workspaceId}:`,
          (err as Error).message,
        );
      });
      return ctx.db.workspace.delete({ where: { id: ctx.workspaceId } });
    }),

  /**
   * Roll-up stats for the workspace dashboard. Counts live rows + storage
   * quota snapshot. Everything scoped by `workspaceId`.
   */
  stats: workspaceProcedure.query(async ({ ctx }) => {
    const [issueCount, projectCount, cycleCount, memberCount, storage] = await Promise.all([
      ctx.db.issue.count({
        where: { workspaceId: ctx.workspaceId, deletedAt: null },
      }),
      ctx.db.project.count({
        where: { workspaceId: ctx.workspaceId, deletedAt: null },
      }),
      ctx.db.cycle.count({ where: { workspaceId: ctx.workspaceId } }),
      ctx.db.membership.count({ where: { workspaceId: ctx.workspaceId } }),
      workspaceQuotaStats(ctx.workspaceId).catch(() => ({
        usedBytes: 0,
        quotaBytes: 0,
      })),
    ]);
    return {
      issueCount,
      projectCount,
      cycleCount,
      memberCount,
      storageUsedBytes: storage.usedBytes,
      storageQuotaBytes: storage.quotaBytes,
    };
  }),

  me: workspaceProcedure.query(async ({ ctx }) => {
    const membership = await ctx.db.membership.findUniqueOrThrow({
      where: {
        userId_workspaceId: { userId: ctx.session.user.id, workspaceId: ctx.workspaceId },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            handle: true,
            timezone: true,
            locale: true,
            timeFormat: true,
            theme: true,
          },
        },
      },
    });
    return membership;
  }),

  updatePreferences: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80).optional(),
        handle: z
          .string()
          .min(2)
          .max(32)
          .regex(/^[a-z0-9_-]+$/i)
          .optional(),
        timezone: z.string().max(80).nullable().optional(),
        locale: z.string().max(16).nullable().optional(),
        timeFormat: z.enum(["12h", "24h"]).nullable().optional(),
        theme: z.enum(["light", "dark", "system"]).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: input,
        select: {
          id: true,
          name: true,
          email: true,
          handle: true,
          timezone: true,
          locale: true,
          timeFormat: true,
          theme: true,
        },
      });
    }),

  members: workspaceProcedure.query(async ({ ctx }) => {
    return ctx.db.membership.findMany({
      where: { workspaceId: ctx.workspaceId },
      include: {
        user: { select: { id: true, name: true, email: true, image: true, handle: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  }),

  /**
   * Issue a secure, expiring workspace invitation. Membership is not granted
   * until the recipient proves control of the invited email through sign-in.
   * A second invite for the same pending email is returned as a duplicate so
   * admins can choose the explicit resend action rather than silently rotating
   * a link the recipient may already be using.
   */
  invite: adminProcedure
    .input(
      z.object({
        email: z.string().email(),
        role: z.nativeEnum(Role).refine((role) => role !== Role.OWNER, {
          message: "Workspace ownership cannot be granted through an invitation.",
        }),
        note: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await enforceInvitationRateLimit(ctx.workspaceId, ctx.session.user.id, "send", 20, 3600);
      const email = input.email.trim().toLowerCase();
      await expireWorkspaceInvitations(ctx.workspaceId);

      const member = await ctx.db.membership.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          user: { email: { equals: email, mode: "insensitive" } },
        },
        select: { id: true },
      });
      if (member) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "That email already belongs to this workspace.",
        });
      }
      const duplicate = await ctx.db.workspaceInvitation.findFirst({
        where: { workspaceId: ctx.workspaceId, email, status: InvitationStatus.PENDING },
        orderBy: { createdAt: "desc" },
      });
      if (duplicate) return { outcome: "duplicate" as const, invitation: duplicate };

      const workspace = await ctx.db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { inviteExpiryHours: true },
      });
      const token = newInvitationToken();
      let invitation;
      try {
        invitation = await ctx.db.$transaction(async (tx) => {
          const created = await tx.workspaceInvitation.create({
            data: {
              workspaceId: ctx.workspaceId,
              email,
              role: input.role,
              note: input.note?.trim() || null,
              invitedById: ctx.session.user.id,
              tokenHash: invitationTokenHash(token),
              expiresAt: invitationExpiry(workspace.inviteExpiryHours),
            },
          });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "WorkspaceInvitation",
            entityId: created.id,
            action: "create",
            after: { email, role: created.role, expiresAt: created.expiresAt.toISOString() },
            eventKind: EventKind.INVITATION_CREATED,
            subjectType: "invitation",
            subjectId: created.id,
            payload: { email, role: created.role, expiresAt: created.expiresAt.toISOString() },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          return created;
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const raced = await ctx.db.workspaceInvitation.findFirst({
            where: { workspaceId: ctx.workspaceId, email, status: InvitationStatus.PENDING },
            orderBy: { createdAt: "desc" },
          });
          if (raced) return { outcome: "duplicate" as const, invitation: raced };
        }
        throw error;
      }
      try {
        await deliverWorkspaceInvitation({ invitationId: invitation.id, token });
      } catch (error) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: error instanceof Error ? error.message : "Invitation email delivery failed.",
          cause: error,
        });
      }
      return {
        outcome: "sent" as const,
        invitation: await ctx.db.workspaceInvitation.findUniqueOrThrow({
          where: { id: invitation.id },
        }),
      };
    }),

  listInvitations: adminProcedure.query(async ({ ctx }) => {
    await expireWorkspaceInvitations(ctx.workspaceId);
    const select = {
      id: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
      lastSentAt: true,
      sendCount: true,
      lastSendError: true,
      acceptedAt: true,
      revokedAt: true,
      createdAt: true,
      invitedBy: { select: { name: true, email: true } },
      acceptedBy: { select: { name: true, email: true } },
    } as const;
    const [pending, history] = await Promise.all([
      ctx.db.workspaceInvitation.findMany({
        where: { workspaceId: ctx.workspaceId, status: InvitationStatus.PENDING },
        orderBy: { createdAt: "desc" },
        select,
      }),
      ctx.db.workspaceInvitation.findMany({
        where: { workspaceId: ctx.workspaceId, status: { not: InvitationStatus.PENDING } },
        orderBy: { createdAt: "desc" },
        take: 100,
        select,
      }),
    ]);
    return [...pending, ...history];
  }),

  resendInvitation: adminProcedure
    .input(z.object({ invitationId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await enforceInvitationRateLimit(ctx.workspaceId, ctx.session.user.id, "resend", 10, 600);
      await expireWorkspaceInvitations(ctx.workspaceId);
      const existing = await ctx.db.workspaceInvitation.findFirst({
        where: { id: input.invitationId, workspaceId: ctx.workspaceId },
        include: { workspace: { select: { inviteExpiryHours: true } } },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Invitation not found." });
      if (existing.status !== InvitationStatus.PENDING) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Only pending invitations can be resent. This invitation is ${existing.status.toLowerCase()}.`,
        });
      }

      const lockAt = new Date();
      const staleLock = new Date(lockAt.getTime() - 5 * 60_000);
      const lock = await ctx.db.workspaceInvitation.updateMany({
        where: {
          id: existing.id,
          workspaceId: ctx.workspaceId,
          status: InvitationStatus.PENDING,
          OR: [{ deliveryLockAt: null }, { deliveryLockAt: { lt: staleLock } }],
        },
        data: { deliveryLockAt: lockAt, lastSendError: null },
      });
      if (lock.count !== 1) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This invitation is already being resent. Wait a moment and refresh.",
        });
      }

      const token = newInvitationToken();
      const expiresAt = invitationExpiry(existing.workspace.inviteExpiryHours);
      try {
        // Keep the currently-working token active until the provider accepts
        // the replacement message. A delivery failure therefore never burns
        // the old link. The delivery lock serializes concurrent resends.
        await deliverWorkspaceInvitation({
          invitationId: existing.id,
          token,
          expiresAt,
          trackDelivery: false,
        });
      } catch (error) {
        await ctx.db.workspaceInvitation.updateMany({
          where: { id: existing.id, deliveryLockAt: lockAt },
          data: {
            deliveryLockAt: null,
            lastSendError: (error instanceof Error
              ? error.message
              : "Invitation email delivery failed."
            ).slice(0, 2000),
          },
        });
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: error instanceof Error ? error.message : "Invitation email delivery failed.",
          cause: error,
        });
      }

      await ctx.db.$transaction(async (tx) => {
        const activated = await tx.workspaceInvitation.updateMany({
          where: {
            id: existing.id,
            workspaceId: ctx.workspaceId,
            status: InvitationStatus.PENDING,
            tokenHash: existing.tokenHash,
            deliveryLockAt: lockAt,
          },
          data: {
            tokenHash: invitationTokenHash(token),
            expiresAt,
            lastSentAt: new Date(),
            sendCount: { increment: 1 },
            lastSendError: null,
            deliveryLockAt: null,
          },
        });
        if (activated.count !== 1) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The invitation changed while the resend was in flight; the newer state was preserved.",
          });
        }
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "WorkspaceInvitation",
          entityId: existing.id,
          action: "resend",
          before: { expiresAt: existing.expiresAt.toISOString() },
          after: { expiresAt: expiresAt.toISOString() },
          eventKind: EventKind.INVITATION_RESENT,
          subjectType: "invitation",
          subjectId: existing.id,
          payload: { email: existing.email, expiresAt: expiresAt.toISOString() },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      });
      return ctx.db.workspaceInvitation.findUniqueOrThrow({ where: { id: existing.id } });
    }),

  revokeInvitation: adminProcedure
    .input(z.object({ invitationId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.workspaceInvitation.findFirst({
        where: { id: input.invitationId, workspaceId: ctx.workspaceId },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Invitation not found." });
      if (existing.status !== InvitationStatus.PENDING) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Only pending invitations can be revoked. This invitation is ${existing.status.toLowerCase()}.`,
        });
      }
      return ctx.db.$transaction(async (tx) => {
        // Claim the exact pending token generation. Acceptance and resend use
        // the same conditional boundary, so a late revoke can never overwrite
        // an accepted invitation or a newer token generation.
        const claimed = await tx.workspaceInvitation.updateMany({
          where: {
            id: existing.id,
            workspaceId: ctx.workspaceId,
            status: InvitationStatus.PENDING,
            tokenHash: existing.tokenHash,
          },
          data: {
            status: InvitationStatus.REVOKED,
            revokedAt: new Date(),
            deliveryLockAt: null,
          },
        });
        if (claimed.count !== 1) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The invitation changed before it could be revoked. Refresh to see its current state.",
          });
        }
        const revoked = await tx.workspaceInvitation.findUniqueOrThrow({
          where: { id: existing.id },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "WorkspaceInvitation",
          entityId: revoked.id,
          action: "revoke",
          before: { status: existing.status },
          after: { status: revoked.status },
          eventKind: EventKind.INVITATION_REVOKED,
          subjectType: "invitation",
          subjectId: revoked.id,
          payload: { email: revoked.email },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return revoked;
      });
    }),

  /**
   * Admin-only member roster for the workspace settings UI. Returns one
   * row per membership; every field maps 1:1 to a table cell. The caller's
   * own row is included so the UI can show "you" + disable self-demote.
   *
   * `lastActiveAt` is nullable — we don't currently track per-user
   * last-activity timestamps, so it's returned as null. Left in the shape
   * so we can backfill once the audit stream is tailed into a `User.lastActiveAt`
   * column without a client-side breaking change.
   */
  listMembers: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.membership.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { createdAt: "asc" },
      include: {
        user: {
          select: { id: true, email: true, name: true, handle: true, image: true },
        },
      },
    });
    return rows.map((m) => ({
      membershipId: m.id,
      userId: m.user.id,
      email: m.user.email,
      name: m.user.name,
      handle: m.user.handle,
      image: m.user.image,
      role: m.role,
      joinedAt: m.createdAt,
      lastActiveAt: null as Date | null,
    }));
  }),

  /**
   * Bind a user to this workspace by email. The email is the Authelia
   * binding key — on first login the bridge upserts a `User` row keyed by
   * this same email, so creating the `User` up-front (or reusing an
   * existing one) is safe.
   *
   * Idempotent: if a `Membership` already exists for this email, returns
   * the existing row unchanged (`created: false`, no role change). Use
   * `setMemberRole` to modify an existing member's role explicitly.
   */
  addMember: adminProcedure
    .input(z.object({ email: z.string().email(), role: z.nativeEnum(Role) }))
    .mutation(async ({ ctx, input }) => {
      const email = input.email.trim().toLowerCase();
      return ctx.db.$transaction(async (tx) => {
        // Find-or-create the user. Authelia owns identity at the edge, but
        // we can pre-create the shell so the membership exists the moment
        // admin adds them — first login will match on `email` and bind.
        const user = await tx.user.upsert({
          where: { email },
          update: {},
          create: { email },
          select: { id: true, email: true, name: true },
        });

        const existing = await tx.membership.findUnique({
          where: {
            userId_workspaceId: { userId: user.id, workspaceId: ctx.workspaceId },
          },
        });
        if (existing) {
          return {
            membershipId: existing.id,
            userId: user.id,
            email: user.email,
            role: existing.role,
            created: false,
          };
        }

        const membership = await tx.membership.create({
          data: {
            userId: user.id,
            workspaceId: ctx.workspaceId,
            role: input.role,
          },
        });

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Membership",
          entityId: membership.id,
          action: "create",
          after: { userId: user.id, role: membership.role, email: user.email },
          eventKind: EventKind.MEMBERSHIP_CREATED,
          subjectType: "membership",
          subjectId: membership.id,
          payload: { userId: user.id, email: user.email, role: membership.role },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return {
          membershipId: membership.id,
          userId: user.id,
          email: user.email,
          role: membership.role,
          created: true,
        };
      });
    }),

  /**
   * Change an existing member's role. Keyed on `userId` so the UI doesn't
   * need to thread opaque membership ids — admins think in people.
   *
   * Guards:
   *   - last-admin: cannot demote the only ADMIN/OWNER to a non-admin role.
   *     "Admin" here means OWNER ∪ ADMIN — either counts toward the last-admin
   *     quorum so you can't accidentally strand the workspace without
   *     management access.
   *   - self-demote: allowed only if another admin exists.
   */
  setMemberRole: adminProcedure
    .input(z.object({ userId: z.string().cuid(), role: z.nativeEnum(Role) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const target = await tx.membership.findUnique({
          where: {
            userId_workspaceId: {
              userId: input.userId,
              workspaceId: ctx.workspaceId,
            },
          },
        });
        if (!target) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "That user is not a member of this workspace.",
          });
        }
        if (target.role === input.role) {
          return { membershipId: target.id, userId: target.userId, role: target.role };
        }

        // Owner-only gate: only an OWNER may GRANT the owner role or CHANGE an
        // existing owner's role. Without this, a non-owner ADMIN could set its
        // own row to OWNER (the server accepted any `Role`) and then call
        // workspace.delete — making the OWNER-only archive/delete gate
        // meaningless. Ownership transfer stays an owner-initiated act.
        if (
          (input.role === Role.OWNER || target.role === Role.OWNER) &&
          ctx.membership.role !== Role.OWNER
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only an owner can assign or change the owner role.",
          });
        }

        const wasAdmin = target.role === Role.OWNER || target.role === Role.ADMIN;
        const willBeAdmin = input.role === Role.OWNER || input.role === Role.ADMIN;

        if (wasAdmin && !willBeAdmin) {
          const adminCount = await tx.membership.count({
            where: {
              workspaceId: ctx.workspaceId,
              role: { in: [Role.OWNER, Role.ADMIN] },
            },
          });
          if (adminCount <= 1) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Can't demote the last admin — promote another member to admin first.",
            });
          }
        }

        const updated = await tx.membership.update({
          where: { id: target.id },
          data: { role: input.role },
        });

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Membership",
          entityId: target.id,
          action: "role_change",
          before: { role: target.role },
          after: { role: updated.role },
          eventKind: EventKind.MEMBERSHIP_ROLE_CHANGED,
          subjectType: "membership",
          subjectId: target.id,
          payload: { userId: target.userId, from: target.role, to: updated.role },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return {
          membershipId: updated.id,
          userId: updated.userId,
          role: updated.role,
        };
      });
    }),

  /**
   * Remove a member from the workspace. Same last-admin guard as role
   * changes, plus an explicit self-removal block when the caller is the
   * last admin. The `User` row itself is preserved — they may still be a
   * member of other workspaces and Authelia may re-admit them elsewhere.
   */
  removeMember: adminProcedure
    .input(z.object({ userId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const target = await tx.membership.findUnique({
          where: {
            userId_workspaceId: {
              userId: input.userId,
              workspaceId: ctx.workspaceId,
            },
          },
          include: { user: { select: { email: true } } },
        });
        if (!target) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "That user is not a member of this workspace.",
          });
        }

        const isAdmin = target.role === Role.OWNER || target.role === Role.ADMIN;
        if (isAdmin) {
          const adminCount = await tx.membership.count({
            where: {
              workspaceId: ctx.workspaceId,
              role: { in: [Role.OWNER, Role.ADMIN] },
            },
          });
          if (adminCount <= 1) {
            const selfLast = target.userId === ctx.session.user.id;
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: selfLast
                ? "You're the last admin — promote another member before removing yourself."
                : "Can't remove the last admin — promote another member to admin first.",
            });
          }
        }

        await tx.membership.delete({ where: { id: target.id } });
        await tx.workspace.updateMany({
          where: {
            id: ctx.workspaceId,
            defaultIssueAssigneeUserId: target.userId,
          },
          data: {
            defaultIssueAssigneeMode: DefaultIssueAssigneeMode.NONE,
            defaultIssueAssigneeUserId: null,
          },
        });

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Membership",
          entityId: target.id,
          action: "delete",
          before: { userId: target.userId, role: target.role, email: target.user.email },
          eventKind: EventKind.MEMBERSHIP_REMOVED,
          subjectType: "membership",
          subjectId: target.id,
          payload: {
            userId: target.userId,
            email: target.user.email,
            role: target.role,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return {
          membershipId: target.id,
          userId: target.userId,
          removed: true,
        };
      });
    }),
});
