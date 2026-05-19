-- Forge Agentic Work OS — Wave 8: ActionRequest.
--
-- Adds the precise, resolvable ask primitive. Replaces vague
-- notifications: "the agent needs your decision before continuing"
-- rather than "the agent commented." The Inbox waiting-on-me query
-- unions OPEN ActionRequests with the existing NotificationState
-- lifecycle so operators see one stream.

CREATE TYPE "ActionRequestStatus" AS ENUM (
  'OPEN',
  'RESOLVED',
  'DISMISSED',
  'SNOOZED'
);

CREATE TABLE "ActionRequest" (
  "id"                 TEXT NOT NULL,
  "workspaceId"        TEXT NOT NULL,
  "title"              TEXT NOT NULL,
  "body"               TEXT,
  "status"             "ActionRequestStatus" NOT NULL DEFAULT 'OPEN',
  "severity"           "NotificationSeverity" NOT NULL DEFAULT 'INFO',
  "requestedByUserId"  TEXT,
  "requestedByAgentId" TEXT,
  "assignedUserId"     TEXT,
  "assignedAgentId"    TEXT,
  "sourceType"         TEXT,
  "sourceId"           TEXT,
  "issueId"            TEXT,
  "dueAt"              TIMESTAMP(3),
  "resolvedAt"         TIMESTAMP(3),
  "resolution"         TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ActionRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ActionRequest_workspaceId_status_createdAt_idx"
  ON "ActionRequest"("workspaceId", "status", "createdAt");
CREATE INDEX "ActionRequest_assignedUserId_status_idx"
  ON "ActionRequest"("assignedUserId", "status");
CREATE INDEX "ActionRequest_assignedAgentId_status_idx"
  ON "ActionRequest"("assignedAgentId", "status");
CREATE INDEX "ActionRequest_issueId_idx" ON "ActionRequest"("issueId");

ALTER TABLE "ActionRequest" ADD CONSTRAINT "ActionRequest_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActionRequest" ADD CONSTRAINT "ActionRequest_requestedByUserId_fkey"
  FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActionRequest" ADD CONSTRAINT "ActionRequest_requestedByAgentId_fkey"
  FOREIGN KEY ("requestedByAgentId") REFERENCES "Agent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActionRequest" ADD CONSTRAINT "ActionRequest_assignedUserId_fkey"
  FOREIGN KEY ("assignedUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActionRequest" ADD CONSTRAINT "ActionRequest_assignedAgentId_fkey"
  FOREIGN KEY ("assignedAgentId") REFERENCES "Agent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActionRequest" ADD CONSTRAINT "ActionRequest_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "Issue"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
