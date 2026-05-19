-- Forge Agentic Work OS — Wave 7: AgentCrew + ReviewGate.
--
-- Groups of agents that work together (crews) and explicit
-- approval checkpoints attached to any reviewable surface
-- (gates). Adds the FK on ExecutionPlan.crewId now that
-- AgentCrew exists.

CREATE TABLE "AgentCrew" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "maxParallel" INTEGER NOT NULL DEFAULT 1,
  "policy"      JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "archivedAt"  TIMESTAMP(3),
  CONSTRAINT "AgentCrew_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentCrew_workspaceId_name_key"
  ON "AgentCrew"("workspaceId", "name");
CREATE INDEX "AgentCrew_workspaceId_updatedAt_idx"
  ON "AgentCrew"("workspaceId", "updatedAt");

CREATE TABLE "AgentCrewMember" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "crewId"      TEXT NOT NULL,
  "agentId"     TEXT NOT NULL,
  "role"        TEXT NOT NULL,
  "position"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentCrewMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentCrewMember_crewId_agentId_role_key"
  ON "AgentCrewMember"("crewId", "agentId", "role");
CREATE INDEX "AgentCrewMember_workspaceId_agentId_idx"
  ON "AgentCrewMember"("workspaceId", "agentId");

CREATE TYPE "ReviewGateStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELED'
);

CREATE TABLE "ReviewGate" (
  "id"                 TEXT NOT NULL,
  "workspaceId"        TEXT NOT NULL,
  "targetType"         TEXT NOT NULL,
  "targetId"           TEXT NOT NULL,
  "status"             "ReviewGateStatus" NOT NULL DEFAULT 'PENDING',
  "requiredRole"       TEXT,
  "requestedById"      TEXT,
  "requestedByAgentId" TEXT,
  "resolvedById"       TEXT,
  "resolvedByAgentId"  TEXT,
  "prompt"             TEXT NOT NULL,
  "resolution"         TEXT,
  "crewId"             TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"         TIMESTAMP(3),
  CONSTRAINT "ReviewGate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReviewGate_workspaceId_status_createdAt_idx"
  ON "ReviewGate"("workspaceId", "status", "createdAt");
CREATE INDEX "ReviewGate_workspaceId_targetType_targetId_idx"
  ON "ReviewGate"("workspaceId", "targetType", "targetId");

ALTER TABLE "AgentCrew" ADD CONSTRAINT "AgentCrew_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentCrewMember" ADD CONSTRAINT "AgentCrewMember_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentCrewMember" ADD CONSTRAINT "AgentCrewMember_crewId_fkey"
  FOREIGN KEY ("crewId") REFERENCES "AgentCrew"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentCrewMember" ADD CONSTRAINT "AgentCrewMember_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewGate" ADD CONSTRAINT "ReviewGate_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewGate" ADD CONSTRAINT "ReviewGate_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReviewGate" ADD CONSTRAINT "ReviewGate_requestedByAgentId_fkey"
  FOREIGN KEY ("requestedByAgentId") REFERENCES "Agent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReviewGate" ADD CONSTRAINT "ReviewGate_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReviewGate" ADD CONSTRAINT "ReviewGate_resolvedByAgentId_fkey"
  FOREIGN KEY ("resolvedByAgentId") REFERENCES "Agent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReviewGate" ADD CONSTRAINT "ReviewGate_crewId_fkey"
  FOREIGN KEY ("crewId") REFERENCES "AgentCrew"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Add the deferred FK from ExecutionPlan.crewId -> AgentCrew.id.
ALTER TABLE "ExecutionPlan" ADD CONSTRAINT "ExecutionPlan_crewId_fkey"
  FOREIGN KEY ("crewId") REFERENCES "AgentCrew"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
