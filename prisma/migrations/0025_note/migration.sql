-- Quick Notes — per-user markdown scratchpad on the dashboard.
--
-- Adds:
--   * Note model — per-(workspace, user) markdown note with optional
--     title, pinned flag, and soft-delete via `archivedAt`. The dashboard
--     widget surfaces unarchived rows ordered by (pinned desc, updatedAt
--     desc); archived rows live behind an "Archived" toggle. Conversion
--     to a real Issue is a one-click action that calls a dedicated
--     `note.convertToIssue` mutation (the source note stays put — the
--     user can archive it separately).
--
-- Notes are intentionally per-user, not workspace-shared: the surface
-- is meant for fast personal capture (TODOs, reasoning scratchpads,
-- agent notes-to-self). Sharing happens by converting to an Issue.

-- ---------------------------------------------------------------------------
-- Note
-- ---------------------------------------------------------------------------
CREATE TABLE "Note" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "title"       TEXT,
  "body"        TEXT NOT NULL,
  "pinned"      BOOLEAN NOT NULL DEFAULT false,
  "archivedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Note_workspaceId_userId_archivedAt_pinned_updatedAt_idx"
  ON "Note"("workspaceId", "userId", "archivedAt", "pinned", "updatedAt");

ALTER TABLE "Note" ADD CONSTRAINT "Note_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Note" ADD CONSTRAINT "Note_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
