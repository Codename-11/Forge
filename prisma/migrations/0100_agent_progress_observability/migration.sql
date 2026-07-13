-- Workspace-level observability policy for live agent work.
--
-- `agentProgressUpdateMinutes` is the requested human-facing checkpoint
-- cadence injected into the Forge run protocol. `agentRunQuietMinutes` is a
-- non-terminal operator-attention threshold, intentionally distinct from the
-- existing `agentRunStaleMinutes` watchdog that mutates runs to STALLED.
ALTER TABLE "Workspace"
  ADD COLUMN "agentProgressUpdateMinutes" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "agentRunQuietMinutes" INTEGER NOT NULL DEFAULT 5;
