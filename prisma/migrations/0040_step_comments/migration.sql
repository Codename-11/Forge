-- Forge Plans — per-step comment threads (Agent E, Wave 7 follow-up).
--
-- Lets operators (and agents) thread comments under each ExecutionStep
-- without inventing a new model. We keep the existing `Comment` row
-- as the single comment primitive and extend it with a nullable
-- `executionStepId` FK. To allow step-only comments (no parent issue)
-- the existing `issueId` column is relaxed to nullable.
--
-- Both columns are nullable so existing rows (all issue-attached
-- today) remain valid without backfill. The downstream invariant
-- "a comment hangs off exactly one surface" is enforced application-
-- side by the router: `comment.create` keeps requiring `issueId`;
-- `executionPlan.stepCommentCreate` requires `executionStepId` and
-- leaves `issueId` null.
--
-- ON DELETE CASCADE on `executionStepId` matches the issue cascade so
-- removing a step removes its inline thread.

-- 1. Relax the issueId FK to allow NULL — step comments don't belong
-- to an issue. Drop + re-add the constraint so the column can be
-- altered (Postgres won't NULLABLE a column that's part of a
-- NOT NULL constraint defined inline).
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_issueId_fkey";
ALTER TABLE "Comment" ALTER COLUMN "issueId" DROP NOT NULL;
ALTER TABLE "Comment"
  ADD CONSTRAINT "Comment_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "Issue"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. New nullable FK to the owning ExecutionStep. Cascade so step
-- deletion takes its inline thread with it.
ALTER TABLE "Comment" ADD COLUMN "executionStepId" TEXT;
ALTER TABLE "Comment"
  ADD CONSTRAINT "Comment_executionStepId_fkey"
  FOREIGN KEY ("executionStepId") REFERENCES "ExecutionStep"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Index for the per-step thread list (chronological).
CREATE INDEX "Comment_executionStepId_createdAt_idx"
  ON "Comment" ("executionStepId", "createdAt");
