-- Workspace.startedStatusId — opt-in server-side auto-transition target
-- for AGENT_ASSIGNED. Null disables; setting it makes the audit/event
-- fan-out promote assigned issues to this status when eligible.

ALTER TABLE "Workspace" ADD COLUMN "startedStatusId" TEXT;

ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_startedStatusId_fkey"
  FOREIGN KEY ("startedStatusId") REFERENCES "Status"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Workspace_startedStatusId_idx" ON "Workspace"("startedStatusId");
