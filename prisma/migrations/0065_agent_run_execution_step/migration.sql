-- AXI-57: link an AgentRun to the ExecutionStep it executes (orchestrated runs).
ALTER TABLE "AgentRun" ADD COLUMN "executionStepId" TEXT;

ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_executionStepId_fkey"
  FOREIGN KEY ("executionStepId") REFERENCES "ExecutionStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AgentRun_executionStepId_idx" ON "AgentRun"("executionStepId");
