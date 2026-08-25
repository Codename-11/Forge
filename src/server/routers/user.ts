import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, workspaceProcedure } from "@/server/trpc";
import { refreshTodayZone } from "@/server/services/today-zone";
import { getInstanceAuthPolicy } from "@/server/services/auth-policy";
import { hashPassword, verifyPassword } from "@/server/services/local-credentials";
import { sendPasswordChangedEmail } from "@/server/services/email";
import { providerIdFor } from "@/server/sso";

/**
 * Account-level user router.
 *
 * Sibling to `workspace.me` / `workspace.updatePreferences`, but lives
 * outside any tenant scope — the appearance prefs (density, textSize)
 * follow the user across every workspace, so the AppearanceProvider in
 * the workspace shell needs a query that doesn't depend on a slug.
 *
 * Stays narrow on purpose: just the fields the shell + appearance
 * settings page actually read/write. Anything broader belongs on
 * `workspace.me` / `workspace.updatePreferences`.
 */

const ME_SELECT = {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
  image: true,
  status: true,
  lastLoginAt: true,
  theme: true,
  timezone: true,
  locale: true,
  timeFormat: true,
  density: true,
  textSize: true,
  motion: true,
  backgroundStyle: true,
  missionControlDefaultTab: true,
  dashboardView: true,
  dashboardPrefs: true,
  changelogSeenAt: true,
  changelogSeenRelease: true,
  onboardingDismissedAt: true,
  onboardingSkippedSteps: true,
  pomodoroEnabled: true,
  pomodoroMinutes: true,
  pomodoroBreakMinutes: true,
} as const;

/**
 * Per-user dashboard layout. `order` is the widget-id sequence for the
 * customizable main stack; `collapsed` / `hidden` are widget-id sets.
 * Unknown ids are tolerated (the client intersects against its live
 * widget registry), so a removed widget id just lingers harmlessly.
 */
const DASHBOARD_PREFS = z.object({
  // Incremented when the default composition changes structurally. The
  // client can then migrate stale order/width overrides once without a DB
  // migration because this preference object already lives in JSON.
  version: z.number().int().min(1).max(10).optional(),
  order: z.array(z.string()).max(64).default([]),
  collapsed: z.array(z.string()).max(64).default([]),
  hidden: z.array(z.string()).max(64).default([]),
  // Per-widget column width on the 2-col customize grid. Absent ids fall
  // back to the widget's registry default. Tolerant of unknown ids like
  // the order/hidden sets.
  widths: z.record(z.string(), z.enum(["half", "full"])).optional(),
});

// Today only "member" is opt-out-able. Keep the enum tight so we don't
// accept arbitrary step ids from the wire.
const SKIPPABLE_STEP = z.enum(["member"]);

function usableProviderKeys(
  providers: Array<{ id: string; type: "OIDC" | "GITHUB" | "GOOGLE" }>,
): Set<string> {
  return new Set(providers.map((provider) => providerIdFor(provider)));
}

export const userRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.user.findUniqueOrThrow({
      where: { id: ctx.session.user.id },
      select: ME_SELECT,
    });
  }),

  updateAppearance: protectedProcedure
    .input(
      z.object({
        density: z.enum(["compact", "comfortable"]).nullable().optional(),
        textSize: z.enum(["default", "larger"]).nullable().optional(),
        motion: z.enum(["full", "reduced"]).nullable().optional(),
        backgroundStyle: z
          .enum(["grid", "glow", "dots", "reactive", "particles", "none"])
          .nullable()
          .optional(),
        theme: z.enum(["light", "dark", "system"]).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: input,
        select: ME_SELECT,
      });
    }),

  security: protectedProcedure.query(async ({ ctx }) => {
    const [user, policy, providers] = await Promise.all([
      ctx.db.user.findUniqueOrThrow({
        where: { id: ctx.session.user.id },
        select: {
          id: true,
          email: true,
          emailVerified: true,
          status: true,
          authVersion: true,
          lastLoginAt: true,
          localCredential: {
            select: {
              passwordChangedAt: true,
              mustChangePassword: true,
              lastUsedAt: true,
              lockedUntil: true,
            },
          },
          accounts: {
            select: { id: true, provider: true, providerAccountId: true, type: true },
            orderBy: { provider: "asc" },
          },
        },
      }),
      getInstanceAuthPolicy(ctx.db),
      ctx.db.ssoProvider.findMany({
        where: { enabled: true, archivedAt: null },
        select: { id: true, type: true, name: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
    ]);
    return { user, policy, providers };
  }),

  setPassword: protectedProcedure
    .input(
      z.object({
        currentPassword: z.string().max(4096).optional(),
        newPassword: z.string().min(8).max(4096),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [policy, user] = await Promise.all([
        getInstanceAuthPolicy(ctx.db),
        ctx.db.user.findUniqueOrThrow({
          where: { id: ctx.session.user.id },
          include: { localCredential: true },
        }),
      ]);
      if (input.newPassword.length < policy.passwordMinLength) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Password must be at least ${policy.passwordMinLength} characters.`,
        });
      }
      if (user.localCredential) {
        if (!input.currentPassword) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Current password is required." });
        }
        if (!(await verifyPassword(input.currentPassword, user.localCredential.passwordHash))) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Current password is incorrect." });
        }
      }
      const passwordHash = await hashPassword(input.newPassword);
      const changedAt = new Date();
      await ctx.db.$transaction(async (tx) => {
        await tx.localCredential.upsert({
          where: { userId: user.id },
          update: {
            passwordHash,
            passwordChangedAt: changedAt,
            mustChangePassword: false,
            failedAttempts: 0,
            lastFailedAt: null,
            lockedUntil: null,
          },
          create: { userId: user.id, passwordHash, passwordChangedAt: changedAt },
        });
        await tx.user.update({
          where: { id: user.id },
          data: { authVersion: { increment: 1 }, status: "ACTIVE", disabledAt: null },
        });
        await tx.session.deleteMany({ where: { userId: user.id } });
        await tx.userActionToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: changedAt },
        });
        await tx.instanceAuditLog.create({
          data: {
            actorId: user.id,
            targetUserId: user.id,
            action: user.localCredential ? "PASSWORD_CHANGED" : "PASSWORD_ADDED",
            ipAddress: ctx.ip,
            userAgent: ctx.userAgent,
          },
        });
      });
      void sendPasswordChangedEmail({
        to: user.email,
        name: user.name,
        changedAt,
      }).catch(() => undefined);
      return { ok: true, sessionsRevoked: true };
    }),

  removePassword: protectedProcedure
    .input(z.object({ currentPassword: z.string().min(1).max(4096) }))
    .mutation(async ({ ctx, input }) => {
      const [policy, user, providers] = await Promise.all([
        getInstanceAuthPolicy(ctx.db),
        ctx.db.user.findUniqueOrThrow({
          where: { id: ctx.session.user.id },
          include: {
            localCredential: true,
            accounts: { select: { id: true, provider: true } },
          },
        }),
        ctx.db.ssoProvider.findMany({
          where: { enabled: true, archivedAt: null },
          select: { id: true, type: true },
        }),
      ]);
      if (policy.mode === "LOCAL_ONLY") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "A password is required while this instance uses local-only authentication.",
        });
      }
      if (!user.localCredential) return { ok: true };
      const enabledProviders = usableProviderKeys(providers);
      if (!user.accounts.some((account) => enabledProviders.has(account.provider))) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Link an enabled external sign-in method before removing your password.",
        });
      }
      if (!(await verifyPassword(input.currentPassword, user.localCredential.passwordHash))) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Current password is incorrect." });
      }
      await ctx.db.$transaction(async (tx) => {
        await tx.localCredential.delete({ where: { userId: user.id } });
        await tx.user.update({ where: { id: user.id }, data: { authVersion: { increment: 1 } } });
        await tx.session.deleteMany({ where: { userId: user.id } });
        await tx.instanceAuditLog.create({
          data: {
            actorId: user.id,
            targetUserId: user.id,
            action: "PASSWORD_REMOVED",
            ipAddress: ctx.ip,
            userAgent: ctx.userAgent,
          },
        });
      });
      return { ok: true, sessionsRevoked: true };
    }),

  unlinkIdentity: protectedProcedure
    .input(z.object({ accountId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const [policy, user, providers] = await Promise.all([
        getInstanceAuthPolicy(ctx.db),
        ctx.db.user.findUniqueOrThrow({
          where: { id: ctx.session.user.id },
          include: { localCredential: { select: { userId: true } }, accounts: true },
        }),
        ctx.db.ssoProvider.findMany({
          where: { enabled: true, archivedAt: null },
          select: { id: true, type: true },
        }),
      ]);
      const account = user.accounts.find((candidate) => candidate.id === input.accountId);
      if (!account) throw new TRPCError({ code: "NOT_FOUND" });
      const enabledProviders = usableProviderKeys(providers);
      const remainingExternal = user.accounts.filter(
        (candidate) => candidate.id !== account.id && enabledProviders.has(candidate.provider),
      ).length;
      const remainingMethods =
        (user.localCredential && policy.mode !== "EXTERNAL_ONLY" ? 1 : 0) +
        (policy.mode !== "LOCAL_ONLY" ? remainingExternal : 0);
      if (remainingMethods < 1) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "You cannot remove your final sign-in method.",
        });
      }
      await ctx.db.$transaction(async (tx) => {
        await tx.account.delete({ where: { id: account.id } });
        await tx.user.update({ where: { id: user.id }, data: { authVersion: { increment: 1 } } });
        await tx.session.deleteMany({ where: { userId: user.id } });
        await tx.instanceAuditLog.create({
          data: {
            actorId: user.id,
            targetUserId: user.id,
            action: "LOGIN_IDENTITY_UNLINKED",
            metadata: { provider: account.provider },
            ipAddress: ctx.ip,
            userAgent: ctx.userAgent,
          },
        });
      });
      return { ok: true, sessionsRevoked: true };
    }),

  revokeSessions: protectedProcedure.mutation(async ({ ctx }) => {
    const user = await ctx.db.user.update({
      where: { id: ctx.session.user.id },
      data: { authVersion: { increment: 1 } },
      select: { id: true, authVersion: true },
    });
    await ctx.db.session.deleteMany({ where: { userId: user.id } });
    await ctx.db.instanceAuditLog.create({
      data: {
        actorId: user.id,
        targetUserId: user.id,
        action: "SESSIONS_REVOKED",
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });
    return { ok: true, authVersion: user.authVersion };
  }),

  setDashboardView: protectedProcedure
    .input(z.object({ view: z.enum(["list", "canvas"]).nullable() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { dashboardView: input.view },
        select: ME_SELECT,
      });
    }),

  /** Persist the user's dashboard layout (widget order + collapsed/hidden). */
  setDashboardPrefs: protectedProcedure.input(DASHBOARD_PREFS).mutation(async ({ ctx, input }) => {
    return ctx.db.user.update({
      where: { id: ctx.session.user.id },
      data: { dashboardPrefs: input },
      select: ME_SELECT,
    });
  }),

  /** Persist the exact release viewed so same-day releases remain distinguishable. */
  markChangelogSeen: protectedProcedure
    .input(z.object({ releaseId: z.string().trim().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { changelogSeenAt: new Date(), changelogSeenRelease: input.releaseId },
        select: ME_SELECT,
      });
    }),

  /**
   * Per-user Mission Control preferences. Default-tab can be either
   * global (User-scoped) or per-workspace (Membership-scoped, when a
   * `workspaceId` is provided). Membership values win over the
   * User-global value when both are set; null clears whichever scope
   * was targeted.
   */
  updateMissionControlPrefs: protectedProcedure
    .input(
      z.object({
        missionControlDefaultTab: z.enum(["live", "queue", "agents", "chat"]).nullable().optional(),
        /**
         * Optional workspace scope. When supplied, the pref is
         * written to the caller's Membership row in that workspace
         * (per-workspace override). When omitted, the pref is
         * written to the global User row.
         */
        workspaceId: z.string().cuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.workspaceId) {
        // Per-workspace override. Confirm membership exists, then
        // patch missionControlDefaultTab on that row.
        const m = await ctx.db.membership.findFirst({
          where: { userId: ctx.session.user.id, workspaceId: input.workspaceId },
          select: { id: true },
        });
        if (!m) {
          throw new Error("Not a member of that workspace.");
        }
        await ctx.db.membership.update({
          where: { id: m.id },
          data: {
            missionControlDefaultTab:
              input.missionControlDefaultTab === undefined
                ? undefined
                : input.missionControlDefaultTab,
          },
        });
      } else {
        await ctx.db.user.update({
          where: { id: ctx.session.user.id },
          data: {
            missionControlDefaultTab:
              input.missionControlDefaultTab === undefined
                ? undefined
                : input.missionControlDefaultTab,
          },
        });
      }
      return ctx.db.user.findUniqueOrThrow({
        where: { id: ctx.session.user.id },
        select: ME_SELECT,
      });
    }),

  /**
   * Returns the resolved Mission Control default tab for the caller
   * in the given workspace: Membership override → User global → null
   * (caller falls back to "live"). Cheap to call on every Mission
   * Control mount.
   */
  missionControlDefaultTabFor: protectedProcedure
    .input(z.object({ workspaceId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const [user, membership] = await Promise.all([
        ctx.db.user.findUnique({
          where: { id: ctx.session.user.id },
          select: { missionControlDefaultTab: true },
        }),
        ctx.db.membership.findFirst({
          where: { userId: ctx.session.user.id, workspaceId: input.workspaceId },
          select: { missionControlDefaultTab: true },
        }),
      ]);
      return {
        resolved: membership?.missionControlDefaultTab ?? user?.missionControlDefaultTab ?? null,
        membership: membership?.missionControlDefaultTab ?? null,
        user: user?.missionControlDefaultTab ?? null,
      };
    }),

  dismissOnboarding: protectedProcedure.mutation(async ({ ctx }) => {
    return ctx.db.user.update({
      where: { id: ctx.session.user.id },
      data: { onboardingDismissedAt: new Date() },
      select: ME_SELECT,
    });
  }),

  resumeOnboarding: protectedProcedure.mutation(async ({ ctx }) => {
    return ctx.db.user.update({
      where: { id: ctx.session.user.id },
      data: { onboardingDismissedAt: null },
      select: ME_SELECT,
    });
  }),

  skipOnboardingStep: protectedProcedure
    .input(z.object({ stepId: SKIPPABLE_STEP }))
    .mutation(async ({ ctx, input }) => {
      const current = await ctx.db.user.findUniqueOrThrow({
        where: { id: ctx.session.user.id },
        select: { onboardingSkippedSteps: true },
      });
      if (current.onboardingSkippedSteps.includes(input.stepId)) {
        return ctx.db.user.findUniqueOrThrow({
          where: { id: ctx.session.user.id },
          select: ME_SELECT,
        });
      }
      return ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: {
          onboardingSkippedSteps: {
            push: input.stepId,
          },
        },
        select: ME_SELECT,
      });
    }),

  unskipOnboardingStep: protectedProcedure
    .input(z.object({ stepId: SKIPPABLE_STEP }))
    .mutation(async ({ ctx, input }) => {
      const current = await ctx.db.user.findUniqueOrThrow({
        where: { id: ctx.session.user.id },
        select: { onboardingSkippedSteps: true },
      });
      const next = current.onboardingSkippedSteps.filter((s) => s !== input.stepId);
      return ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { onboardingSkippedSteps: { set: next } },
        select: ME_SELECT,
      });
    }),

  /**
   * Per-user pomodoro prefs. The time-tracker widget consults these
   * each time a timer starts to decide whether to schedule a "break"
   * toast and at what cadence. Off by default. The toast is just a
   * prompt — it never pauses or stops the timer. Durations are
   * clamped 1..120 to keep the schedule reasonable.
   */
  updatePomodoro: protectedProcedure
    .input(
      z.object({
        pomodoroEnabled: z.boolean().optional(),
        pomodoroMinutes: z.number().int().min(1).max(120).optional(),
        pomodoroBreakMinutes: z.number().int().min(1).max(120).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: input,
        select: ME_SELECT,
      });
    }),

  /**
   * Narrow "card-shape" summary used by the `@handle` hover preview.
   *
   * Looks up a workspace member by either `id` or `handle`. The mention
   * regex captures both `@agentProfileKey` and `@userHandle` — the
   * client tries `agent.summary` first, then falls back here when the
   * agent lookup 404s. Cross-tenant resolves return NOT_FOUND.
   *
   * Activity count = `ActivityEvent` rows authored by this user in the
   * current workspace over the last 7 days. Cheap (indexed `actorId +
   * createdAt`) but capped via `count` so a heavy user doesn't drag
   * the popover. Workspace role comes from the matching Membership.
   */
  summary: workspaceProcedure
    .input(
      z
        .object({
          id: z.string().cuid().optional(),
          handle: z
            .string()
            .min(1)
            .max(40)
            .regex(/^[a-z0-9][a-z0-9_-]*$/i)
            .optional(),
        })
        .refine((v) => v.id || v.handle, {
          message: "Provide id or handle.",
        }),
    )
    .query(async ({ ctx, input }) => {
      const user = await ctx.db.user.findFirst({
        where: {
          ...(input.id ? { id: input.id } : {}),
          ...(input.handle ? { handle: input.handle.toLowerCase() } : {}),
          memberships: { some: { workspaceId: ctx.workspaceId } },
        },
        select: {
          id: true,
          name: true,
          handle: true,
          image: true,
          memberships: {
            where: { workspaceId: ctx.workspaceId },
            select: { role: true },
            take: 1,
          },
        },
      });
      if (!user) throw new TRPCError({ code: "NOT_FOUND" });
      const since = new Date(Date.now() - 7 * 86_400_000);
      const recentActivity = await ctx.db.activityEvent.count({
        where: {
          workspaceId: ctx.workspaceId,
          actorId: user.id,
          createdAt: { gte: since },
        },
      });
      return {
        id: user.id,
        name: user.name,
        handle: user.handle,
        image: user.image,
        role: user.memberships[0]?.role ?? null,
        recentActivity,
      };
    }),

  /**
   * Return (auto-provisioning if needed) the viewer's Personal canvas
   * for the active workspace. Each user gets exactly one PERSONAL
   * canvas per workspace — the unique key on
   * (workspaceId, kind, ownerUserId) enforces this. Cheap to call on
   * every dashboard load; the create branch only fires once per user.
   */
  personalCanvas: workspaceProcedure.query(async ({ ctx }) => {
    const existing = await ctx.db.workspaceCanvas.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        kind: "PERSONAL",
        ownerUserId: ctx.session.user.id,
        archivedAt: null,
      },
      select: { id: true, name: true, kind: true, activePageId: true },
    });
    let canvas = existing;
    if (!canvas) {
      const me = await ctx.db.user.findUniqueOrThrow({
        where: { id: ctx.session.user.id },
        select: { name: true, email: true },
      });
      const label = me.name?.trim() || me.email.split("@")[0] || "Personal";
      canvas = await ctx.db.workspaceCanvas.create({
        data: {
          workspaceId: ctx.workspaceId,
          kind: "PERSONAL",
          ownerUserId: ctx.session.user.id,
          createdById: ctx.session.user.id,
          name: `${label}'s workspace`,
        },
        select: { id: true, name: true, kind: true, activePageId: true },
      });
    }
    // Refresh the locked Today zone on every fetch — cheap (handful of
    // writes) and keeps the strip current without a background job.
    await refreshTodayZone(ctx.db, ctx.workspaceId, ctx.session.user.id, canvas.id);
    return canvas;
  }),
});
