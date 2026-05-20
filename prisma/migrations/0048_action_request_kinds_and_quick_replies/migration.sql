-- Wave: Inline ActionRequest cards + comment quick-reply chips.
--
-- 1. New enum ActionRequestKind discriminates the executable shape of
--    a request. FREE_FORM (default) preserves today's pure-prose
--    semantics. The remaining kinds are dispatchable on Accept and
--    carry their args in the new `payload` Json column.
--
-- 2. New enum value ActionRequestStatus.REJECTED captures explicit
--    decline (operator said "no, do not do this"), distinct from
--    DISMISSED (operator said "no longer relevant").
--
-- 3. `ActionRequest.resolvedByUserId` records which user clicked
--    Accept/Decline so the audit + UI can show provenance without
--    walking the audit log.
--
-- 4. New composite index on (sourceType, sourceId) so the issue
--    detail page's `forComment` lookup is O(1) regardless of
--    workspace size.
--
-- 5. `Comment.suggestedReplies` array — short quick-reply chip
--    strings an agent can attach when posting a comment. Defaults
--    to an empty array so existing rows don't need a backfill.

-- ---------------------------------------------------------------------------
-- Enum: ActionRequestKind (new)
-- ---------------------------------------------------------------------------
CREATE TYPE "ActionRequestKind" AS ENUM (
  'FREE_FORM',
  'TRANSITION',
  'SET_LABELS',
  'ASSIGN',
  'ASSIGN_AGENT',
  'ARCHIVE',
  'CLOSE_AS_DUPLICATE'
);

-- ---------------------------------------------------------------------------
-- Enum: ActionRequestStatus — add REJECTED
-- ---------------------------------------------------------------------------
ALTER TYPE "ActionRequestStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

-- ---------------------------------------------------------------------------
-- ActionRequest: new columns (kind, payload, resolvedByUserId) + index
-- ---------------------------------------------------------------------------
ALTER TABLE "ActionRequest"
  ADD COLUMN "kind" "ActionRequestKind" NOT NULL DEFAULT 'FREE_FORM',
  ADD COLUMN "payload" JSONB,
  ADD COLUMN "resolvedByUserId" TEXT;

ALTER TABLE "ActionRequest"
  ADD CONSTRAINT "ActionRequest_resolvedByUserId_fkey"
  FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ActionRequest_sourceType_sourceId_idx"
  ON "ActionRequest" ("sourceType", "sourceId");

-- ---------------------------------------------------------------------------
-- Comment.suggestedReplies (TEXT[]) — defaults to empty array
-- ---------------------------------------------------------------------------
ALTER TABLE "Comment"
  ADD COLUMN "suggestedReplies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
