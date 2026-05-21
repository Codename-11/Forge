-- Per-user dashboard customization + changelog-seen tracking.
ALTER TABLE "User" ADD COLUMN "dashboardPrefs" JSONB;
ALTER TABLE "User" ADD COLUMN "changelogSeenAt" TIMESTAMP(3);
