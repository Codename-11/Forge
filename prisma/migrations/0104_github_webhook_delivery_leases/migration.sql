-- Retry-safe processing leases for native GitHub webhook deliveries.
-- Existing terminal rows keep their historical attempt count; RECEIVED rows
-- use receivedAt as their initial lease start so a crashed request can be
-- reclaimed after the application-level stale threshold.

ALTER TABLE "ExternalWebhookEvent"
  ADD COLUMN "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 1;

UPDATE "ExternalWebhookEvent"
SET "processingStartedAt" = "receivedAt"
WHERE "processingStartedAt" IS NULL;
