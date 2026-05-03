-- Phase 0 of the Inbox / Agents / Stalled rework.
--
-- Adds:
--   * Issue.snoozedUntil      — operator-set "on hold" timestamp;
--                               excluded from inbox + stalled buckets
--                               while in the future.
--   * Issue.dispatchReason    — opaque blob with the most recent
--                               dispatcher decision (mode, candidate
--                               set, picked agent, reasonText).
--   * User.lastInboxVisitAt   — drives "new since last visit" badging.
--   * AgentRunControlState    — new enum (NONE / PAUSE_REQUESTED /
--                               CANCEL_REQUESTED).
--   * AgentRun.controlState   — defaults to NONE; PAUSE_REQUESTED /
--                               CANCEL_REQUESTED are pending operator
--                               signals for the agent's runtime.
--   * AgentRun.controlRequestedAt / controlRequestedById — provenance.
--   * EventKind enum extended with ISSUE_SNOOZED, ISSUE_UNSNOOZED,
--     ISSUE_NUDGED, AGENT_RUN_CONTROL_REQUESTED.
--
-- Phase 0 ships the schema + tRPC + shared components. Consumer
-- surfaces (inbox UI, agents UI, dashboard) are touched in Phase 1.

-- ---------------------------------------------------------------------------
-- Enum: AgentRunControlState
-- ---------------------------------------------------------------------------
CREATE TYPE "AgentRunControlState" AS ENUM (
  'NONE',
  'PAUSE_REQUESTED',
  'CANCEL_REQUESTED'
);

-- ---------------------------------------------------------------------------
-- Enum: EventKind — append new kinds (Postgres requires ALTER TYPE for
-- each value; "IF NOT EXISTS" makes the migration idempotent if the
-- enum was already extended out-of-band).
-- ---------------------------------------------------------------------------
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'ISSUE_SNOOZED';
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'ISSUE_UNSNOOZED';
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'ISSUE_NUDGED';
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'AGENT_RUN_CONTROL_REQUESTED';

-- ---------------------------------------------------------------------------
-- Issue: snoozedUntil + dispatchReason
-- ---------------------------------------------------------------------------
ALTER TABLE "Issue"
  ADD COLUMN "snoozedUntil"   TIMESTAMP(3),
  ADD COLUMN "dispatchReason" JSONB;

CREATE INDEX "Issue_snoozedUntil_idx" ON "Issue"("snoozedUntil");

-- ---------------------------------------------------------------------------
-- User: lastInboxVisitAt
-- ---------------------------------------------------------------------------
ALTER TABLE "User"
  ADD COLUMN "lastInboxVisitAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- AgentRun: controlState + provenance
-- ---------------------------------------------------------------------------
ALTER TABLE "AgentRun"
  ADD COLUMN "controlState"         "AgentRunControlState" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "controlRequestedAt"   TIMESTAMP(3),
  ADD COLUMN "controlRequestedById" TEXT;

ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_controlRequestedById_fkey"
  FOREIGN KEY ("controlRequestedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
