-- AgentRun pauses awaiting operator permission (e.g. Hermes flagged a
-- dangerous command). Drives the Live-tab Approve/Reject affordance.

ALTER TABLE "AgentRun" ADD COLUMN "awaitingApprovalAt" TIMESTAMP(3);
