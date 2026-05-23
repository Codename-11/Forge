-- Detail of a pending approval captured from the live /events stream
-- (command + description + choices), so the Live-tab banner can show
-- what's being approved.

ALTER TABLE "AgentRun" ADD COLUMN "pendingApproval" JSONB;
