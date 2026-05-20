-- Canvas v2 — Phase 2: drawing primitives (Excalidraw-style).
--
-- Adds CanvasShape: pure visual annotations (box, ellipse, line, arrow,
-- text, freehand) that live on a canvas alongside the existing
-- entity-backed WorkspaceCanvasNode rows. Shapes don't reference
-- Forge entities; they're for ideation and grouping.

CREATE TABLE "CanvasShape" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "canvasId"    TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "x"           DOUBLE PRECISION NOT NULL,
  "y"           DOUBLE PRECISION NOT NULL,
  "width"       DOUBLE PRECISION,
  "height"      DOUBLE PRECISION,
  "path"        JSONB,
  "style"       JSONB,
  "text"        TEXT,
  "zIndex"      INTEGER NOT NULL DEFAULT 0,
  "groupId"     TEXT,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CanvasShape_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CanvasShape_canvasId_zIndex_idx"
  ON "CanvasShape"("canvasId", "zIndex");
CREATE INDEX "CanvasShape_workspaceId_idx"
  ON "CanvasShape"("workspaceId");

ALTER TABLE "CanvasShape" ADD CONSTRAINT "CanvasShape_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CanvasShape" ADD CONSTRAINT "CanvasShape_canvasId_fkey"
  FOREIGN KEY ("canvasId") REFERENCES "WorkspaceCanvas"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CanvasShape" ADD CONSTRAINT "CanvasShape_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
