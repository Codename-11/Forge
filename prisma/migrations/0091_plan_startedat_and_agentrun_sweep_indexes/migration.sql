-- AlterTable: wall-time budget clock starts at execution (activatePlan), not
-- decompose, so planning + approval-wait isn't charged against the run clock.
ALTER TABLE "ExecutionPlan" ADD COLUMN     "startedAt" TIMESTAMP(3);

-- CreateIndex: status-leading index for the cross-tenant worker sweeps
-- (pollActiveRuns / ensureSubscriptions / stale watchdog) that filter on
-- status with no workspaceId and previously seq-scanned every 5s/60s.
CREATE INDEX "AgentRun_status_lastEventAt_idx" ON "AgentRun"("status", "lastEventAt");

-- CreateIndex: dedup lookup on the dispatch path (has this AGENT_ASSIGNED
-- event already opened a run?).
CREATE INDEX "AgentRun_assignmentEventId_idx" ON "AgentRun"("assignmentEventId");
