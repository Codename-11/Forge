-- Persistent per-user alert lifecycle layered on immutable ActivityEvent rows.

CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'ERROR', 'CRITICAL');

CREATE TYPE "NotificationStatus" AS ENUM ('UNREAD', 'READ', 'DISMISSED', 'ACKNOWLEDGED', 'RESOLVED');

CREATE TABLE "NotificationState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "replacementKey" TEXT,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
    "importance" INTEGER NOT NULL DEFAULT 0,
    "status" "NotificationStatus" NOT NULL DEFAULT 'UNREAD',
    "persistent" BOOLEAN NOT NULL DEFAULT true,
    "primaryHref" TEXT,
    "detailHref" TEXT,
    "summary" TEXT NOT NULL,
    "reason" TEXT,
    "recommendedAction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "NotificationState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationState_workspaceId_userId_eventId_key" ON "NotificationState"("workspaceId", "userId", "eventId");

CREATE INDEX "NotificationState_workspaceId_userId_status_importance_createdAt_idx" ON "NotificationState"("workspaceId", "userId", "status", "importance", "createdAt");

CREATE INDEX "NotificationState_workspaceId_userId_replacementKey_idx" ON "NotificationState"("workspaceId", "userId", "replacementKey");

CREATE INDEX "NotificationState_eventId_idx" ON "NotificationState"("eventId");

ALTER TABLE "NotificationState" ADD CONSTRAINT "NotificationState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationState" ADD CONSTRAINT "NotificationState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationState" ADD CONSTRAINT "NotificationState_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "ActivityEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
