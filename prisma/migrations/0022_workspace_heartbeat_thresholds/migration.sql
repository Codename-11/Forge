-- Phase 1C of the Inbox / Agents / Stalled rework — agent management UI.
--
-- Adds two settings-driven thresholds (per Bailey's no-magic-numbers rule)
-- so the agents page can surface a heartbeat-lag warning on PERSISTENT
-- agents without baking minute counts into component code:
--
--   * Workspace.agentHeartbeatWarnMinutes      — warn tier (default 5).
--   * Workspace.agentHeartbeatCriticalMinutes  — critical tier (default 30).
--
-- EPHEMERAL agents only heartbeat while running, so the consumer
-- suppresses the warning for them regardless of these values. 0 on
-- either column disables that tier.

ALTER TABLE "Workspace"
  ADD COLUMN "agentHeartbeatWarnMinutes"     INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "agentHeartbeatCriticalMinutes" INTEGER NOT NULL DEFAULT 30;
