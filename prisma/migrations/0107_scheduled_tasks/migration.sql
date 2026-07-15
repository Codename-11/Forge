-- First-class recurring automation tasks. Legacy RecurringIssue rows remain
-- untouched and continue to use their existing ticker.

CREATE TYPE "ScheduledTaskAction" AS ENUM ('CREATE_ISSUE');
CREATE TYPE "ScheduledTaskScheduleType" AS ENUM ('INTERVAL', 'DAILY', 'WEEKLY');
CREATE TYPE "ScheduledTaskDeliveryType" AS ENUM ('INBOX', 'PROJECT');
CREATE TYPE "ScheduledTaskStatus" AS ENUM ('ACTIVE', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PAUSED');
CREATE TYPE "ScheduledTaskRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "ScheduledTaskRunTrigger" AS ENUM ('SCHEDULE', 'MANUAL');

ALTER TYPE "EventKind" ADD VALUE 'SCHEDULED_TASK_CREATED';
ALTER TYPE "EventKind" ADD VALUE 'SCHEDULED_TASK_UPDATED';
ALTER TYPE "EventKind" ADD VALUE 'SCHEDULED_TASK_DELETED';
ALTER TYPE "EventKind" ADD VALUE 'SCHEDULED_TASK_RUN_STARTED';
ALTER TYPE "EventKind" ADD VALUE 'SCHEDULED_TASK_RUN_SUCCEEDED';
ALTER TYPE "EventKind" ADD VALUE 'SCHEDULED_TASK_RUN_FAILED';

CREATE TABLE "ScheduledTask" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "projectId" TEXT,
  "name" TEXT NOT NULL,
  "action" "ScheduledTaskAction" NOT NULL DEFAULT 'CREATE_ISSUE',
  "prompt" TEXT NOT NULL,
  "issueTitle" TEXT NOT NULL,
  "issuePriority" "Priority" NOT NULL DEFAULT 'NONE',
  "deliveryType" "ScheduledTaskDeliveryType" NOT NULL DEFAULT 'INBOX',
  "scheduleType" "ScheduledTaskScheduleType" NOT NULL,
  "intervalMinutes" INTEGER,
  "timeOfDayMinutes" INTEGER,
  "dayOfWeek" INTEGER,
  "timezone" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "status" "ScheduledTaskStatus" NOT NULL DEFAULT 'ACTIVE',
  "nextRunAt" TIMESTAMP(3),
  "lastRunAt" TIMESTAMP(3),
  "lastSucceededAt" TIMESTAMP(3),
  "lastError" TEXT,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScheduledTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScheduledTaskRun" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "scheduledTaskId" TEXT NOT NULL,
  "outputIssueId" TEXT,
  "status" "ScheduledTaskRunStatus" NOT NULL DEFAULT 'RUNNING',
  "trigger" "ScheduledTaskRunTrigger" NOT NULL,
  "scheduledForAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScheduledTaskRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScheduledTask_workspaceId_enabled_nextRunAt_idx"
  ON "ScheduledTask"("workspaceId", "enabled", "nextRunAt");
CREATE INDEX "ScheduledTask_workspaceId_status_idx"
  ON "ScheduledTask"("workspaceId", "status");
CREATE INDEX "ScheduledTask_projectId_idx" ON "ScheduledTask"("projectId");
CREATE INDEX "ScheduledTaskRun_scheduledTaskId_createdAt_idx"
  ON "ScheduledTaskRun"("scheduledTaskId", "createdAt");
CREATE INDEX "ScheduledTaskRun_workspaceId_createdAt_idx"
  ON "ScheduledTaskRun"("workspaceId", "createdAt");
CREATE INDEX "ScheduledTaskRun_outputIssueId_idx" ON "ScheduledTaskRun"("outputIssueId");

ALTER TABLE "ScheduledTask"
  ADD CONSTRAINT "ScheduledTask_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledTask"
  ADD CONSTRAINT "ScheduledTask_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScheduledTask"
  ADD CONSTRAINT "ScheduledTask_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ScheduledTaskRun"
  ADD CONSTRAINT "ScheduledTaskRun_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledTaskRun"
  ADD CONSTRAINT "ScheduledTaskRun_scheduledTaskId_fkey"
  FOREIGN KEY ("scheduledTaskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledTaskRun"
  ADD CONSTRAINT "ScheduledTaskRun_outputIssueId_fkey"
  FOREIGN KEY ("outputIssueId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
