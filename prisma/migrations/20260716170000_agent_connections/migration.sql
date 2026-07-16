-- Separate logical agent identity from the concrete endpoint performing work.
-- Legacy provenance is backfilled only where the transport is unambiguous;
-- ambiguous FORGE_AGENT sessions intentionally remain nullable.

CREATE TYPE "AgentConnectionKind" AS ENUM ('MANAGED_RUNTIME', 'MCP_CLIENT', 'WEBHOOK', 'ON_DEMAND');
CREATE TYPE "AgentConnectionLiveness" AS ENUM ('HEARTBEAT', 'LEASE', 'ON_DEMAND', 'PUSH_ACK');
CREATE TYPE "AgentConnectionStatus" AS ENUM ('ACTIVE', 'QUIET', 'DISCONNECTED', 'REVOKED');
CREATE TYPE "LivenessConfidence" AS ENUM ('UNCONFIRMED', 'INFERRED', 'CONFIRMED');
CREATE TYPE "AgentConnectionCapability" AS ENUM ('HEARTBEAT', 'LIFECYCLE_REPORTING', 'CANCELLATION', 'STREAMING', 'TOOL_ACTIVITY', 'PUSH_ACK');
CREATE TYPE "WorkSessionParticipantRole" AS ENUM ('PRIMARY', 'CONTRIBUTOR', 'REVIEWER');

CREATE TABLE "AgentConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" "AgentConnectionKind" NOT NULL,
    "livenessModel" "AgentConnectionLiveness" NOT NULL,
    "status" "AgentConnectionStatus" NOT NULL DEFAULT 'QUIET',
    "confidence" "LivenessConfidence" NOT NULL DEFAULT 'UNCONFIRMED',
    "runtimeId" TEXT,
    "apiKeyId" TEXT,
    "instanceKey" TEXT,
    "displayName" TEXT,
    "clientName" TEXT,
    "clientVersion" TEXT,
    "capabilities" "AgentConnectionCapability"[] NOT NULL DEFAULT ARRAY[]::"AgentConnectionCapability"[],
    "metadata" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentConnection_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AgentRun"
  ADD COLUMN "connectionId" TEXT,
  ADD COLUMN "lifecycleConfidence" "LivenessConfidence" NOT NULL DEFAULT 'UNCONFIRMED';

ALTER TABLE "AgentRunEvent" ADD COLUMN "connectionId" TEXT;
ALTER TABLE "WorkSession" ADD COLUMN "ownerConnectionId" TEXT;

CREATE TABLE "WorkSessionParticipant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workSessionId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "role" "WorkSessionParticipantRole" NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkSessionParticipant_pkey" PRIMARY KEY ("id")
);

-- Managed runtimes are the strongest deterministic legacy mapping.
INSERT INTO "AgentConnection" (
  "id", "workspaceId", "agentId", "kind", "livenessModel", "status",
  "confidence", "runtimeId", "instanceKey", "displayName", "capabilities",
  "firstSeenAt", "lastSeenAt", "connectedAt", "createdAt", "updatedAt"
)
SELECT
  'ac_' || md5(a."id" || ':runtime:' || a."runtimeId"),
  a."workspaceId", a."id", 'MANAGED_RUNTIME', 'HEARTBEAT',
  CASE WHEN a."status" = 'OFFLINE' THEN 'QUIET'::"AgentConnectionStatus" ELSE 'ACTIVE'::"AgentConnectionStatus" END,
  'INFERRED', a."runtimeId", 'runtime:' || a."runtimeId", r."name",
  ARRAY['HEARTBEAT', 'LIFECYCLE_REPORTING', 'CANCELLATION', 'STREAMING']::"AgentConnectionCapability"[],
  COALESCE(a."createdAt", CURRENT_TIMESTAMP),
  COALESCE(a."lastHeartbeatAt", r."heartbeatAt"), r."connectedAt",
  COALESCE(a."createdAt", CURRENT_TIMESTAMP), CURRENT_TIMESTAMP
FROM "Agent" a
JOIN "Runtime" r ON r."id" = a."runtimeId"
WHERE a."runtimeId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- CODEX_DESKTOP is an explicit historical transport signal. One conservative
-- legacy client is created per agent; future MCP initialize calls register
-- their real session/client instances separately.
INSERT INTO "AgentConnection" (
  "id", "workspaceId", "agentId", "kind", "livenessModel", "status",
  "confidence", "instanceKey", "displayName", "clientName", "capabilities",
  "firstSeenAt", "lastSeenAt", "createdAt", "updatedAt"
)
SELECT
  'ac_' || md5(a."id" || ':legacy:codex-desktop'),
  a."workspaceId", a."id", 'MCP_CLIENT', 'LEASE', 'QUIET', 'INFERRED',
  'legacy:codex-desktop:' || a."id", 'Codex Desktop (legacy)', 'Codex Desktop',
  ARRAY['TOOL_ACTIVITY']::"AgentConnectionCapability"[],
  MIN(ws."createdAt"), MAX(ws."lastHeartbeatAt"), MIN(ws."createdAt"), CURRENT_TIMESTAMP
FROM "WorkSession" ws
JOIN "Agent" a ON a."id" = ws."ownerAgentId"
WHERE ws."source" = 'CODEX_DESKTOP'
GROUP BY a."id", a."workspaceId"
ON CONFLICT DO NOTHING;

-- A configured direct webhook is also an unambiguous endpoint. Keep it
-- distinct even when the same agent additionally has a managed runtime.
INSERT INTO "AgentConnection" (
  "id", "workspaceId", "agentId", "kind", "livenessModel", "status",
  "confidence", "instanceKey", "displayName", "capabilities",
  "firstSeenAt", "lastSeenAt", "createdAt", "updatedAt"
)
SELECT
  'ac_' || md5(a."id" || ':webhook'), a."workspaceId", a."id",
  'WEBHOOK', 'PUSH_ACK', 'QUIET', 'UNCONFIRMED',
  'legacy:webhook:' || a."id", a."name" || ' webhook',
  ARRAY['PUSH_ACK']::"AgentConnectionCapability"[],
  a."createdAt", a."lastHeartbeatAt", a."createdAt", CURRENT_TIMESTAMP
FROM "Agent" a
WHERE a."webhookUrl" IS NOT NULL
ON CONFLICT DO NOTHING;

-- Backfill work-session provenance only for explicit Codex Desktop sessions or
-- an agent's managed runtime. FORGE_AGENT without a runtime remains unknown:
-- linked API keys historically represented both identity and transport.
UPDATE "WorkSession" ws
SET "ownerConnectionId" = ac."id"
FROM "AgentConnection" ac
WHERE ws."ownerAgentId" = ac."agentId"
  AND ws."workspaceId" = ac."workspaceId"
  AND (
    (ws."source" = 'CODEX_DESKTOP' AND ac."kind" = 'MCP_CLIENT')
    OR
    (ws."source" = 'FORGE_AGENT' AND ac."kind" = 'MANAGED_RUNTIME')
  );

-- A run can be mapped when its agent has one managed runtime. Other historical
-- runs stay unconfirmed rather than acquiring fabricated MCP provenance.
UPDATE "AgentRun" ar
SET "connectionId" = ac."id", "lifecycleConfidence" = 'INFERRED'
FROM "AgentConnection" ac
WHERE ar."agentId" = ac."agentId"
  AND ar."workspaceId" = ac."workspaceId"
  AND ac."kind" = 'MANAGED_RUNTIME';

UPDATE "AgentRunEvent" are
SET "connectionId" = ar."connectionId"
FROM "AgentRun" ar
WHERE are."runId" = ar."id" AND ar."connectionId" IS NOT NULL;

INSERT INTO "WorkSessionParticipant" (
  "id", "workspaceId", "workSessionId", "connectionId", "agentId", "role",
  "joinedAt", "createdAt", "updatedAt"
)
SELECT
  'wsp_' || md5(ws."id" || ':' || ws."ownerConnectionId"),
  ws."workspaceId", ws."id", ws."ownerConnectionId", ws."ownerAgentId",
  'PRIMARY', ws."createdAt", ws."createdAt", CURRENT_TIMESTAMP
FROM "WorkSession" ws
WHERE ws."ownerConnectionId" IS NOT NULL AND ws."ownerAgentId" IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX "AgentConnection_workspaceId_agentId_kind_instanceKey_key"
  ON "AgentConnection"("workspaceId", "agentId", "kind", "instanceKey");
CREATE INDEX "AgentConnection_workspaceId_status_lastSeenAt_idx"
  ON "AgentConnection"("workspaceId", "status", "lastSeenAt");
CREATE INDEX "AgentConnection_agentId_kind_status_idx"
  ON "AgentConnection"("agentId", "kind", "status");
CREATE INDEX "AgentConnection_runtimeId_idx" ON "AgentConnection"("runtimeId");
CREATE INDEX "AgentConnection_apiKeyId_idx" ON "AgentConnection"("apiKeyId");
CREATE INDEX "AgentRun_connectionId_status_idx" ON "AgentRun"("connectionId", "status");
CREATE INDEX "AgentRunEvent_connectionId_createdAt_idx" ON "AgentRunEvent"("connectionId", "createdAt");
CREATE INDEX "WorkSession_ownerConnectionId_status_idx" ON "WorkSession"("ownerConnectionId", "status");
CREATE UNIQUE INDEX "WorkSessionParticipant_workSessionId_connectionId_key"
  ON "WorkSessionParticipant"("workSessionId", "connectionId");
CREATE INDEX "WorkSessionParticipant_workspaceId_role_leftAt_idx"
  ON "WorkSessionParticipant"("workspaceId", "role", "leftAt");
CREATE INDEX "WorkSessionParticipant_agentId_leftAt_idx"
  ON "WorkSessionParticipant"("agentId", "leftAt");
CREATE INDEX "WorkSessionParticipant_connectionId_leftAt_idx"
  ON "WorkSessionParticipant"("connectionId", "leftAt");
CREATE UNIQUE INDEX "WorkSessionParticipant_one_active_primary"
  ON "WorkSessionParticipant"("workSessionId")
  WHERE "role" = 'PRIMARY' AND "leftAt" IS NULL;

ALTER TABLE "AgentConnection" ADD CONSTRAINT "AgentConnection_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentConnection" ADD CONSTRAINT "AgentConnection_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentConnection" ADD CONSTRAINT "AgentConnection_runtimeId_fkey"
  FOREIGN KEY ("runtimeId") REFERENCES "Runtime"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentConnection" ADD CONSTRAINT "AgentConnection_apiKeyId_fkey"
  FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "AgentConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentRunEvent" ADD CONSTRAINT "AgentRunEvent_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "AgentConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_ownerConnectionId_fkey"
  FOREIGN KEY ("ownerConnectionId") REFERENCES "AgentConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkSessionParticipant" ADD CONSTRAINT "WorkSessionParticipant_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkSessionParticipant" ADD CONSTRAINT "WorkSessionParticipant_workSessionId_fkey"
  FOREIGN KEY ("workSessionId") REFERENCES "WorkSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkSessionParticipant" ADD CONSTRAINT "WorkSessionParticipant_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "AgentConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkSessionParticipant" ADD CONSTRAINT "WorkSessionParticipant_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
