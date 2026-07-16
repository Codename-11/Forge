-- Native interactive connector sessions. Background/issue execution remains
-- on AgentRun.externalRunId and Hermes /v1/runs.

ALTER TYPE "EventKind" ADD VALUE 'CHAT_CONNECTOR_EVENT';

CREATE TYPE "ChatSessionClass" AS ENUM ('INTERACTIVE', 'BACKGROUND', 'ISSUE', 'OTHER');
CREATE TYPE "ConnectorSessionLifecycle" AS ENUM ('CONNECTING', 'ACTIVE', 'DISCONNECTED', 'CLOSING', 'CLOSED', 'ERROR');
CREATE TYPE "ConnectorSessionOwnership" AS ENUM ('FORGE', 'HERMES', 'EXTERNAL');
CREATE TYPE "ConnectorDeliveryDirection" AS ENUM ('OUTBOUND', 'INBOUND');
CREATE TYPE "ConnectorDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'RETRY_SCHEDULED', 'FAILED', 'DEAD_LETTER');

ALTER TABLE "Workspace"
  ADD COLUMN "connectorRequestTimeoutSeconds" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "connectorDeliveryMaxAttempts" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN "connectorRetryInitialSeconds" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "connectorRetryMaxSeconds" INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN "webhookRetryMaxAttempts" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN "webhookRetryInitialSeconds" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "webhookRetryMaxSeconds" INTEGER NOT NULL DEFAULT 300;

ALTER TABLE "ChatMessage"
  ADD COLUMN "sequence" INTEGER,
  ADD COLUMN "replyToMessageId" TEXT,
  ADD COLUMN "externalMessageId" TEXT,
  ADD COLUMN "connectorSessionId" TEXT;

-- Existing messages receive a stable per-thread order. The column remains
-- nullable during the compatibility rollout so pre-Sessions writers continue
-- to work until they allocate their sequence transactionally.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "threadId" ORDER BY "createdAt" ASC, "id" ASC
  )::INTEGER AS "sequence"
  FROM "ChatMessage"
)
UPDATE "ChatMessage" AS message
SET "sequence" = ranked."sequence"
FROM ranked
WHERE ranked."id" = message."id";

CREATE TABLE "ConnectorSession" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "runtimeId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "chatThreadId" TEXT,
  "connectorKey" TEXT NOT NULL DEFAULT 'hermes-sessions',
  "externalSessionId" TEXT NOT NULL,
  "sessionClass" "ChatSessionClass" NOT NULL DEFAULT 'INTERACTIVE',
  "lifecycle" "ConnectorSessionLifecycle" NOT NULL DEFAULT 'CONNECTING',
  "ownership" "ConnectorSessionOwnership" NOT NULL DEFAULT 'FORGE',
  "memoryKey" TEXT NOT NULL,
  "memoryKeyVersion" INTEGER NOT NULL DEFAULT 2,
  "protocolVersion" TEXT,
  "capabilities" JSONB,
  "negotiatedAt" TIMESTAMP(3),
  "negotiationError" TEXT,
  "resumeCursor" TEXT,
  "lastExternalSequence" INTEGER,
  "subscriptionLeaseOwner" TEXT,
  "subscriptionLeaseExpiresAt" TIMESTAMP(3),
  "lastConnectedAt" TIMESTAMP(3),
  "lastEventAt" TIMESTAMP(3),
  "lastDeliveryAt" TIMESTAMP(3),
  "lastErrorAt" TIMESTAMP(3),
  "lastError" TEXT,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "nextRetryAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "ConnectorSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConnectorDelivery" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "connectorSessionId" TEXT NOT NULL,
  "direction" "ConnectorDeliveryDirection" NOT NULL,
  "externalEventId" TEXT NOT NULL,
  "sequence" INTEGER,
  "kind" TEXT NOT NULL,
  "status" "ConnectorDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "payload" JSONB,
  "chatMessageId" TEXT,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextAttemptAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConnectorDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatMessage_threadId_sequence_key" ON "ChatMessage"("threadId", "sequence");
CREATE UNIQUE INDEX "ChatMessage_connectorSessionId_externalMessageId_key" ON "ChatMessage"("connectorSessionId", "externalMessageId");
CREATE INDEX "ChatMessage_replyToMessageId_idx" ON "ChatMessage"("replyToMessageId");
CREATE INDEX "ChatMessage_connectorSessionId_createdAt_idx" ON "ChatMessage"("connectorSessionId", "createdAt");

CREATE UNIQUE INDEX "ConnectorSession_runtimeId_externalSessionId_key" ON "ConnectorSession"("runtimeId", "externalSessionId");
CREATE UNIQUE INDEX "ConnectorSession_chatThreadId_connectorKey_key" ON "ConnectorSession"("chatThreadId", "connectorKey");
CREATE INDEX "ConnectorSession_workspaceId_sessionClass_lifecycle_updatedAt_idx" ON "ConnectorSession"("workspaceId", "sessionClass", "lifecycle", "updatedAt");
CREATE INDEX "ConnectorSession_workspaceId_agentId_lifecycle_idx" ON "ConnectorSession"("workspaceId", "agentId", "lifecycle");
CREATE INDEX "ConnectorSession_lifecycle_nextRetryAt_idx" ON "ConnectorSession"("lifecycle", "nextRetryAt");
CREATE INDEX "ConnectorSession_subscriptionLeaseExpiresAt_idx" ON "ConnectorSession"("subscriptionLeaseExpiresAt");

CREATE UNIQUE INDEX "ConnectorDelivery_session_direction_event_key" ON "ConnectorDelivery"("connectorSessionId", "direction", "externalEventId");
CREATE INDEX "ConnectorDelivery_workspaceId_status_nextAttemptAt_idx" ON "ConnectorDelivery"("workspaceId", "status", "nextAttemptAt");
CREATE INDEX "ConnectorDelivery_session_direction_sequence_idx" ON "ConnectorDelivery"("connectorSessionId", "direction", "sequence");
CREATE INDEX "ConnectorDelivery_chatMessageId_idx" ON "ConnectorDelivery"("chatMessageId");

ALTER TABLE "ConnectorSession" ADD CONSTRAINT "ConnectorSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectorSession" ADD CONSTRAINT "ConnectorSession_runtimeId_fkey" FOREIGN KEY ("runtimeId") REFERENCES "Runtime"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectorSession" ADD CONSTRAINT "ConnectorSession_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectorSession" ADD CONSTRAINT "ConnectorSession_chatThreadId_fkey" FOREIGN KEY ("chatThreadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_connectorSessionId_fkey" FOREIGN KEY ("connectorSessionId") REFERENCES "ConnectorSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ConnectorDelivery" ADD CONSTRAINT "ConnectorDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectorDelivery" ADD CONSTRAINT "ConnectorDelivery_connectorSessionId_fkey" FOREIGN KEY ("connectorSessionId") REFERENCES "ConnectorSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectorDelivery" ADD CONSTRAINT "ConnectorDelivery_chatMessageId_fkey" FOREIGN KEY ("chatMessageId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
