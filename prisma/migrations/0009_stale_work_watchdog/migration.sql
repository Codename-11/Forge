-- Stale-work watchdog (P1, layer 1).
--
-- Push-dispatch lands an `AGENT_ASSIGNED` webhook on the agent the moment
-- assignment happens, but Hermes returns 202 immediately — if the LLM
-- call drops mid-thought, nothing notices. The watchdog sweep runs on
-- the maintenance worker and emits `ISSUE_STALLED` when an assigned
-- issue sits in BACKLOG/TODO past its workspace SLA cutoff.
--
-- `assignmentSlaMinutes` = 0 disables the sweep for the workspace
-- (default), matching the `agentIdleTimeoutMinutes` opt-in shape.
-- `autoRedispatchOnStall` controls whether the sweep also clears
-- `assignedAgentId` so the auto-dispatcher re-picks; off = event-only.
ALTER TABLE "Workspace"
  ADD COLUMN "assignmentSlaMinutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "autoRedispatchOnStall" BOOLEAN NOT NULL DEFAULT false;

ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'ISSUE_STALLED';
