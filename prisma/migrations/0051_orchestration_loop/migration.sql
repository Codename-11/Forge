-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('OPEN', 'PLANNING', 'ACTIVE', 'ACHIEVED', 'ABANDONED');

-- AlterEnum
-- New event kinds for the orchestration loop. Each ADD VALUE is its own
-- statement; none are referenced in DDL within this migration so the
-- single-transaction migration is safe.
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'GOAL_CREATED';
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'GOAL_STATUS_CHANGED';
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'EXECUTION_STEP_READY';
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'EXECUTION_STEP_JUDGED';
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'PLAN_BUDGET_EXCEEDED';

-- AlterTable
ALTER TABLE "ExecutionPlan" ADD COLUMN     "autoJudge" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "goalId" TEXT,
ADD COLUMN     "isActiveAttempt" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "maxStepRetries" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "maxTotalCostUsd" DOUBLE PRECISION,
ADD COLUMN     "maxWallTimeMinutes" INTEGER,
ADD COLUMN     "totalCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ExecutionStep" ADD COLUMN     "childPlanId" TEXT,
ADD COLUMN     "judgeVerdict" JSONB,
ADD COLUMN     "lastFeedback" TEXT,
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "GoalStatus" NOT NULL DEFAULT 'OPEN',
    "issueId" TEXT,
    "createdById" TEXT,
    "createdByAgentId" TEXT,
    "crewId" TEXT,
    "maxTotalCostUsd" DOUBLE PRECISION,
    "maxWallTimeMinutes" INTEGER,
    "totalCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "achievedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Goal_workspaceId_status_idx" ON "Goal"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "ExecutionPlan_goalId_idx" ON "ExecutionPlan"("goalId");

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_createdByAgentId_fkey" FOREIGN KEY ("createdByAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_crewId_fkey" FOREIGN KEY ("crewId") REFERENCES "AgentCrew"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionPlan" ADD CONSTRAINT "ExecutionPlan_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
