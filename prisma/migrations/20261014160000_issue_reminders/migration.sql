CREATE TABLE "IssueReminder" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "remindAt" TIMESTAMP(3) NOT NULL,
  "timezone" TEXT NOT NULL,
  "browserPush" BOOLEAN NOT NULL DEFAULT false,
  "readAt" TIMESTAMP(3),
  "dismissedAt" TIMESTAMP(3),
  "notifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IssueReminder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IssueReminder_userId_issueId_key" ON "IssueReminder"("userId", "issueId");
CREATE INDEX "IssueReminder_workspaceId_userId_remindAt_idx" ON "IssueReminder"("workspaceId", "userId", "remindAt");
CREATE INDEX "IssueReminder_browserPush_notifiedAt_remindAt_idx" ON "IssueReminder"("browserPush", "notifiedAt", "remindAt");
CREATE INDEX "IssueReminder_issueId_idx" ON "IssueReminder"("issueId");
ALTER TABLE "IssueReminder" ADD CONSTRAINT "IssueReminder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueReminder" ADD CONSTRAINT "IssueReminder_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueReminder" ADD CONSTRAINT "IssueReminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
