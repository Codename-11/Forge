-- Server-persisted onboarding state. `onboardingDismissedAt` is a
-- one-shot "I'm done" flag that hides the OnboardingCard across every
-- device the user signs into. `onboardingSkippedSteps` carries the
-- ids of steps the user explicitly opted out of (today: just
-- "member" — single-user workspaces shouldn't be perpetually nagged
-- to invite a teammate).
--
-- Both are nullable / default-empty; existing rows simply read as
-- "not dismissed, nothing skipped".
ALTER TABLE "User" ADD COLUMN "onboardingDismissedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "onboardingSkippedSteps" TEXT[] DEFAULT ARRAY[]::TEXT[];
