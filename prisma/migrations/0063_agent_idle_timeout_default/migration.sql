-- Default `agentIdleTimeoutMinutes` to 15 so new workspaces get true agent
-- presence out of the box: the idle sweep (which flips a heartbeat agent
-- OFFLINE once its heartbeat goes stale) is disabled at 0, so a 0 default left
-- the "offline when it dies" half of presence opt-in. 15 min sits well above
-- the 60s heartbeat/probe cadence, so no flapping.
--
-- New rows only: we change the column DEFAULT but do NOT backfill existing
-- rows, so any workspace deliberately set to 0 (auto-offline opt-out) keeps
-- its choice. 0 still means "disabled".
ALTER TABLE "Workspace" ALTER COLUMN "agentIdleTimeoutMinutes" SET DEFAULT 15;
