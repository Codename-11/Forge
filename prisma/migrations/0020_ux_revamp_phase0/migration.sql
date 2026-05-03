-- UX revamp Phase 0 — shared primitives + tRPC scaffolding.
--
-- Adds:
--   * Workspace.stalledThresholdDays (settings-driven knob for the
--     dashboard "Stalled" suggestions bucket).
--   * IssueSavedView model — per-user saved filter presets used by the
--     Phase 1 issue list redesign. Distinct from the legacy SavedView
--     model (which mixes shared + private) to keep ordering and
--     ownership semantics simple.
--
-- Phase 0 ships scaffolding only — no consumer surface is touched here.

-- Workspace.stalledThresholdDays
ALTER TABLE "Workspace"
  ADD COLUMN "stalledThresholdDays" INTEGER NOT NULL DEFAULT 7;

-- IssueSavedView
CREATE TABLE "IssueSavedView" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "filters"     JSONB NOT NULL,
  "sortKey"     TEXT,
  "orderIndex"  INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IssueSavedView_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IssueSavedView_userId_workspaceId_name_key"
  ON "IssueSavedView"("userId", "workspaceId", "name");

CREATE INDEX "IssueSavedView_workspaceId_userId_idx"
  ON "IssueSavedView"("workspaceId", "userId");

CREATE INDEX "IssueSavedView_userId_orderIndex_idx"
  ON "IssueSavedView"("userId", "orderIndex");

ALTER TABLE "IssueSavedView" ADD CONSTRAINT "IssueSavedView_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueSavedView" ADD CONSTRAINT "IssueSavedView_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
