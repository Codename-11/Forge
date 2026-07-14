ALTER TABLE "Workspace"
  ADD COLUMN "githubSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "githubSyncStaleMinutes" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "githubSyncBatchSize" INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN "githubSyncBackoffMinutes" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "githubSyncMaxBackoffMinutes" INTEGER NOT NULL DEFAULT 1440;

ALTER TABLE "ExternalResource"
  ADD COLUMN "syncAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "syncRetryAt" TIMESTAMP(3),
  ADD COLUMN "syncFailureCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "syncLastError" TEXT,
  ADD COLUMN "syncTerminalAt" TIMESTAMP(3);

CREATE INDEX "ExternalResource_workspaceId_provider_resourceType_syncTerminalAt_lastSyncedAt_idx"
  ON "ExternalResource"("workspaceId", "provider", "resourceType", "syncTerminalAt", "lastSyncedAt");
CREATE INDEX "ExternalResource_syncRetryAt_idx" ON "ExternalResource"("syncRetryAt");

-- Closed unmerged PRs are final. Merged PRs remain eligible until Forge has
-- refreshed aggregate checks at least once under the new reconciliation path.
UPDATE "ExternalResource"
SET "syncTerminalAt" = COALESCE("lastSyncedAt", "updatedAt")
WHERE "provider" = 'GITHUB'
  AND "resourceType" = 'PULL_REQUEST'
  AND "state" = 'closed';
