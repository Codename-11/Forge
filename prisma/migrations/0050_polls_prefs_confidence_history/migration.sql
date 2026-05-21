-- Wave: Decision polls, notification preferences, comment confidence,
-- comment edit history.
--
-- 1. ActionRequestVote — per-(request, user) vote rows for poll-style
--    ActionRequests. Unique on (actionRequestId, userId) so each user
--    votes once per poll; changing the pick is an upsert. Cascades on
--    the parent ActionRequest delete.
--
-- 2. ActionRequest.options (JSONB) — array of `{ key, label, description? }`
--    rows. When non-null, the renderer treats the request as a poll and
--    surfaces the vote tally instead of a single-acceptor card.
--
-- 3. ActionRequest.votingClosedAt — set by the original requester via
--    `actionRequest.closeVoting`. Once set, ActionRequestVote upserts
--    are rejected. Null = voting still open.
--
-- 4. NotificationDelivery enum + NotificationPreference table — per-user,
--    per-EventKind opt-out. Defaults to enabled (no row = no opt-out)
--    so existing users see no behavior change. `workspaceId` is nullable:
--    a null row applies across every workspace the user belongs to; a
--    workspace-scoped row overrides the global default for that workspace.
--    `delivery` field is wired now for the future digest path but only
--    INBOX_ONLY semantics ship in this wave.
--
-- 5. ConfidenceLevel enum + Comment.confidence — agent annotates a comment
--    with a confidence flag (LOW / MEDIUM / HIGH) so operators know how
--    much to scrutinize. UI only renders the chip for agent-authored rows.
--
-- 6. Comment.revisions — flipped from `Json?` to `Json NOT NULL DEFAULT '[]'`
--    after backfilling existing NULL rows. The column already carried
--    STATUS-comment history (`[{ body, currentStep, ts }]`); BODY edits
--    now push `[{ body, editedAt }]` rows onto the same array. Capped
--    server-side (STATUS = 50, BODY = 20).
--
-- 7. Comment.editedAt — mirrors `updatedAt` at the time of the most
--    recent body edit. Distinct from `updatedAt` (Prisma bumps that on
--    every column change, including confidence / suggestedReplies).

-- ---------------------------------------------------------------------------
-- Enums (new)
-- ---------------------------------------------------------------------------
CREATE TYPE "ConfidenceLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "NotificationDelivery" AS ENUM ('INBOX_ONLY', 'INBOX_AND_DIGEST');

-- ---------------------------------------------------------------------------
-- ActionRequest: options + votingClosedAt
-- ---------------------------------------------------------------------------
ALTER TABLE "ActionRequest"
  ADD COLUMN "options"        JSONB,
  ADD COLUMN "votingClosedAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- ActionRequestVote — one row per (request, user). Cascade on the
-- parent request so closing or deleting a poll cleans up its votes.
-- ---------------------------------------------------------------------------
CREATE TABLE "ActionRequestVote" (
  "id"              TEXT NOT NULL,
  "actionRequestId" TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "optionKey"       TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ActionRequestVote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ActionRequestVote_actionRequestId_userId_key"
  ON "ActionRequestVote" ("actionRequestId", "userId");
CREATE INDEX "ActionRequestVote_actionRequestId_optionKey_idx"
  ON "ActionRequestVote" ("actionRequestId", "optionKey");
CREATE INDEX "ActionRequestVote_userId_idx"
  ON "ActionRequestVote" ("userId");

ALTER TABLE "ActionRequestVote"
  ADD CONSTRAINT "ActionRequestVote_actionRequestId_fkey"
  FOREIGN KEY ("actionRequestId") REFERENCES "ActionRequest"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActionRequestVote"
  ADD CONSTRAINT "ActionRequestVote_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- NotificationPreference — per-user, per-EventKind opt-out.
--
-- `workspaceId` is NULL for global ("apply everywhere") preferences and
-- a workspace id for workspace-scoped overrides. Because Postgres treats
-- NULLs as distinct in unique indexes, we add a partial unique index for
-- the NULL case so a user has at most one global row per eventKind.
-- ---------------------------------------------------------------------------
CREATE TABLE "NotificationPreference" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "workspaceId" TEXT,
  "eventKind"   TEXT NOT NULL,
  "enabled"     BOOLEAN NOT NULL DEFAULT TRUE,
  "delivery"    "NotificationDelivery" NOT NULL DEFAULT 'INBOX_ONLY',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- Workspace-scoped uniqueness (workspaceId IS NOT NULL).
CREATE UNIQUE INDEX "NotificationPreference_userId_workspaceId_eventKind_key"
  ON "NotificationPreference" ("userId", "workspaceId", "eventKind");

-- Global uniqueness (workspaceId IS NULL) — Postgres treats NULL as
-- distinct in the multi-column unique above, so we layer a partial
-- index here to guarantee one global row per (user, kind).
CREATE UNIQUE INDEX "NotificationPreference_userId_global_eventKind_key"
  ON "NotificationPreference" ("userId", "eventKind")
  WHERE "workspaceId" IS NULL;

CREATE INDEX "NotificationPreference_workspaceId_eventKind_idx"
  ON "NotificationPreference" ("workspaceId", "eventKind");
CREATE INDEX "NotificationPreference_userId_eventKind_idx"
  ON "NotificationPreference" ("userId", "eventKind");

ALTER TABLE "NotificationPreference"
  ADD CONSTRAINT "NotificationPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ON DELETE CASCADE on workspaceId: workspace-scoped prefs are
-- meaningless once the workspace is gone, and SET NULL would collide
-- with the partial unique index when the user already has a global
-- pref for the same (user, eventKind). Cascading lets the global
-- row survive untouched.
ALTER TABLE "NotificationPreference"
  ADD CONSTRAINT "NotificationPreference_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Comment: confidence + editedAt + revisions default
-- ---------------------------------------------------------------------------
ALTER TABLE "Comment"
  ADD COLUMN "confidence" "ConfidenceLevel",
  ADD COLUMN "editedAt"   TIMESTAMP(3);

-- Backfill existing NULL revisions to an empty array, then flip the
-- column to NOT NULL with a default so readers never need a null
-- guard. STATUS comments that already carry history are preserved.
UPDATE "Comment" SET "revisions" = '[]'::jsonb WHERE "revisions" IS NULL;

ALTER TABLE "Comment"
  ALTER COLUMN "revisions" SET DEFAULT '[]'::jsonb,
  ALTER COLUMN "revisions" SET NOT NULL;
