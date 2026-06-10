-- Workspace-level default human assignee for newly-created issues.
CREATE TYPE "DefaultIssueAssigneeMode" AS ENUM ('NONE', 'CREATOR', 'USER');

ALTER TABLE "Workspace"
  ADD COLUMN "defaultIssueAssigneeMode" "DefaultIssueAssigneeMode" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "defaultIssueAssigneeUserId" TEXT;

CREATE INDEX "Workspace_defaultIssueAssigneeUserId_idx"
  ON "Workspace"("defaultIssueAssigneeUserId");

ALTER TABLE "Workspace"
  ADD CONSTRAINT "Workspace_defaultIssueAssigneeUserId_fkey"
  FOREIGN KEY ("defaultIssueAssigneeUserId")
  REFERENCES "User"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
