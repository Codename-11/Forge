-- Phase 2: persist the resolved engagement SOURCE + run ENGINE on AgentRun so
-- every surface reads the frozen dispatch-time resolution instead of
-- re-resolving against later Agent / Runtime config drift. RunEngine already
-- exists (migration earlier); EngagementSource is new. All columns nullable
-- (null = legacy/unstamped) — no backfill.

CREATE TYPE "EngagementSource" AS ENUM (
  'EXPLICIT',
  'SURFACE_DEFAULT',
  'POLICY_INFER',
  'POLICY_FIXED',
  'POLICY_REQUIRE_MARKER',
  'STICKY_ACTIVE_RUN',
  'AGENT_REQUEST',
  'PAYLOAD'
);

ALTER TABLE "AgentRun" ADD COLUMN "engagementSource" "EngagementSource";
ALTER TABLE "AgentRun" ADD COLUMN "runEngine" "RunEngine";
ALTER TABLE "AgentRun" ADD COLUMN "runEngineSource" TEXT;
