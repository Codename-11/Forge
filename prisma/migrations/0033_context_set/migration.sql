-- Forge Agentic Work OS — Wave 4: ContextSet primitive.
--
-- Adds:
--   * ContextSet — reusable bundle of canonical refs an agent receives
--     as context. Owned by a user OR an agent (mutually exclusive in
--     practice; the schema allows either to be set).
--   * ContextSetItem — polymorphic targetType/targetId rows attached
--     to a ContextSet, with an includeMode (INCLUDE/EXCLUDE/SUMMARY_ONLY)
--     and ordering position.
--
-- Workspace-scoped via `workspaceId`. Soft-delete via `archivedAt`.

CREATE TABLE "ContextSet" (
  "id"           TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "ownerUserId"  TEXT,
  "ownerAgentId" TEXT,
  "policy"       JSONB,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  "archivedAt"   TIMESTAMP(3),
  CONSTRAINT "ContextSet_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContextSet_workspaceId_updatedAt_idx"
  ON "ContextSet"("workspaceId", "updatedAt");

CREATE INDEX "ContextSet_workspaceId_ownerUserId_idx"
  ON "ContextSet"("workspaceId", "ownerUserId");

CREATE TABLE "ContextSetItem" (
  "id"           TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "contextSetId" TEXT NOT NULL,
  "targetType"   TEXT NOT NULL,
  "targetId"     TEXT NOT NULL,
  "includeMode"  TEXT NOT NULL DEFAULT 'INCLUDE',
  "position"     INTEGER NOT NULL DEFAULT 0,
  "note"         TEXT,
  CONSTRAINT "ContextSetItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContextSetItem_contextSetId_targetType_targetId_key"
  ON "ContextSetItem"("contextSetId", "targetType", "targetId");

CREATE INDEX "ContextSetItem_workspaceId_targetType_targetId_idx"
  ON "ContextSetItem"("workspaceId", "targetType", "targetId");

CREATE INDEX "ContextSetItem_contextSetId_position_idx"
  ON "ContextSetItem"("contextSetId", "position");

ALTER TABLE "ContextSet" ADD CONSTRAINT "ContextSet_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContextSet" ADD CONSTRAINT "ContextSet_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ContextSet" ADD CONSTRAINT "ContextSet_ownerAgentId_fkey"
  FOREIGN KEY ("ownerAgentId") REFERENCES "Agent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ContextSetItem" ADD CONSTRAINT "ContextSetItem_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContextSetItem" ADD CONSTRAINT "ContextSetItem_contextSetId_fkey"
  FOREIGN KEY ("contextSetId") REFERENCES "ContextSet"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
