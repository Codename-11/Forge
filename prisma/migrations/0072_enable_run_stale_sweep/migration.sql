-- Enable the stalled-AgentRun watchdog by default.
--
-- The sweep (src/server/services/agent-run-stale.ts) only runs for
-- workspaces where `agentRunStaleMinutes > 0`; the column shipped at 0
-- (disabled), so ACTIVE runs that an agent never closed via `runs.complete`
-- (e.g. Hermes turns that end without a lifecycle call) lingered as live
-- runs on the issue page forever. Flip the default to 30 minutes and
-- backfill workspaces still sitting on the old disabled default.
ALTER TABLE "Workspace" ALTER COLUMN "agentRunStaleMinutes" SET DEFAULT 30;
UPDATE "Workspace" SET "agentRunStaleMinutes" = 30 WHERE "agentRunStaleMinutes" = 0;
