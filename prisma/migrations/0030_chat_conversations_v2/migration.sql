-- Chat Conversations v2: multiple named conversations per agent + durable context summaries.

ALTER TYPE "EventKind" ADD VALUE 'CHAT_THREAD_COMPACTED';

CREATE TYPE "ChatContextMode" AS ENUM ('SMART', 'RECENT_ONLY', 'FULL_SUMMARY', 'PINNED_CONTEXT');

ALTER TABLE "ChatThread"
  ADD COLUMN "topic" TEXT,
  ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "contextMode" "ChatContextMode" NOT NULL DEFAULT 'SMART',
  ADD COLUMN "summaryMarkdown" TEXT,
  ADD COLUMN "summarizedUntilMessageId" TEXT,
  ADD COLUMN "summarizedAt" TIMESTAMP(3);

DROP INDEX IF EXISTS "ChatThread_workspaceId_userId_agentId_key";

CREATE UNIQUE INDEX "ChatThread_default_unique"
  ON "ChatThread"("workspaceId", "userId", "agentId")
  WHERE "isDefault" = true;

CREATE INDEX "ChatThread_agent_conversations_idx"
  ON "ChatThread"("workspaceId", "userId", "agentId", "lastMessageAt");

CREATE INDEX "ChatThread_archive_idx"
  ON "ChatThread"("workspaceId", "userId", "archivedAt", "lastMessageAt");
