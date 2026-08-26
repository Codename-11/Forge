import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { CycleStatus, InstanceRole, Role, UserActionTokenType } from "@prisma/client";
import { router, instanceAdminProcedure } from "@/server/trpc";
import { ensureWorkspaceBucket } from "@/server/services/storage";
import { runtimeConfigStatus } from "@/server/services/runtime-config";
import { deriveRuntimeHealthStatus } from "@/server/services/runtime-status";
import { summarizeRuntimeSelfTest } from "@/server/services/runtime-self-test";
import { summarizeRuntimeInfo } from "@/server/services/runtime-info";
import { resolveSubjectLabels, subjectKey } from "@/server/services/subject-labels";
import { forgeBuildIdentity } from "@/server/build-info";
import {
  createInvitedUser,
  issueUserActionToken,
  reactivateUser,
  revokeUserSessions,
  setUserInstanceRole,
  softDeleteUser,
  suspendUser,
} from "@/server/services/user-lifecycle";
import { sendAccountSetupEmail, sendPasswordResetEmail } from "@/server/services/email";

function identityActionUrl(path: string): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.AUTH_URL?.trim();
  if (!configured) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Set NEXT_PUBLIC_APP_URL or AUTH_URL before sending account emails.",
    });
  }
  let origin: URL;
  try {
    origin = new URL(configured);
  } catch {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "NEXT_PUBLIC_APP_URL or AUTH_URL must be a valid absolute URL.",
    });
  }
  if (
    origin.protocol !== "https:" &&
    origin.hostname !== "localhost" &&
    origin.hostname !== "127.0.0.1"
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Account email links require HTTPS outside local development.",
    });
  }
  return new URL(path, `${origin.origin}/`).toString();
}

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

/**
 * Instance-admin surface for the `/admin` shell: tenants, users +
 * instance-role management, instance-wide runtimes, audit, and system
 * info. Every procedure is gated by `instanceAdminProcedure`
 * (User.instanceRole === INSTANCE_ADMIN, with ADMIN_EMAIL bootstrap
 * fallback). Distinct from the workspace `admin.*` observability router.
 * Part of the multi-workspace restructure.
 */

export const instanceAdminRouter = router({
  /** All tenants (non-deleted workspaces) with rollup stats. */
  tenants: instanceAdminProcedure.query(async ({ ctx }) => {
    const workspaces = await ctx.db.workspace.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        key: true,
        avatarUrl: true,
        createdAt: true,
        _count: { select: { memberships: true, issues: true } },
        memberships: {
          where: { role: "OWNER" },
          take: 1,
          select: { user: { select: { name: true, email: true } } },
        },
      },
    });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return Promise.all(
      workspaces.map(async (w) => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        key: w.key,
        avatarUrl: w.avatarUrl,
        createdAt: w.createdAt,
        members: w._count.memberships,
        issues: w._count.issues,
        owner: w.memberships[0]?.user ?? null,
        runsLast24: await ctx.db.agentRun.count({
          where: { workspaceId: w.id, startedAt: { gte: since } },
        }),
      })),
    );
  }),

  /** All users with instance role + workspace count. */
  users: instanceAdminProcedure.query(async ({ ctx }) => {
    const users = await ctx.db.user.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        handle: true,
        image: true,
        instanceRole: true,
        status: true,
        disabledAt: true,
        deletedAt: true,
        lastLoginAt: true,
        createdAt: true,
        localCredential: { select: { passwordChangedAt: true, mustChangePassword: true } },
        accounts: { select: { provider: true } },
        _count: { select: { memberships: true, sessions: true, apiKeys: true, connections: true } },
      },
    });
    return users.map(({ _count, accounts, localCredential, ...user }) => ({
      ...user,
      workspaces: _count.memberships,
      counts: {
        sessions: _count.sessions,
        apiKeys: _count.apiKeys,
        connections: _count.connections,
      },
      loginMethods: {
        password: Boolean(localCredential),
        providers: [...new Set(accounts.map((account) => account.provider))],
      },
    }));
  }),

  /** Full identity, access, and lifecycle detail for one user. */
  userDetail: instanceAdminProcedure
    .input(z.object({ userId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const user = await ctx.db.user.findUnique({
        where: { id: input.userId },
        select: {
          id: true,
          email: true,
          normalizedEmail: true,
          emailVerified: true,
          name: true,
          handle: true,
          image: true,
          instanceRole: true,
          status: true,
          authVersion: true,
          lastLoginAt: true,
          disabledAt: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
          localCredential: {
            select: {
              passwordChangedAt: true,
              mustChangePassword: true,
              failedAttempts: true,
              lastFailedAt: true,
              lockedUntil: true,
            },
          },
          accounts: {
            select: { id: true, provider: true, providerAccountId: true, type: true },
            orderBy: { provider: "asc" },
          },
          memberships: {
            select: {
              id: true,
              role: true,
              createdAt: true,
              workspace: { select: { id: true, slug: true, name: true, key: true } },
            },
            orderBy: { createdAt: "asc" },
          },
          connections: {
            select: {
              id: true,
              provider: true,
              label: true,
              account: true,
              status: true,
              scopes: true,
            },
            orderBy: { createdAt: "asc" },
          },
          instanceAuditTargets: {
            select: {
              id: true,
              action: true,
              metadata: true,
              ipAddress: true,
              userAgent: true,
              createdAt: true,
              actor: { select: { id: true, name: true, email: true } },
            },
            orderBy: { createdAt: "desc" },
            take: 50,
          },
          _count: { select: { sessions: true, apiKeys: true, actionTokens: true } },
        },
      });
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
      return user;
    }),

  /** Instance-scoped identity and authentication security audit. */
  identityAudit: instanceAdminProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(200).default(60),
        cursor: z.string().cuid().optional(),
        targetUserId: z.string().cuid().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.instanceAuditLog.findMany({
        where: input.targetUserId ? { targetUserId: input.targetUserId } : undefined,
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        cursor: input.cursor ? { id: input.cursor } : undefined,
        skip: input.cursor ? 1 : 0,
        select: {
          id: true,
          action: true,
          metadata: true,
          ipAddress: true,
          userAgent: true,
          createdAt: true,
          actor: { select: { id: true, name: true, email: true } },
          targetUser: { select: { id: true, name: true, email: true, status: true } },
        },
      });
      const nextCursor = rows.length > input.limit ? rows.pop()!.id : undefined;
      return { items: rows, nextCursor };
    }),

  /** Create an invited principal and return its one-time account setup token. */
  createUser: instanceAdminProcedure
    .input(
      z.object({
        email: z.string().email(),
        name: z.string().trim().min(1).max(80).optional(),
        instanceRole: z.nativeEnum(InstanceRole).default(InstanceRole.MEMBER),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const created = await createInvitedUser(ctx.db, {
        ...input,
        actorId: ctx.session.user.id,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      });
      const messageId = await sendAccountSetupEmail({
        to: created.user.email,
        name: created.user.name,
        url: identityActionUrl(`/activate/${encodeURIComponent(created.setupToken)}`),
        expiresAt: created.expiresAt,
      });
      return {
        user: created.user,
        delivery: { messageId, expiresAt: created.expiresAt },
      };
    }),

  issueSetupToken: instanceAdminProcedure
    .input(z.object({ userId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.user.findUnique({
        where: { id: input.userId },
        select: { email: true, name: true },
      });
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
      const issued = await issueUserActionToken(ctx.db, {
        ...input,
        type: UserActionTokenType.ACCOUNT_SETUP,
        actorId: ctx.session.user.id,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      });
      const messageId = await sendAccountSetupEmail({
        to: user.email,
        name: user.name,
        url: identityActionUrl(`/activate/${encodeURIComponent(issued.token)}`),
        expiresAt: issued.expiresAt,
      });
      return { delivery: { messageId, expiresAt: issued.expiresAt } };
    }),

  issuePasswordResetToken: instanceAdminProcedure
    .input(z.object({ userId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.user.findUnique({
        where: { id: input.userId },
        select: { email: true, name: true },
      });
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
      const issued = await issueUserActionToken(ctx.db, {
        ...input,
        type: UserActionTokenType.PASSWORD_RESET,
        actorId: ctx.session.user.id,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      });
      const messageId = await sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        url: identityActionUrl(`/reset-password/${encodeURIComponent(issued.token)}`),
        expiresAt: issued.expiresAt,
      });
      return { delivery: { messageId, expiresAt: issued.expiresAt } };
    }),

  suspendUser: instanceAdminProcedure
    .input(z.object({ userId: z.string().cuid(), reason: z.string().trim().max(500).optional() }))
    .mutation(({ ctx, input }) =>
      suspendUser(ctx.db, {
        ...input,
        actorId: ctx.session.user.id,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      }),
    ),

  reactivateUser: instanceAdminProcedure
    .input(z.object({ userId: z.string().cuid() }))
    .mutation(({ ctx, input }) =>
      reactivateUser(ctx.db, {
        ...input,
        actorId: ctx.session.user.id,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      }),
    ),

  revokeUserSessions: instanceAdminProcedure
    .input(z.object({ userId: z.string().cuid() }))
    .mutation(({ ctx, input }) =>
      revokeUserSessions(ctx.db, {
        ...input,
        actorId: ctx.session.user.id,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      }),
    ),

  deleteUser: instanceAdminProcedure
    .input(z.object({ userId: z.string().cuid(), reason: z.string().trim().max(500).optional() }))
    .mutation(({ ctx, input }) =>
      softDeleteUser(ctx.db, {
        ...input,
        actorId: ctx.session.user.id,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      }),
    ),

  /** Promote / demote a user's instance role. Cannot demote the last admin. */
  setInstanceRole: instanceAdminProcedure
    .input(z.object({ userId: z.string().cuid(), role: z.nativeEnum(InstanceRole) }))
    .mutation(({ ctx, input }) =>
      setUserInstanceRole(ctx.db, {
        ...input,
        actorId: ctx.session.user.id,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      }),
    ),

  /** Every runtime across the instance (not just the caller's). */
  runtimes: instanceAdminProcedure.query(async ({ ctx }) => {
    const runtimes = await ctx.db.runtime.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        kind: true,
        adapterKey: true,
        heartbeatAt: true,
        lastProbeAt: true,
        lastProbeAttempted: true,
        lastProbeReachable: true,
        lastProbeDetail: true,
        runtimeInfo: true,
        lastInfoAt: true,
        lastSelfTestAt: true,
        lastSelfTestStatus: true,
        lastSelfTestDetail: true,
        lastSelfTestDurationMs: true,
        connectedAt: true,
        endpoint: true,
        config: true,
        disabledAt: true,
        archivedAt: true,
        instanceShared: true,
        createdAt: true,
        owner: { select: { id: true, name: true, email: true } },
        _count: { select: { agents: true } },
      },
    });
    return runtimes.map((r) => {
      const health = deriveRuntimeHealthStatus(r);
      return {
        ...r,
        health,
        selfTest: summarizeRuntimeSelfTest(r),
        runtimeInfoSummary: summarizeRuntimeInfo(r),
        configStatus: runtimeConfigStatus(r.adapterKey, r.config),
        online: health.kind === "online",
        boundAgents: r._count.agents,
      };
    });
  }),

  /** Cross-workspace audit feed for the instance audit page. */
  audit: instanceAdminProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(200).default(60),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.activityEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        cursor: input.cursor ? { id: input.cursor } : undefined,
        skip: input.cursor ? 1 : 0,
        select: {
          id: true,
          kind: true,
          subjectType: true,
          subjectId: true,
          createdAt: true,
          actor: { select: { id: true, name: true, image: true } },
          workspace: { select: { id: true, slug: true, key: true, name: true } },
        },
      });
      let nextCursor: string | undefined;
      if (rows.length > input.limit) nextCursor = rows.pop()!.id;
      // Resolve subject ids to names. Cross-tenant view → no workspace scope
      // (cuids are globally unique).
      const labels = await resolveSubjectLabels(
        ctx.db,
        rows.map((r) => ({ subjectType: r.subjectType, subjectId: r.subjectId })),
      );
      const items = rows.map((r) => ({
        ...r,
        subjectLabel: labels.get(subjectKey(r.subjectType, r.subjectId)) ?? null,
      }));
      return { items, nextCursor };
    }),

  /** System / build info + instance-wide counts for the admin overview. */
  system: instanceAdminProcedure.query(async ({ ctx }) => {
    const [build, tenants, users, admins, runtimes, profiles, connections, runs24] =
      await Promise.all([
        forgeBuildIdentity(),
        ctx.db.workspace.count({ where: { deletedAt: null } }),
        ctx.db.user.count(),
        ctx.db.user.count({ where: { instanceRole: "INSTANCE_ADMIN" } }),
        ctx.db.runtime.count({ where: { archivedAt: null } }),
        ctx.db.agentProfile.count({ where: { archivedAt: null } }),
        ctx.db.connection.count(),
        ctx.db.agentRun.count({
          where: { startedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        }),
      ]);
    return {
      version: build.version,
      buildSha: build.gitSha,
      buildTime: build.buildTime,
      counts: { tenants, users, admins, runtimes, profiles, connections, runs24 },
    };
  }),

  /**
   * Create a workspace as an instance admin. Mirrors `workspace.create`
   * (seeded statuses / labels / Cycle 1, best-effort bucket) but the
   * binding is set from the instance-admin surface: the caller becomes
   * OWNER of the new tenant so they can manage it immediately.
   */
  createTenant: instanceAdminProcedure
    .input(
      z.object({
        slug: slugSchema,
        name: z.string().min(1).max(80),
        key: keySchema,
        cycleLengthDays: z.number().int().min(1).max(90).optional(),
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

      const workspace = await ctx.db.workspace.create({
        data: {
          slug: input.slug,
          name: input.name,
          key: input.key,
          cycleLengthDays,
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
        select: { id: true, slug: true, name: true, key: true },
      });

      // Best-effort bucket create — a dead MinIO shouldn't block the tenant.
      await ensureWorkspaceBucket(workspace.id).catch((err) => {
        console.warn(
          `[instanceAdmin.createTenant] ensureWorkspaceBucket failed for ${workspace.slug}:`,
          (err as Error).message,
        );
      });

      return workspace;
    }),

  /** Compatibility alias used by the existing invite dialog. New callers use
   * `createUser`; both create an INVITED principal and deliver setup by email.
   */
  inviteUser: instanceAdminProcedure
    .input(
      z.object({
        email: z.string().email(),
        name: z.string().min(1).max(80).optional(),
        instanceAdmin: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const created = await createInvitedUser(ctx.db, {
        email: input.email,
        name: input.name,
        instanceRole: input.instanceAdmin ? InstanceRole.INSTANCE_ADMIN : InstanceRole.MEMBER,
        actorId: ctx.session.user.id,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      });
      const messageId = await sendAccountSetupEmail({
        to: created.user.email,
        name: created.user.name,
        url: identityActionUrl(`/activate/${encodeURIComponent(created.setupToken)}`),
        expiresAt: created.expiresAt,
      });
      return {
        ...created.user,
        created: true,
        delivery: { messageId, expiresAt: created.expiresAt },
      };
    }),

  /**
   * Trigger an instance backup. This deployment has no backup job wired
   * up yet, so this is a best-effort acknowledgement: it records the
   * intent and returns `{ scheduled: true, note }` for the UI. It does
   * NOT shell out to pg_dump — durable backups are an ops concern
   * (volume snapshots / managed Postgres), surfaced here for operators.
   */
  backup: instanceAdminProcedure.mutation(async () => {
    return {
      scheduled: true as const,
      at: new Date(),
      note: "No backup job is wired up in this deployment yet — backups are handled at the infrastructure layer (volume snapshots / managed Postgres). Logged the request.",
    };
  }),

  /**
   * Dry-run preview of a cross-workspace issue move (audit ask #2). Read-only:
   * returns the full remap plan (renumber, status/label remap, nulled FKs,
   * dropped relations, blocked-issue reasons, attachment quota delta) so the
   * operator sees every integrity consequence before any row is mutated.
   * Instance-admin gated because it references two tenants at once — a
   * per-workspace adminProcedure is pinned to a single ctx.workspaceId.
   */
  previewIssueMove: instanceAdminProcedure
    .input(
      z.object({
        sourceWorkspaceId: z.string().cuid(),
        targetWorkspaceId: z.string().cuid(),
        issueIds: z.array(z.string().cuid()).min(1).max(500),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { planIssueMove } = await import("@/server/services/cross-workspace-move");
      return planIssueMove(ctx.db, input);
    }),

  /**
   * Execute the move for the plan's movable issues in one transaction, writing
   * MOVE audit events in both workspaces. Blocked (entangled) issues are
   * skipped and returned so the caller can surface them.
   */
  moveIssues: instanceAdminProcedure
    .input(
      z.object({
        sourceWorkspaceId: z.string().cuid(),
        targetWorkspaceId: z.string().cuid(),
        issueIds: z.array(z.string().cuid()).min(1).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { executeIssueMove } = await import("@/server/services/cross-workspace-move");
      return executeIssueMove(ctx.db, {
        ...input,
        actorId: ctx.session.user.id,
      });
    }),
});
