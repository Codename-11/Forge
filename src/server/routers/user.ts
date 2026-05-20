import { z } from "zod";
import { router, protectedProcedure } from "@/server/trpc";

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
  image: true,
  theme: true,
  timezone: true,
  locale: true,
  timeFormat: true,
  density: true,
  textSize: true,
  missionControlDefaultTab: true,
  onboardingDismissedAt: true,
  onboardingSkippedSteps: true,
  pomodoroEnabled: true,
  pomodoroMinutes: true,
  pomodoroBreakMinutes: true,
} as const;

// Today only "member" is opt-out-able. Keep the enum tight so we don't
// accept arbitrary step ids from the wire.
const SKIPPABLE_STEP = z.enum(["member"]);

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
        missionControlDefaultTab: z
          .enum(["live", "queue", "agents", "history", "chat"])
          .nullable()
          .optional(),
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
        resolved:
          membership?.missionControlDefaultTab ?? user?.missionControlDefaultTab ?? null,
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
});
