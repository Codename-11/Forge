-- Forge Agentic Work OS — Wave 5: Agent completion contract.
--
-- Adds explicit "done means..." fields to Issue and structured
-- completion outputs to AgentRun. The fields are nullable for legacy
-- rows so the migration is non-destructive.
--
-- * Issue.expectedOutput          — markdown spec of the deliverable
-- * Issue.verificationChecklist   — JSON array of checks
-- * Issue.artifactRequired        — bool, must agent attach an artifact?
-- * AgentRun.producedArtifactIds  — string[], evidence links
-- * AgentRun.verificationResult   — JSON, checklist snapshot at finish
-- * AgentRun.followUps            — JSON array of follow-up items

ALTER TABLE "Issue" ADD COLUMN "expectedOutput" TEXT;
ALTER TABLE "Issue" ADD COLUMN "verificationChecklist" JSONB;
ALTER TABLE "Issue" ADD COLUMN "artifactRequired" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "AgentRun" ADD COLUMN "producedArtifactIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AgentRun" ADD COLUMN "verificationResult" JSONB;
ALTER TABLE "AgentRun" ADD COLUMN "followUps" JSONB;
