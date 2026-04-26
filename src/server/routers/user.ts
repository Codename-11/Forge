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
  onboardingDismissedAt: true,
  onboardingSkippedSteps: true,
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
});
