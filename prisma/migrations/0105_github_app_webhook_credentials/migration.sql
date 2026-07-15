ALTER TABLE "GithubApp"
  ADD COLUMN "webhookSecretEnc" TEXT,
  ADD COLUMN "webhookSecretPreviousEnc" TEXT,
  ADD COLUMN "webhookConfiguredAt" TIMESTAMP(3),
  ADD COLUMN "webhookLastError" TEXT;

CREATE INDEX "GithubApp_installationId_idx" ON "GithubApp"("installationId");
