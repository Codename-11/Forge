-- Forge Agentic Work OS — Wave 2: Artifact primitive.
--
-- Adds the durable, versionable output object that captures specs,
-- decisions, runbooks, reports, briefs, verification logs, and
-- accepted agent deliverables. The model splits into two tables:
--   * Artifact         — head row (canonical title/body/slug/status)
--   * ArtifactVersion  — append-only revision history (version numbers
--                        start at 1 and never gap; Artifact.currentVersionId
--                        points at the published row)
--
-- Workspace-scoped via `workspaceId` (cascades to children); soft-delete
-- via `archivedAt`; polymorphic source backlink via `sourceType`/`sourceId`.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE "ArtifactStatus" AS ENUM (
  'DRAFT',
  'IN_REVIEW',
  'ACCEPTED',
  'ARCHIVED'
);

CREATE TYPE "ArtifactType" AS ENUM (
  'DOCUMENT',
  'DECISION',
  'RUNBOOK',
  'REPORT',
  'SPEC',
  'BRIEF',
  'VERIFICATION'
);

-- ---------------------------------------------------------------------------
-- Artifact
-- ---------------------------------------------------------------------------

CREATE TABLE "Artifact" (
  "id"               TEXT NOT NULL,
  "workspaceId"      TEXT NOT NULL,
  "title"            TEXT NOT NULL,
  "slug"             TEXT NOT NULL,
  "type"             "ArtifactType" NOT NULL DEFAULT 'DOCUMENT',
  "status"           "ArtifactStatus" NOT NULL DEFAULT 'DRAFT',
  "body"             TEXT NOT NULL,
  "summary"          TEXT,
  "createdById"      TEXT,
  "createdByAgentId" TEXT,
  "sourceType"       TEXT,
  "sourceId"         TEXT,
  "currentVersionId" TEXT,
  "issueId"          TEXT,
  "projectId"        TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  "archivedAt"       TIMESTAMP(3),
  CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Artifact_workspaceId_slug_key"
  ON "Artifact"("workspaceId", "slug");

CREATE INDEX "Artifact_workspaceId_status_updatedAt_idx"
  ON "Artifact"("workspaceId", "status", "updatedAt");

CREATE INDEX "Artifact_workspaceId_type_updatedAt_idx"
  ON "Artifact"("workspaceId", "type", "updatedAt");

CREATE INDEX "Artifact_issueId_idx" ON "Artifact"("issueId");
CREATE INDEX "Artifact_projectId_idx" ON "Artifact"("projectId");

-- ---------------------------------------------------------------------------
-- ArtifactVersion
-- ---------------------------------------------------------------------------

CREATE TABLE "ArtifactVersion" (
  "id"               TEXT NOT NULL,
  "workspaceId"      TEXT NOT NULL,
  "artifactId"       TEXT NOT NULL,
  "version"          INTEGER NOT NULL,
  "title"            TEXT NOT NULL,
  "body"             TEXT NOT NULL,
  "summary"          TEXT,
  "changelog"        TEXT,
  "createdById"      TEXT,
  "createdByAgentId" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ArtifactVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArtifactVersion_artifactId_version_key"
  ON "ArtifactVersion"("artifactId", "version");

CREATE INDEX "ArtifactVersion_workspaceId_createdAt_idx"
  ON "ArtifactVersion"("workspaceId", "createdAt");

-- ---------------------------------------------------------------------------
-- Foreign keys (after both tables exist so the circular currentVersionId
-- reference can resolve)
-- ---------------------------------------------------------------------------

ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_createdByAgentId_fkey"
  FOREIGN KEY ("createdByAgentId") REFERENCES "Agent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "Issue"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_currentVersionId_fkey"
  FOREIGN KEY ("currentVersionId") REFERENCES "ArtifactVersion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_artifactId_fkey"
  FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_createdByAgentId_fkey"
  FOREIGN KEY ("createdByAgentId") REFERENCES "Agent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
