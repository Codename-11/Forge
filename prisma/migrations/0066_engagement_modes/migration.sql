-- AXI-53: engagement modes (work intent) + mention policy.
CREATE TYPE "EngagementMode" AS ENUM ('EXECUTE', 'RESEARCH', 'REVIEW', 'DISCUSS');
CREATE TYPE "MentionEngagementPolicy" AS ENUM ('INFER', 'FIXED', 'REQUIRE_MARKER');

ALTER TABLE "AgentRun" ADD COLUMN "engagementMode" "EngagementMode" NOT NULL DEFAULT 'EXECUTE';

ALTER TABLE "Workspace" ADD COLUMN "assignmentEngagementMode" "EngagementMode" NOT NULL DEFAULT 'EXECUTE';
ALTER TABLE "Workspace" ADD COLUMN "mentionEngagementPolicy" "MentionEngagementPolicy" NOT NULL DEFAULT 'INFER';
ALTER TABLE "Workspace" ADD COLUMN "mentionDefaultMode" "EngagementMode" NOT NULL DEFAULT 'DISCUSS';
