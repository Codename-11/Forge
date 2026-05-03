-- Phase 0 of the pinning / recents / palette rework.
--
-- Adds:
--   * PinTargetType enum — polymorphic target for the new Pin and
--     RecentItem tables (ISSUE / PROJECT / INITIATIVE / SAVED_VIEW
--     / CYCLE / AGENT).
--   * Pin model — per-user pin row, optionally workspace-scoped.
--     Replaces the legacy `User.pinnedIssueIds` string-array column;
--     existing values are backfilled into Pin rows with
--     `workspaceId = NULL` and `targetType = ISSUE`.
--   * RecentItem model — per-(user, workspace, target) LRU-ish row,
--     `visitedAt` updated on every track call (server-side debounced
--     5s in the recentItem.track resolver).
--
-- Phase 0 ships schema + procs + small shared components only. The
-- consumer surfaces (sidebar, /issues bulk bar, command palette
-- modal, recent rail) are wired in Phase 1.

-- ---------------------------------------------------------------------------
-- Enum: PinTargetType
-- ---------------------------------------------------------------------------
CREATE TYPE "PinTargetType" AS ENUM (
  'ISSUE',
  'PROJECT',
  'INITIATIVE',
  'SAVED_VIEW',
  'CYCLE',
  'AGENT'
);

-- ---------------------------------------------------------------------------
-- Pin
-- ---------------------------------------------------------------------------
CREATE TABLE "Pin" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "workspaceId" TEXT,
  "targetType"  "PinTargetType" NOT NULL,
  "targetId"    TEXT NOT NULL,
  "orderIndex"  INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Pin_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Pin_userId_workspaceId_targetType_targetId_key"
  ON "Pin"("userId", "workspaceId", "targetType", "targetId");

CREATE INDEX "Pin_userId_workspaceId_orderIndex_idx"
  ON "Pin"("userId", "workspaceId", "orderIndex");

CREATE INDEX "Pin_userId_targetType_targetId_idx"
  ON "Pin"("userId", "targetType", "targetId");

ALTER TABLE "Pin" ADD CONSTRAINT "Pin_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Pin" ADD CONSTRAINT "Pin_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RecentItem
-- ---------------------------------------------------------------------------
CREATE TABLE "RecentItem" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "targetType"  "PinTargetType" NOT NULL,
  "targetId"    TEXT NOT NULL,
  "visitedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecentItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecentItem_userId_workspaceId_targetType_targetId_key"
  ON "RecentItem"("userId", "workspaceId", "targetType", "targetId");

CREATE INDEX "RecentItem_userId_workspaceId_visitedAt_idx"
  ON "RecentItem"("userId", "workspaceId", "visitedAt" DESC);

ALTER TABLE "RecentItem" ADD CONSTRAINT "RecentItem_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecentItem" ADD CONSTRAINT "RecentItem_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill: expand User.pinnedIssueIds (string[]) into Pin rows.
-- Each user's array becomes ISSUE-typed, workspace-null pins, preserving
-- the original ordering via WITH ORDINALITY (1-based, so subtract 1 to
-- get a 0-based orderIndex matching what new pins use).
--
-- We don't validate that targetId still resolves to a live Issue — the
-- pin router skips dead targets at hydration time, so soft-deleted or
-- gone issues just stay as inert rows the user can't see (and which
-- get cleaned up when they next open the palette / strip).
--
-- ID generation: a backfilled Pin needs a unique id but doesn't need to
-- be a real cuid (no MCP / API consumer constructs an id, they always
-- read whatever the DB returned). md5(random + clock_timestamp) is
-- collision-safe within a single migration and easy to grep for later.
-- ---------------------------------------------------------------------------
INSERT INTO "Pin" ("id", "userId", "workspaceId", "targetType", "targetId", "orderIndex", "createdAt")
SELECT
  'pin_' || md5(random()::text || clock_timestamp()::text || u."id" || expanded.ord::text),
  u."id",
  NULL,
  'ISSUE'::"PinTargetType",
  expanded."issueId",
  (expanded.ord - 1)::INTEGER,
  CURRENT_TIMESTAMP
FROM "User" u
CROSS JOIN LATERAL UNNEST(u."pinnedIssueIds") WITH ORDINALITY AS expanded("issueId", ord)
WHERE array_length(u."pinnedIssueIds", 1) > 0;

-- ---------------------------------------------------------------------------
-- Drop the legacy column. Pin is now the source of truth.
-- ---------------------------------------------------------------------------
ALTER TABLE "User" DROP COLUMN "pinnedIssueIds";
