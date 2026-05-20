-- Wave: agent orchestration polish — close three related gaps in one shot.
--
-- 1. Add AgentRunStatus.WAITING — lets an agent self-report "blocked on
--    operator" so the stale watchdog stops misclassifying patient agents
--    as dead. Set via MCP `runs.setWaiting`, cleared via `runs.resumeWork`.
--
-- 2. Add CommentKind.SYSTEM — server-authored notice rows for the issue
--    thread (assignment notices today; more later). SYSTEM rows have a
--    null `authorId` and render as ambient narration without re-firing
--    COMMENT_CREATED. To support that, the `Comment.authorId` column
--    relaxes from NOT NULL to nullable, and the FK behavior flips to
--    ON DELETE SET NULL so removing a user doesn't cascade-delete their
--    historical comments.
--
-- No data backfill needed: every existing Comment row already has an
-- authorId, and AgentRunStatus is purely additive.

-- ---------------------------------------------------------------------------
-- Enum: AgentRunStatus — add WAITING
-- ---------------------------------------------------------------------------
ALTER TYPE "AgentRunStatus" ADD VALUE IF NOT EXISTS 'WAITING';

-- ---------------------------------------------------------------------------
-- Enum: CommentKind — add SYSTEM
-- ---------------------------------------------------------------------------
ALTER TYPE "CommentKind" ADD VALUE IF NOT EXISTS 'SYSTEM';

-- ---------------------------------------------------------------------------
-- Comment.authorId — relax NOT NULL, flip FK to SET NULL
-- ---------------------------------------------------------------------------
ALTER TABLE "Comment" ALTER COLUMN "authorId" DROP NOT NULL;

ALTER TABLE "Comment" DROP CONSTRAINT IF EXISTS "Comment_authorId_fkey";

ALTER TABLE "Comment"
  ADD CONSTRAINT "Comment_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
