-- Task follow-through, layers 2 + 3.
--
-- Layer 2 — required-ack window after a successful AGENT_ASSIGNED
-- delivery. The maintenance worker schedules a delayed job per delivery;
-- when it fires we check whether the agent commented on the issue or
-- moved its status. If neither happened, we emit AGENT_NOACK and (when
-- `autoRedispatchOnNoack` is true) clear assignedAgentId so the
-- dispatcher re-picks. `requiredAckSeconds` = 0 disables the check.
--
-- Layer 3 — real SLA enforcement on `Issue.slaMinutes`. The sla-breach
-- sweep runs once a minute and fires ISSUE_SLA_BREACH for any non-done
-- issue past its slaMinutes target. `slaEnforcementEnabled` is the
-- workspace master switch; per-issue `slaMinutes` is the actual cutoff.
ALTER TABLE "Workspace"
  ADD COLUMN "requiredAckSeconds"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "autoRedispatchOnNoack" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "slaEnforcementEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'AGENT_NOACK';
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'ISSUE_SLA_BREACH';
