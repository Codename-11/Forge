-- Durable operator signal for orchestration plans whose step/run state has
-- drifted or whose review path has no owner.
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'PLAN_STALLED';
