-- Forge Agentic Work OS — Wave 10: WorkspaceCanvas (spike).
--
-- Adds the infinite spatial canvas primitive. Canvases store only
-- layout + entity refs; canonical content lives on the source row so
-- a canvas can never become a second source of truth.
--
--   * WorkspaceCanvas      — head row with viewport + scope anchor
--   * WorkspaceCanvasNode  — card on the canvas (polymorphic ref)
--   * WorkspaceCanvasEdge  — directional connection between two nodes

CREATE TABLE "WorkspaceCanvas" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "scopeType"   TEXT,
  "scopeId"     TEXT,
  "viewport"    JSONB,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "archivedAt"  TIMESTAMP(3),
  CONSTRAINT "WorkspaceCanvas_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkspaceCanvas_workspaceId_scopeType_scopeId_idx"
  ON "WorkspaceCanvas"("workspaceId", "scopeType", "scopeId");
CREATE INDEX "WorkspaceCanvas_workspaceId_updatedAt_idx"
  ON "WorkspaceCanvas"("workspaceId", "updatedAt");

CREATE TABLE "WorkspaceCanvasNode" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "canvasId"    TEXT NOT NULL,
  "targetType"  TEXT NOT NULL,
  "targetId"    TEXT NOT NULL,
  "x"           DOUBLE PRECISION NOT NULL,
  "y"           DOUBLE PRECISION NOT NULL,
  "width"       DOUBLE PRECISION NOT NULL,
  "height"      DOUBLE PRECISION NOT NULL,
  "zIndex"      INTEGER NOT NULL DEFAULT 0,
  "collapsed"   BOOLEAN NOT NULL DEFAULT false,
  "viewMode"    TEXT,
  "meta"        JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceCanvasNode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkspaceCanvasNode_canvasId_zIndex_idx"
  ON "WorkspaceCanvasNode"("canvasId", "zIndex");
CREATE INDEX "WorkspaceCanvasNode_workspaceId_targetType_targetId_idx"
  ON "WorkspaceCanvasNode"("workspaceId", "targetType", "targetId");

CREATE TABLE "WorkspaceCanvasEdge" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "canvasId"    TEXT NOT NULL,
  "fromNodeId"  TEXT NOT NULL,
  "toNodeId"    TEXT NOT NULL,
  "label"       TEXT,
  "kind"        TEXT,
  "meta"        JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceCanvasEdge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkspaceCanvasEdge_canvasId_idx"
  ON "WorkspaceCanvasEdge"("canvasId");

ALTER TABLE "WorkspaceCanvas" ADD CONSTRAINT "WorkspaceCanvas_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceCanvas" ADD CONSTRAINT "WorkspaceCanvas_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkspaceCanvasNode" ADD CONSTRAINT "WorkspaceCanvasNode_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceCanvasNode" ADD CONSTRAINT "WorkspaceCanvasNode_canvasId_fkey"
  FOREIGN KEY ("canvasId") REFERENCES "WorkspaceCanvas"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceCanvasEdge" ADD CONSTRAINT "WorkspaceCanvasEdge_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceCanvasEdge" ADD CONSTRAINT "WorkspaceCanvasEdge_canvasId_fkey"
  FOREIGN KEY ("canvasId") REFERENCES "WorkspaceCanvas"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
