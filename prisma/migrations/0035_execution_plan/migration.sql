-- Forge Agentic Work OS — Wave 6: ExecutionPlan + ExecutionStep.
--
-- Multi-step plans an agent (or crew) executes under an issue or
-- project. Steps form an ordered list with optional dependsOnStepIds
-- so the runner can mark later steps READY only when earlier ones
-- are DONE.
--
-- `crewId` is added now (despite the AgentCrew table not existing
-- yet) as a nullable column; the FK constraint will be added in
-- Wave 7's migration when AgentCrew lands.

CREATE TYPE "ExecutionPlanStatus" AS ENUM (
  'DRAFT',
  'APPROVED',
  'RUNNING',
  'BLOCKED',
  'COMPLETED',
  'CANCELED'
);

CREATE TYPE "ExecutionStepStatus" AS ENUM (
  'TODO',
  'READY',
  'RUNNING',
  'BLOCKED',
  'REVIEW',
  'DONE',
  'CANCELED'
);

CREATE TABLE "ExecutionPlan" (
  "id"               TEXT NOT NULL,
  "workspaceId"      TEXT NOT NULL,
  "title"            TEXT NOT NULL,
  "description"      TEXT,
  "issueId"          TEXT,
  "projectId"        TEXT,
  "status"           "ExecutionPlanStatus" NOT NULL DEFAULT 'DRAFT',
  "createdById"      TEXT,
  "createdByAgentId" TEXT,
  "contextSetId"     TEXT,
  "crewId"           TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  "archivedAt"       TIMESTAMP(3),
  CONSTRAINT "ExecutionPlan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExecutionPlan_workspaceId_status_updatedAt_idx"
  ON "ExecutionPlan"("workspaceId", "status", "updatedAt");
CREATE INDEX "ExecutionPlan_issueId_idx" ON "ExecutionPlan"("issueId");
CREATE INDEX "ExecutionPlan_projectId_idx" ON "ExecutionPlan"("projectId");
CREATE INDEX "ExecutionPlan_contextSetId_idx" ON "ExecutionPlan"("contextSetId");
CREATE INDEX "ExecutionPlan_crewId_idx" ON "ExecutionPlan"("crewId");

CREATE TABLE "ExecutionStep" (
  "id"               TEXT NOT NULL,
  "workspaceId"      TEXT NOT NULL,
  "planId"           TEXT NOT NULL,
  "title"            TEXT NOT NULL,
  "body"             TEXT,
  "position"         INTEGER NOT NULL,
  "status"           "ExecutionStepStatus" NOT NULL DEFAULT 'TODO',
  "assignedAgentId"  TEXT,
  "assignedUserId"   TEXT,
  "expectedOutput"   TEXT,
  "verification"     JSONB,
  "sourceRunId"      TEXT,
  "dependsOnStepIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExecutionStep_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExecutionStep_planId_position_key"
  ON "ExecutionStep"("planId", "position");

CREATE INDEX "ExecutionStep_workspaceId_status_idx"
  ON "ExecutionStep"("workspaceId", "status");
CREATE INDEX "ExecutionStep_assignedAgentId_status_idx"
  ON "ExecutionStep"("assignedAgentId", "status");
CREATE INDEX "ExecutionStep_assignedUserId_status_idx"
  ON "ExecutionStep"("assignedUserId", "status");

ALTER TABLE "ExecutionPlan" ADD CONSTRAINT "ExecutionPlan_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionPlan" ADD CONSTRAINT "ExecutionPlan_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "Issue"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExecutionPlan" ADD CONSTRAINT "ExecutionPlan_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExecutionPlan" ADD CONSTRAINT "ExecutionPlan_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExecutionPlan" ADD CONSTRAINT "ExecutionPlan_createdByAgentId_fkey"
  FOREIGN KEY ("createdByAgentId") REFERENCES "Agent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExecutionPlan" ADD CONSTRAINT "ExecutionPlan_contextSetId_fkey"
  FOREIGN KEY ("contextSetId") REFERENCES "ContextSet"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ExecutionStep" ADD CONSTRAINT "ExecutionStep_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionStep" ADD CONSTRAINT "ExecutionStep_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "ExecutionPlan"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExecutionStep" ADD CONSTRAINT "ExecutionStep_assignedAgentId_fkey"
  FOREIGN KEY ("assignedAgentId") REFERENCES "Agent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExecutionStep" ADD CONSTRAINT "ExecutionStep_assignedUserId_fkey"
  FOREIGN KEY ("assignedUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
