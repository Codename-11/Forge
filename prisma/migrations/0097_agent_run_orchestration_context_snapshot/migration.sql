-- Preserve the bounded Goal / Plan / ExecutionStep context an agent received
-- at dispatch so historical runs remain truthful after orchestration edits.
-- Nullable keeps legacy and non-orchestrated runs compatible; application
-- readers fall back to live hydration only when no snapshot exists.
ALTER TABLE "AgentRun"
  ADD COLUMN "orchestrationContextSnapshot" JSONB;
