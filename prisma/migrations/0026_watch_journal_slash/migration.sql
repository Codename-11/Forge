-- Watch / Follow + Daily Journal + Slash Commands (Run A of 2).
--
-- Three independent surfaces in one migration:
--   * IssueWatcher — per-(issue, user OR agent) subscription rows. Watch
--     and Pin are orthogonal: pin is a UI shortcut, watch is event
--     subscription. Either userId or agentId is set (enforced in the
--     handler); never both, never neither.
--   * Note.kind + Note.journalDate — variant + date columns powering
--     `notes.todayJournal`. JOURNAL rows are unique per (workspace,
--     user, journalDate); NOTE rows leave journalDate NULL (Postgres
--     unique allows multiple NULLs through, so existing Note rows
--     remain valid).
--   * Slash commands — purely a server-side parser + applyCommands
--     extension on issue.create. No schema impact; lives in
--     `src/lib/slash-commands.ts` and `applyCommands` in the issue
--     router.

-- ---------------------------------------------------------------------------
-- NoteKind enum
-- ---------------------------------------------------------------------------
CREATE TYPE "NoteKind" AS ENUM ('NOTE', 'JOURNAL');

-- ---------------------------------------------------------------------------
-- Note: kind + journalDate columns
-- ---------------------------------------------------------------------------
ALTER TABLE "Note"
  ADD COLUMN "kind"        "NoteKind"   NOT NULL DEFAULT 'NOTE',
  ADD COLUMN "journalDate" TIMESTAMP(3);

-- One journal entry per user per day. Postgres allows multiple NULLs
-- in a unique constraint, so non-journal NOTE rows are unaffected.
CREATE UNIQUE INDEX "Note_workspaceId_userId_journalDate_key"
  ON "Note"("workspaceId", "userId", "journalDate");

CREATE INDEX "Note_workspaceId_userId_kind_journalDate_idx"
  ON "Note"("workspaceId", "userId", "kind", "journalDate");

-- ---------------------------------------------------------------------------
-- IssueWatcher
-- ---------------------------------------------------------------------------
CREATE TABLE "IssueWatcher" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "issueId"     TEXT NOT NULL,
  "userId"      TEXT,
  "agentId"     TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueWatcher_pkey" PRIMARY KEY ("id")
);

-- Uniqueness is per identity per issue. Postgres unique with NULLs
-- treats NULL != NULL, so a row with userId=NULL and agentId=X is
-- distinct from another row with userId=NULL and agentId=Y — perfect.
CREATE UNIQUE INDEX "IssueWatcher_issueId_userId_key"
  ON "IssueWatcher"("issueId", "userId");
CREATE UNIQUE INDEX "IssueWatcher_issueId_agentId_key"
  ON "IssueWatcher"("issueId", "agentId");

CREATE INDEX "IssueWatcher_workspaceId_userId_idx"
  ON "IssueWatcher"("workspaceId", "userId");
CREATE INDEX "IssueWatcher_workspaceId_agentId_idx"
  ON "IssueWatcher"("workspaceId", "agentId");
CREATE INDEX "IssueWatcher_issueId_idx"
  ON "IssueWatcher"("issueId");

ALTER TABLE "IssueWatcher" ADD CONSTRAINT "IssueWatcher_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueWatcher" ADD CONSTRAINT "IssueWatcher_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "Issue"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueWatcher" ADD CONSTRAINT "IssueWatcher_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueWatcher" ADD CONSTRAINT "IssueWatcher_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
