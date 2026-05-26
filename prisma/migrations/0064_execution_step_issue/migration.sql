-- AXI-56: materialize a plan step into a first-class Issue (optional link).
ALTER TABLE "ExecutionStep" ADD COLUMN "issueId" TEXT;

ALTER TABLE "ExecutionStep" ADD CONSTRAINT "ExecutionStep_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ExecutionStep_issueId_idx" ON "ExecutionStep"("issueId");
