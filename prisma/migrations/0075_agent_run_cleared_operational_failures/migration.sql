ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'AGENT_RUN_CLEARED';

ALTER TABLE "AgentRun"
  ADD COLUMN "clearedAt" TIMESTAMP(3),
  ADD COLUMN "clearedById" TEXT;

ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_clearedById_fkey"
  FOREIGN KEY ("clearedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AgentRun_workspaceId_status_clearedAt_lastEventAt_idx"
  ON "AgentRun" ("workspaceId", "status", "clearedAt", "lastEventAt");

-- Historical terminal failures are durable audit/history rows, not current
-- operator work. Clear the pre-existing backlog from operational queues while
-- keeping the rows available in run history and issue timelines.
UPDATE "AgentRun"
SET "clearedAt" = COALESCE("finishedAt", "lastEventAt", NOW())
WHERE "clearedAt" IS NULL
  AND "status" IN ('STALLED', 'ABANDONED')
  AND COALESCE("finishedAt", "lastEventAt", NOW()) < NOW() - INTERVAL '24 hours';
