-- Timestamped migration names are collision-safe for parallel contributors.
CREATE TYPE "WorkSessionStatus" AS ENUM (
  'CLAIMED', 'IN_PROGRESS', 'PR_OPEN', 'IN_REVIEW', 'READY_TO_MERGE',
  'MERGED', 'RELEASED', 'DEPLOYED', 'VERIFIED', 'STALE', 'ABANDONED'
);

CREATE TYPE "WorkSessionSource" AS ENUM (
  'FORGE_AGENT', 'CODEX_DESKTOP', 'CONTRIBUTOR', 'MANUAL'
);

ALTER TABLE "Workspace"
  ADD COLUMN "workSessionStaleMinutes" INTEGER NOT NULL DEFAULT 120;

CREATE TABLE "WorkSession" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "ownerUserId" TEXT,
  "ownerAgentId" TEXT,
  "source" "WorkSessionSource" NOT NULL,
  "status" "WorkSessionStatus" NOT NULL DEFAULT 'CLAIMED',
  "repoFullName" TEXT NOT NULL,
  "branch" TEXT NOT NULL,
  "baseBranch" TEXT NOT NULL DEFAULT 'main',
  "worktreePath" TEXT,
  "headSha" TEXT,
  "pullRequestId" TEXT,
  "releasedVersion" TEXT,
  "deployedSha" TEXT,
  "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "staleAt" TIMESTAMP(3),
  "mergedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "deployedAt" TIMESTAMP(3),
  "verifiedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WorkSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkSession_workspaceId_repoFullName_branch_key"
  ON "WorkSession"("workspaceId", "repoFullName", "branch");
CREATE INDEX "WorkSession_workspaceId_status_lastHeartbeatAt_idx"
  ON "WorkSession"("workspaceId", "status", "lastHeartbeatAt");
CREATE INDEX "WorkSession_issueId_createdAt_idx" ON "WorkSession"("issueId", "createdAt");
CREATE INDEX "WorkSession_ownerUserId_status_idx" ON "WorkSession"("ownerUserId", "status");
CREATE INDEX "WorkSession_ownerAgentId_status_idx" ON "WorkSession"("ownerAgentId", "status");
CREATE INDEX "WorkSession_pullRequestId_idx" ON "WorkSession"("pullRequestId");

-- A single active coordination lease per issue. Historical terminal sessions
-- remain available without preventing a later follow-up branch.
CREATE UNIQUE INDEX "WorkSession_one_active_per_issue"
  ON "WorkSession"("issueId")
  WHERE "status" NOT IN ('VERIFIED', 'ABANDONED');

ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_ownerAgentId_fkey"
  FOREIGN KEY ("ownerAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_pullRequestId_fkey"
  FOREIGN KEY ("pullRequestId") REFERENCES "ExternalResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
