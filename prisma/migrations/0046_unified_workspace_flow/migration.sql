-- Unified workspace flow — Wave 1 schema landing.
--
-- Adds the full set of primitives the unified-workspace-flow plan
-- (docs/plans/unified-workspace-flow.md) needs to fan out the rest of
-- the workstreams:
--   * Note.status lifecycle + promoted-to backlinks
--   * Issue/Project/Initiative ← Note source backlinks
--   * User.dashboardView preference
--   * WorkspaceCanvas.kind / ownerUserId / activePageId
--   * Figma primitives: CanvasFrame, CanvasGroup, CanvasComponent,
--     CanvasComponentInstance, CanvasStyle
--   * parentFrameId / groupId / styleRefs / lockedAt / hiddenAt on
--     WorkspaceCanvasNode and CanvasShape

-- ---------------------------------------------------------------------------
-- New enums
-- ---------------------------------------------------------------------------

CREATE TYPE "NoteStatus" AS ENUM ('IDEA', 'SOMEDAY', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "CanvasKind" AS ENUM ('PROJECT', 'INITIATIVE', 'CYCLE', 'ISSUE', 'PERSONAL', 'DESIGN');
CREATE TYPE "CanvasStyleKind" AS ENUM ('COLOR', 'TEXT', 'EFFECT');

-- ---------------------------------------------------------------------------
-- Note: status + promotedTo backlinks
-- ---------------------------------------------------------------------------

ALTER TABLE "Note"
  ADD COLUMN "status"         "NoteStatus" NOT NULL DEFAULT 'IDEA',
  ADD COLUMN "promotedToType" TEXT,
  ADD COLUMN "promotedToId"   TEXT;

-- Existing journal entries are durable records, not pitches — flip
-- them to ACTIVE so they don't show up in the dashboard Ideas zone.
UPDATE "Note" SET "status" = 'ACTIVE' WHERE "kind" = 'JOURNAL';
-- Treat existing soft-archived notes as ARCHIVED for status purposes.
UPDATE "Note" SET "status" = 'ARCHIVED' WHERE "archivedAt" IS NOT NULL;

CREATE INDEX "Note_workspaceId_userId_status_updatedAt_idx"
  ON "Note" ("workspaceId", "userId", "status", "updatedAt");

-- ---------------------------------------------------------------------------
-- Source-note backlinks on Issue / Project / Initiative
-- ---------------------------------------------------------------------------

ALTER TABLE "Issue"      ADD COLUMN "sourceNoteId" TEXT;
ALTER TABLE "Project"    ADD COLUMN "sourceNoteId" TEXT;
ALTER TABLE "Initiative" ADD COLUMN "sourceNoteId" TEXT;

-- ---------------------------------------------------------------------------
-- User: dashboard view preference
-- ---------------------------------------------------------------------------

ALTER TABLE "User" ADD COLUMN "dashboardView" TEXT;

-- ---------------------------------------------------------------------------
-- WorkspaceCanvas: kind discriminator + Personal/Design fields
-- ---------------------------------------------------------------------------

ALTER TABLE "WorkspaceCanvas"
  ADD COLUMN "kind"         "CanvasKind" NOT NULL DEFAULT 'PROJECT',
  ADD COLUMN "ownerUserId"  TEXT,
  ADD COLUMN "activePageId" TEXT;

-- Backfill kind from existing scopeType, falling back to PROJECT.
UPDATE "WorkspaceCanvas" SET "kind" = 'PROJECT'    WHERE "scopeType" = 'project';
UPDATE "WorkspaceCanvas" SET "kind" = 'INITIATIVE' WHERE "scopeType" = 'initiative';
UPDATE "WorkspaceCanvas" SET "kind" = 'CYCLE'      WHERE "scopeType" = 'cycle';
UPDATE "WorkspaceCanvas" SET "kind" = 'ISSUE'      WHERE "scopeType" = 'issue';

ALTER TABLE "WorkspaceCanvas"
  ADD CONSTRAINT "WorkspaceCanvas_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "WorkspaceCanvas_workspaceId_kind_ownerUserId_key"
  ON "WorkspaceCanvas" ("workspaceId", "kind", "ownerUserId");
CREATE INDEX "WorkspaceCanvas_workspaceId_kind_idx"
  ON "WorkspaceCanvas" ("workspaceId", "kind");
CREATE INDEX "WorkspaceCanvas_ownerUserId_idx"
  ON "WorkspaceCanvas" ("ownerUserId");

-- ---------------------------------------------------------------------------
-- New table: CanvasFrame
-- ---------------------------------------------------------------------------

CREATE TABLE "CanvasFrame" (
  "id"             TEXT NOT NULL,
  "workspaceId"    TEXT NOT NULL,
  "canvasId"       TEXT NOT NULL,
  "parentFrameId"  TEXT,
  "name"           TEXT NOT NULL DEFAULT 'Frame',
  "x"              DOUBLE PRECISION NOT NULL,
  "y"              DOUBLE PRECISION NOT NULL,
  "width"          DOUBLE PRECISION NOT NULL,
  "height"         DOUBLE PRECISION NOT NULL,
  "isPage"         BOOLEAN NOT NULL DEFAULT false,
  "autoLayout"     JSONB,
  "constraints"    JSONB,
  "backgroundFill" JSONB,
  "z"              INTEGER NOT NULL DEFAULT 0,
  "lockedAt"       TIMESTAMP(3),
  "hiddenAt"       TIMESTAMP(3),
  "createdById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CanvasFrame_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CanvasFrame_canvasId_parentFrameId_z_idx" ON "CanvasFrame" ("canvasId", "parentFrameId", "z");
CREATE INDEX "CanvasFrame_canvasId_isPage_idx"          ON "CanvasFrame" ("canvasId", "isPage");
CREATE INDEX "CanvasFrame_workspaceId_idx"              ON "CanvasFrame" ("workspaceId");

ALTER TABLE "CanvasFrame"
  ADD CONSTRAINT "CanvasFrame_workspaceId_fkey"   FOREIGN KEY ("workspaceId")   REFERENCES "Workspace"("id")       ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CanvasFrame_canvasId_fkey"      FOREIGN KEY ("canvasId")      REFERENCES "WorkspaceCanvas"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CanvasFrame_parentFrameId_fkey" FOREIGN KEY ("parentFrameId") REFERENCES "CanvasFrame"("id")     ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CanvasFrame_createdById_fkey"   FOREIGN KEY ("createdById")   REFERENCES "User"("id")            ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- New table: CanvasGroup
-- ---------------------------------------------------------------------------

CREATE TABLE "CanvasGroup" (
  "id"            TEXT NOT NULL,
  "workspaceId"   TEXT NOT NULL,
  "canvasId"      TEXT NOT NULL,
  "parentFrameId" TEXT,
  "name"          TEXT NOT NULL DEFAULT 'Group',
  "z"             INTEGER NOT NULL DEFAULT 0,
  "lockedAt"      TIMESTAMP(3),
  "hiddenAt"      TIMESTAMP(3),
  "createdById"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CanvasGroup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CanvasGroup_canvasId_parentFrameId_z_idx" ON "CanvasGroup" ("canvasId", "parentFrameId", "z");
CREATE INDEX "CanvasGroup_workspaceId_idx"              ON "CanvasGroup" ("workspaceId");

ALTER TABLE "CanvasGroup"
  ADD CONSTRAINT "CanvasGroup_workspaceId_fkey"   FOREIGN KEY ("workspaceId")   REFERENCES "Workspace"("id")       ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CanvasGroup_canvasId_fkey"      FOREIGN KEY ("canvasId")      REFERENCES "WorkspaceCanvas"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CanvasGroup_parentFrameId_fkey" FOREIGN KEY ("parentFrameId") REFERENCES "CanvasFrame"("id")     ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CanvasGroup_createdById_fkey"   FOREIGN KEY ("createdById")   REFERENCES "User"("id")            ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- New table: CanvasComponent (workspace-scoped reusable definition)
-- ---------------------------------------------------------------------------

CREATE TABLE "CanvasComponent" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "thumbnail"   TEXT,
  "definition"  JSONB NOT NULL,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "archivedAt"  TIMESTAMP(3),

  CONSTRAINT "CanvasComponent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CanvasComponent_workspaceId_name_key"
  ON "CanvasComponent" ("workspaceId", "name");
CREATE INDEX "CanvasComponent_workspaceId_archivedAt_updatedAt_idx"
  ON "CanvasComponent" ("workspaceId", "archivedAt", "updatedAt");

ALTER TABLE "CanvasComponent"
  ADD CONSTRAINT "CanvasComponent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  ADD CONSTRAINT "CanvasComponent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id")      ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- New table: CanvasComponentInstance (per-canvas placed instance)
-- ---------------------------------------------------------------------------

CREATE TABLE "CanvasComponentInstance" (
  "id"            TEXT NOT NULL,
  "workspaceId"   TEXT NOT NULL,
  "canvasId"      TEXT NOT NULL,
  "componentId"   TEXT NOT NULL,
  "parentFrameId" TEXT,
  "groupId"       TEXT,
  "x"             DOUBLE PRECISION NOT NULL,
  "y"             DOUBLE PRECISION NOT NULL,
  "width"         DOUBLE PRECISION NOT NULL,
  "height"        DOUBLE PRECISION NOT NULL,
  "overrides"     JSONB,
  "z"             INTEGER NOT NULL DEFAULT 0,
  "lockedAt"      TIMESTAMP(3),
  "hiddenAt"      TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CanvasComponentInstance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CanvasComponentInstance_canvasId_z_idx"      ON "CanvasComponentInstance" ("canvasId", "z");
CREATE INDEX "CanvasComponentInstance_componentId_idx"    ON "CanvasComponentInstance" ("componentId");
CREATE INDEX "CanvasComponentInstance_parentFrameId_idx"  ON "CanvasComponentInstance" ("parentFrameId");
CREATE INDEX "CanvasComponentInstance_groupId_idx"        ON "CanvasComponentInstance" ("groupId");
CREATE INDEX "CanvasComponentInstance_workspaceId_idx"    ON "CanvasComponentInstance" ("workspaceId");

ALTER TABLE "CanvasComponentInstance"
  ADD CONSTRAINT "CanvasComponentInstance_workspaceId_fkey"   FOREIGN KEY ("workspaceId")   REFERENCES "Workspace"("id")       ON DELETE CASCADE  ON UPDATE CASCADE,
  ADD CONSTRAINT "CanvasComponentInstance_canvasId_fkey"      FOREIGN KEY ("canvasId")      REFERENCES "WorkspaceCanvas"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  ADD CONSTRAINT "CanvasComponentInstance_componentId_fkey"   FOREIGN KEY ("componentId")   REFERENCES "CanvasComponent"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  ADD CONSTRAINT "CanvasComponentInstance_parentFrameId_fkey" FOREIGN KEY ("parentFrameId") REFERENCES "CanvasFrame"("id")     ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CanvasComponentInstance_groupId_fkey"       FOREIGN KEY ("groupId")       REFERENCES "CanvasGroup"("id")     ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- New table: CanvasStyle (workspace-scoped reusable color/text/effect)
-- ---------------------------------------------------------------------------

CREATE TABLE "CanvasStyle" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "kind"        "CanvasStyleKind" NOT NULL,
  "name"        TEXT NOT NULL,
  "value"       JSONB NOT NULL,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "archivedAt"  TIMESTAMP(3),

  CONSTRAINT "CanvasStyle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CanvasStyle_workspaceId_kind_name_key"
  ON "CanvasStyle" ("workspaceId", "kind", "name");
CREATE INDEX "CanvasStyle_workspaceId_kind_idx"       ON "CanvasStyle" ("workspaceId", "kind");
CREATE INDEX "CanvasStyle_workspaceId_archivedAt_idx" ON "CanvasStyle" ("workspaceId", "archivedAt");

ALTER TABLE "CanvasStyle"
  ADD CONSTRAINT "CanvasStyle_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  ADD CONSTRAINT "CanvasStyle_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id")      ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- WorkspaceCanvasNode: parent frame / group / styleRefs / lock + hide
-- ---------------------------------------------------------------------------

ALTER TABLE "WorkspaceCanvasNode"
  ADD COLUMN "parentFrameId" TEXT,
  ADD COLUMN "groupId"       TEXT,
  ADD COLUMN "styleRefs"     JSONB,
  ADD COLUMN "lockedAt"      TIMESTAMP(3),
  ADD COLUMN "hiddenAt"      TIMESTAMP(3);

ALTER TABLE "WorkspaceCanvasNode"
  ADD CONSTRAINT "WorkspaceCanvasNode_parentFrameId_fkey" FOREIGN KEY ("parentFrameId") REFERENCES "CanvasFrame"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "WorkspaceCanvasNode_groupId_fkey"       FOREIGN KEY ("groupId")       REFERENCES "CanvasGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "WorkspaceCanvasNode_parentFrameId_idx" ON "WorkspaceCanvasNode" ("parentFrameId");
CREATE INDEX "WorkspaceCanvasNode_groupId_idx"       ON "WorkspaceCanvasNode" ("groupId");

-- ---------------------------------------------------------------------------
-- CanvasShape: parent frame / canvasGroupId / styleRefs / lock + hide
-- (existing free-form `groupId` string column preserved for back-compat)
-- ---------------------------------------------------------------------------

ALTER TABLE "CanvasShape"
  ADD COLUMN "canvasGroupId" TEXT,
  ADD COLUMN "parentFrameId" TEXT,
  ADD COLUMN "styleRefs"     JSONB,
  ADD COLUMN "lockedAt"      TIMESTAMP(3),
  ADD COLUMN "hiddenAt"      TIMESTAMP(3);

ALTER TABLE "CanvasShape"
  ADD CONSTRAINT "CanvasShape_parentFrameId_fkey" FOREIGN KEY ("parentFrameId") REFERENCES "CanvasFrame"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CanvasShape_canvasGroupId_fkey" FOREIGN KEY ("canvasGroupId") REFERENCES "CanvasGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "CanvasShape_parentFrameId_idx" ON "CanvasShape" ("parentFrameId");
CREATE INDEX "CanvasShape_canvasGroupId_idx" ON "CanvasShape" ("canvasGroupId");
