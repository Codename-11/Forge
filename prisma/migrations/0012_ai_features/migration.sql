-- AI features (Coach + Triage).
--
-- Triage = single LLM call on issue.create that suggests priority +
-- labels + agent. Stored on the Issue row so the UI can render an
-- accept/dismiss chip without a side table.
--
-- Coach = real Agent row with role=COACH that observes
-- ISSUE_STALLED / AGENT_NOACK / ISSUE_SLA_BREACH events and posts
-- diagnostic comments. Doesn't claim work.
--
-- Both gated by `Workspace.aiEnabled` (default off). Cost-bounded by
-- design: triage = one call per human-authored issue, coach = one
-- call per qualifying event.

-- New enum: agent role discriminates WORKER (default) / COACH / OBSERVER.
CREATE TYPE "AgentRole" AS ENUM ('WORKER', 'COACH', 'OBSERVER');

-- New enum: triage state machine on the Issue row.
CREATE TYPE "AiTriageStatus" AS ENUM ('PENDING', 'READY', 'APPLIED', 'DISMISSED', 'ERROR');

-- Workspace knobs.
ALTER TABLE "Workspace"
  ADD COLUMN "aiEnabled"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "aiTriageOnCreate" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "aiCoachEnabled"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "aiProvider"       TEXT NOT NULL DEFAULT 'hermes',
  ADD COLUMN "aiModel"          TEXT;

-- Agent role.
ALTER TABLE "Agent"
  ADD COLUMN "role" "AgentRole" NOT NULL DEFAULT 'WORKER';

-- Issue triage fields.
ALTER TABLE "Issue"
  ADD COLUMN "aiTriageStatus"       "AiTriageStatus",
  ADD COLUMN "aiSuggestedPriority"  "Priority",
  ADD COLUMN "aiSuggestedLabelIds"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "aiSuggestedAgentId"   TEXT,
  ADD COLUMN "aiTriageReasoning"    TEXT,
  ADD COLUMN "aiTriagedAt"          TIMESTAMP(3),
  ADD COLUMN "aiTriageDecidedAt"    TIMESTAMP(3);

CREATE INDEX "Issue_workspaceId_aiTriageStatus_idx"
  ON "Issue" ("workspaceId", "aiTriageStatus");
