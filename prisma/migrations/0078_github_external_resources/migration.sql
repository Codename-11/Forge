-- Durable external-resource identity/link/sync layer.
-- GitHub is the first provider, but the schema is provider-neutral.

CREATE TABLE "ExternalResource" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "connectionMappingId" TEXT,
  "resourceType" TEXT NOT NULL,
  "repoFullName" TEXT NOT NULL,
  "externalId" TEXT,
  "externalNodeId" TEXT,
  "number" INTEGER NOT NULL,
  "url" TEXT NOT NULL,
  "apiUrl" TEXT,
  "title" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "authorLogin" TEXT,
  "labels" JSONB,
  "assignees" JSONB,
  "metadata" JSONB,
  "externalCreatedAt" TIMESTAMP(3),
  "externalUpdatedAt" TIMESTAMP(3),
  "lastSyncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ExternalResource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalResourceLink" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "externalResourceId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ExternalResourceLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalWebhookEvent" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT,
  "provider" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "action" TEXT,
  "repoFullName" TEXT,
  "externalResourceId" TEXT,
  "status" TEXT NOT NULL,
  "error" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),

  CONSTRAINT "ExternalWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalResource_workspaceId_provider_repoFullName_resourceType_number_key"
  ON "ExternalResource"("workspaceId", "provider", "repoFullName", "resourceType", "number");
CREATE INDEX "ExternalResource_workspaceId_provider_repoFullName_idx"
  ON "ExternalResource"("workspaceId", "provider", "repoFullName");
CREATE INDEX "ExternalResource_workspaceId_provider_externalNodeId_idx"
  ON "ExternalResource"("workspaceId", "provider", "externalNodeId");
CREATE INDEX "ExternalResource_connectionMappingId_idx"
  ON "ExternalResource"("connectionMappingId");

CREATE UNIQUE INDEX "ExternalResourceLink_issueId_externalResourceId_kind_key"
  ON "ExternalResourceLink"("issueId", "externalResourceId", "kind");
CREATE INDEX "ExternalResourceLink_workspaceId_issueId_idx"
  ON "ExternalResourceLink"("workspaceId", "issueId");
CREATE INDEX "ExternalResourceLink_workspaceId_externalResourceId_idx"
  ON "ExternalResourceLink"("workspaceId", "externalResourceId");
CREATE INDEX "ExternalResourceLink_createdById_idx"
  ON "ExternalResourceLink"("createdById");

CREATE UNIQUE INDEX "ExternalWebhookEvent_provider_deliveryId_key"
  ON "ExternalWebhookEvent"("provider", "deliveryId");
CREATE INDEX "ExternalWebhookEvent_workspaceId_status_receivedAt_idx"
  ON "ExternalWebhookEvent"("workspaceId", "status", "receivedAt");
CREATE INDEX "ExternalWebhookEvent_provider_repoFullName_idx"
  ON "ExternalWebhookEvent"("provider", "repoFullName");

ALTER TABLE "ExternalResource"
  ADD CONSTRAINT "ExternalResource_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExternalResource"
  ADD CONSTRAINT "ExternalResource_connectionMappingId_fkey"
  FOREIGN KEY ("connectionMappingId") REFERENCES "ConnectionMapping"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ExternalResourceLink"
  ADD CONSTRAINT "ExternalResourceLink_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExternalResourceLink"
  ADD CONSTRAINT "ExternalResourceLink_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExternalResourceLink"
  ADD CONSTRAINT "ExternalResourceLink_externalResourceId_fkey"
  FOREIGN KEY ("externalResourceId") REFERENCES "ExternalResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExternalResourceLink"
  ADD CONSTRAINT "ExternalResourceLink_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ExternalWebhookEvent"
  ADD CONSTRAINT "ExternalWebhookEvent_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
