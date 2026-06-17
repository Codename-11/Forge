-- Persist first-class agent request metadata captured from issue comments.
ALTER TABLE "Comment" ADD COLUMN "agentRequests" JSONB NOT NULL DEFAULT '[]';
