import { z } from "zod";
import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  CycleStatus,
  EngagementMode,
  EventKind,
  MentionEngagementPolicy,
  Role,
} from "@prisma/client";
import { router, protectedProcedure, workspaceProcedure, adminProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";

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
        cycleLengthDays: true,
        cycleCooldownDays: true,
        timeTrackingEnabled: true,
        attachmentQuotaMb: true,
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
        startedStatusId: true,
        stalledThresholdDays: true,
        agentHeartbeatWarnMinutes: true,
        agentHeartbeatCriticalMinutes: true,
        assignmentEngagementMode: true,
        mentionEngagementPolicy: true,
        mentionDefaultMode: true,
        emailIngestEnabled: true,
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
        cycleLengthDays: z.number().int().min(1).max(90).optional(),
        timeTrackingEnabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.workspace.findFirst({
        where: { OR: [{ slug: input.slug }, { key: input.key }] },
      });
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "Slug or key in use." });

      const cycleLengthDays = input.cycleLengthDays ?? 7;
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
          cycleLengthDays,
          timeTrackingEnabled: input.timeTrackingEnabled ?? false,
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
            create: [
              { name: "bug", color: "#b45309" },
              { name: "feature", color: "#d97706" },
              { name: "chore", color: "#78716c" },
              { name: "docs", color: "#0d9488" },
              { name: "quick-win", color: "#65a30d" },
            ],
          },
          cycles: {
            create: [
              {
                name: "Cycle 1",
                startsAt: now,
                endsAt: cycleEndsAt,
                lengthDays: cycleLengthDays,
                status: CycleStatus.ACTIVE,
              },
            ],
          },
        },
      });

      // Best-effort bucket create. If MinIO is unavailable we still return
      // the workspace — attachments simply won't work until ops fixes it.
      await ensureWorkspaceBucket(workspace.id).catch((err) => {
        console.warn(
          `[workspace.create] ensureWorkspaceBucket failed for ${workspace.slug}:`,
          (err as Error).message,
        );
      });

      return workspace;
    }),

  // Mutations below are the minimum surface required by the workspace
  // settings UI shipped in Phase 2E. Agent C owns the fuller workspace
  // router overhaul — keep any extensions here tight and additive.
  update: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80).optional(),
        avatarUrl: z.string().url().max(512).nullable().optional(),
        cycleLengthDays: z.number().int().min(1).max(90).optional(),
        cycleCooldownDays: z.number().int().min(0).max(30).optional(),
        timeTrackingEnabled: z.boolean().optional(),
        attachmentQuotaMb: z.number().int().min(0).max(1_024_000).optional(),
        agentIdleTimeoutMinutes: z.number().int().min(0).max(1440).optional(),
        assignmentSlaMinutes: z.number().int().min(0).max(10080).optional(),
        agentRunStaleMinutes: z.number().int().min(0).max(10080).optional(),
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
        assignmentEngagementMode: z.nativeEnum(EngagementMode).optional(),
        mentionEngagementPolicy: z.nativeEnum(MentionEngagementPolicy).optional(),
        mentionDefaultMode: z.nativeEnum(EngagementMode).optional(),
        emailIngestEnabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
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
            message:
              "startedStatusId must point at an IN_PROGRESS-category status.",
          });
        }
      }
      return ctx.db.workspace.update({
        where: { id: ctx.workspaceId },
        data: input,
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
    const [issueCount, projectCount, cycleCount, memberCount, storage] =
      await Promise.all([
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
   * Self-service email invites are disabled in this deployment — Authelia
   * owns identity and the `/api/auth/authelia-bridge` upserts the `User`
   * row on first login. Admin-gated member management replaces the flow:
   * use `workspace.addMember` / `workspace.setMemberRole` / `workspace.removeMember`.
   *
   * Kept as a stub (rather than deleted) so old clients get a crisp error
   * instead of `NOT_FOUND`. Safe to delete once no callers remain.
   */
  invite: adminProcedure
    .input(z.object({ email: z.string().email(), role: z.nativeEnum(Role) }))
    .mutation(() => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Self-service invites are disabled — use admin member management (workspace.addMember).",
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
              message:
                "Can't demote the last admin — promote another member to admin first.",
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
