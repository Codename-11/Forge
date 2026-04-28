-- Runtime as a first-class primitive (Multica-inspired upgrade).
--
-- See PLAN.md for the design narrative. Summary:
--   * `Runtime` rows host one or more agents. LOCAL_DAEMON runtimes are
--     spun up by `forge daemon`; REMOTE_HTTP wraps the existing
--     webhook-receiver model; CLOUD is reserved for a future tier.
--   * Every existing agent that already has a `webhookUrl` is backfilled
--     into a `(legacy webhook)` REMOTE_HTTP runtime so the new model is
--     populated on day one without breaking dispatch.
--   * `Agent.webhookUrl` / `webhookSecret` stay for now — a follow-up
--     migration will drop them once `Runtime.endpoint` is authoritative.
--   * `AgentRun` gains tokensIn/tokensOut/tokensCached/costUsd, written
--     by the new `runs.recordUsage` MCP tool.

-- Runtime
CREATE TYPE "RuntimeKind" AS ENUM ('LOCAL_DAEMON', 'REMOTE_HTTP', 'CLOUD');

CREATE TABLE "Runtime" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "RuntimeKind" NOT NULL,
  "endpoint" TEXT,
  "secret" TEXT,
  "providersAvailable" "AgentProvider"[] NOT NULL DEFAULT '{}',
  "heartbeatAt" TIMESTAMP(3),
  "connectedAt" TIMESTAMP(3),
  "ownerKeyPrefix" TEXT,
  "ownerId" TEXT,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Runtime_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Runtime_workspaceId_archivedAt_idx" ON "Runtime"("workspaceId", "archivedAt");
CREATE INDEX "Runtime_ownerId_idx" ON "Runtime"("ownerId");
ALTER TABLE "Runtime" ADD CONSTRAINT "Runtime_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Runtime" ADD CONSTRAINT "Runtime_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Agent.runtimeId
ALTER TABLE "Agent" ADD COLUMN "runtimeId" TEXT;
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_runtimeId_fkey"
  FOREIGN KEY ("runtimeId") REFERENCES "Runtime"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Agent_runtimeId_idx" ON "Agent"("runtimeId");

-- Backfill: every existing agent with a webhookUrl gets a REMOTE_HTTP
-- runtime that wraps it. Reuse the agent name; reuse the webhookSecret.
-- Run as a single statement so a fresh deploy is cheap.
INSERT INTO "Runtime" (id, "workspaceId", name, kind, endpoint, secret,
                       "providersAvailable", "heartbeatAt", "ownerId",
                       "createdAt", "updatedAt")
SELECT
  'rt_' || a.id,                       -- deterministic id derived from agent
  a."workspaceId",
  a.name || ' (legacy webhook)',
  'REMOTE_HTTP',
  a."webhookUrl",
  a."webhookSecret",
  ARRAY[a.provider]::"AgentProvider"[],
  a."lastHeartbeatAt",
  NULL,                                 -- no owner attribution for legacy rows
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Agent" a
WHERE a."webhookUrl" IS NOT NULL;

UPDATE "Agent" a
SET "runtimeId" = 'rt_' || a.id
WHERE a."webhookUrl" IS NOT NULL;

-- AgentRun token columns
ALTER TABLE "AgentRun" ADD COLUMN "tokensIn" INTEGER;
ALTER TABLE "AgentRun" ADD COLUMN "tokensOut" INTEGER;
ALTER TABLE "AgentRun" ADD COLUMN "tokensCached" INTEGER;
ALTER TABLE "AgentRun" ADD COLUMN "costUsd" DECIMAL(10, 4);
