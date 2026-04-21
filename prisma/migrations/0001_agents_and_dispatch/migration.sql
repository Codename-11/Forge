-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ONLINE', 'OFFLINE', 'BUSY');

-- CreateEnum
CREATE TYPE "AutoDispatchMode" AS ENUM ('MANUAL_ONLY', 'ROUND_ROBIN', 'PRIORITY_MATCH', 'CAPABILITY_MATCH');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventKind" ADD VALUE 'ISSUE_QUEUED';
ALTER TYPE "EventKind" ADD VALUE 'AGENT_CREATED';
ALTER TYPE "EventKind" ADD VALUE 'AGENT_UPDATED';
ALTER TYPE "EventKind" ADD VALUE 'AGENT_DELETED';
ALTER TYPE "EventKind" ADD VALUE 'AGENT_ASSIGNED';

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "assignedAgentId" TEXT;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "agentIdleTimeoutMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "autoDispatch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoDispatchMode" "AutoDispatchMode" NOT NULL DEFAULT 'MANUAL_ONLY',
ADD COLUMN     "autoStartOnAssign" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requireApprovalBeforeStart" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "profileKey" TEXT NOT NULL,
    "description" TEXT,
    "avatar" TEXT,
    "webhookUrl" TEXT,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "AgentStatus" NOT NULL DEFAULT 'OFFLINE',
    "lastHeartbeatAt" TIMESTAMP(3),
    "maxConcurrent" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Agent_workspaceId_status_idx" ON "Agent"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_workspaceId_profileKey_key" ON "Agent"("workspaceId", "profileKey");

-- CreateIndex
CREATE INDEX "Issue_workspaceId_assignedAgentId_idx" ON "Issue"("workspaceId", "assignedAgentId");

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

