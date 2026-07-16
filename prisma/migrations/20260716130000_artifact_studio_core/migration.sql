-- AXI-86: Artifact Studio core contracts.
-- Existing artifacts remain workspace-visible. New artifacts default private.

CREATE TYPE "ArtifactVisibility" AS ENUM ('PRIVATE', 'WORKSPACE');
CREATE TYPE "ArtifactRole" AS ENUM ('VIEWER', 'COMMENTER', 'EDITOR', 'OWNER');
CREATE TYPE "ArtifactContentType" AS ENUM ('MARKDOWN', 'TEXT', 'CODE', 'IMAGE', 'DATA', 'FILE', 'HTML');
CREATE TYPE "ArtifactCommentStatus" AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE "ArtifactPublicationAudience" AS ENUM ('LINK', 'WORKSPACE');
CREATE TYPE "ArtifactPublicationStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');
CREATE TYPE "ArtifactDeploymentProvider" AS ENUM ('ARTIFACT_PREVIEW');
CREATE TYPE "ArtifactDeploymentStatus" AS ENUM ('PENDING', 'DEPLOYING', 'READY', 'FAILED', 'RETIRED');
CREATE TYPE "ArtifactAgentPublishPolicy" AS ENUM ('NEVER', 'REQUIRE_APPROVAL', 'ALLOW');

ALTER TABLE "Artifact"
  ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "acceptedById" TEXT,
  ADD COLUMN "acceptedVersionId" TEXT,
  ADD COLUMN "publishedVersionId" TEXT,
  ADD COLUMN "reviewRequestedAt" TIMESTAMP(3),
  ADD COLUMN "visibility" "ArtifactVisibility" NOT NULL DEFAULT 'WORKSPACE';

-- Accepted legacy artifacts are treated as having their current immutable
-- version accepted and published. Draft and in-review artifacts remain live
-- only inside the workspace and have no publication pointer.
UPDATE "Artifact"
SET "acceptedVersionId" = "currentVersionId",
    "publishedVersionId" = "currentVersionId",
    "acceptedAt" = "updatedAt"
WHERE "status" = 'ACCEPTED' AND "currentVersionId" IS NOT NULL;

ALTER TABLE "Artifact" ALTER COLUMN "visibility" SET DEFAULT 'PRIVATE';

ALTER TABLE "ArtifactVersion"
  ADD COLUMN "assetManifest" JSONB,
  ADD COLUMN "contentChecksum" TEXT,
  ADD COLUMN "contentType" "ArtifactContentType" NOT NULL DEFAULT 'MARKDOWN',
  ADD COLUMN "rendererVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "restoredFromVersionId" TEXT;

ALTER TABLE "Workspace"
  ADD COLUMN "artifactAgentPublishPolicy" "ArtifactAgentPublishPolicy" NOT NULL DEFAULT 'REQUIRE_APPROVAL',
  ADD COLUMN "artifactDefaultLinkExpiryDays" INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN "artifactExternalSharingEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "artifactPreviewEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "artifactPublicPublishingEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ArtifactGrant" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "userId" TEXT,
  "agentId" TEXT,
  "role" "ArtifactRole" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ArtifactGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ArtifactGrant_one_principal_check"
    CHECK (num_nonnulls("userId", "agentId") = 1)
);

CREATE TABLE "ArtifactComment" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "versionId" TEXT,
  "parentId" TEXT,
  "authorId" TEXT,
  "authoringAgentId" TEXT,
  "body" TEXT NOT NULL,
  "status" "ArtifactCommentStatus" NOT NULL DEFAULT 'OPEN',
  "anchor" JSONB,
  "quotedText" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolvedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "ArtifactComment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArtifactPublication" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "audience" "ArtifactPublicationAudience" NOT NULL DEFAULT 'LINK',
  "status" "ArtifactPublicationStatus" NOT NULL DEFAULT 'ACTIVE',
  "tokenHash" TEXT,
  "tokenPrefix" TEXT,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdById" TEXT,
  "revokedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ArtifactPublication_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArtifactDeployment" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "publicationId" TEXT,
  "provider" "ArtifactDeploymentProvider" NOT NULL DEFAULT 'ARTIFACT_PREVIEW',
  "status" "ArtifactDeploymentStatus" NOT NULL DEFAULT 'PENDING',
  "externalId" TEXT,
  "externalUrl" TEXT,
  "bundleChecksum" TEXT,
  "errorMessage" TEXT,
  "createdById" TEXT,
  "createdByAgentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deployedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  CONSTRAINT "ArtifactDeployment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ArtifactGrant_workspaceId_userId_idx" ON "ArtifactGrant"("workspaceId", "userId");
CREATE INDEX "ArtifactGrant_workspaceId_agentId_idx" ON "ArtifactGrant"("workspaceId", "agentId");
CREATE UNIQUE INDEX "ArtifactGrant_artifactId_userId_key" ON "ArtifactGrant"("artifactId", "userId");
CREATE UNIQUE INDEX "ArtifactGrant_artifactId_agentId_key" ON "ArtifactGrant"("artifactId", "agentId");
CREATE INDEX "ArtifactComment_artifactId_status_createdAt_idx" ON "ArtifactComment"("artifactId", "status", "createdAt");
CREATE INDEX "ArtifactComment_versionId_createdAt_idx" ON "ArtifactComment"("versionId", "createdAt");
CREATE INDEX "ArtifactComment_parentId_idx" ON "ArtifactComment"("parentId");
CREATE UNIQUE INDEX "ArtifactPublication_tokenHash_key" ON "ArtifactPublication"("tokenHash");
CREATE INDEX "ArtifactPublication_artifactId_status_createdAt_idx" ON "ArtifactPublication"("artifactId", "status", "createdAt");
CREATE INDEX "ArtifactPublication_workspaceId_status_expiresAt_idx" ON "ArtifactPublication"("workspaceId", "status", "expiresAt");
CREATE INDEX "ArtifactDeployment_artifactId_status_createdAt_idx" ON "ArtifactDeployment"("artifactId", "status", "createdAt");
CREATE INDEX "ArtifactDeployment_publicationId_idx" ON "ArtifactDeployment"("publicationId");
CREATE UNIQUE INDEX "ArtifactDeployment_provider_externalId_key" ON "ArtifactDeployment"("provider", "externalId");
CREATE INDEX "Artifact_workspaceId_visibility_updatedAt_idx" ON "Artifact"("workspaceId", "visibility", "updatedAt");
CREATE INDEX "ArtifactVersion_artifactId_contentChecksum_idx" ON "ArtifactVersion"("artifactId", "contentChecksum");

ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_acceptedVersionId_fkey" FOREIGN KEY ("acceptedVersionId") REFERENCES "ArtifactVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES "ArtifactVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_restoredFromVersionId_fkey" FOREIGN KEY ("restoredFromVersionId") REFERENCES "ArtifactVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ArtifactGrant" ADD CONSTRAINT "ArtifactGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtifactGrant" ADD CONSTRAINT "ArtifactGrant_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtifactGrant" ADD CONSTRAINT "ArtifactGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtifactGrant" ADD CONSTRAINT "ArtifactGrant_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArtifactComment" ADD CONSTRAINT "ArtifactComment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtifactComment" ADD CONSTRAINT "ArtifactComment_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtifactComment" ADD CONSTRAINT "ArtifactComment_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ArtifactVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ArtifactComment" ADD CONSTRAINT "ArtifactComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ArtifactComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtifactComment" ADD CONSTRAINT "ArtifactComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ArtifactComment" ADD CONSTRAINT "ArtifactComment_authoringAgentId_fkey" FOREIGN KEY ("authoringAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ArtifactComment" ADD CONSTRAINT "ArtifactComment_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ArtifactPublication" ADD CONSTRAINT "ArtifactPublication_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtifactPublication" ADD CONSTRAINT "ArtifactPublication_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtifactPublication" ADD CONSTRAINT "ArtifactPublication_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ArtifactVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ArtifactPublication" ADD CONSTRAINT "ArtifactPublication_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ArtifactPublication" ADD CONSTRAINT "ArtifactPublication_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ArtifactDeployment" ADD CONSTRAINT "ArtifactDeployment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtifactDeployment" ADD CONSTRAINT "ArtifactDeployment_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArtifactDeployment" ADD CONSTRAINT "ArtifactDeployment_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ArtifactVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ArtifactDeployment" ADD CONSTRAINT "ArtifactDeployment_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "ArtifactPublication"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ArtifactDeployment" ADD CONSTRAINT "ArtifactDeployment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ArtifactDeployment" ADD CONSTRAINT "ArtifactDeployment_createdByAgentId_fkey" FOREIGN KEY ("createdByAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
