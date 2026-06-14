-- Promote the per-runtime RuntimeGithubApp to a workspace-scoped, shareable
-- GithubApp; add Runtime.githubAppId link and per-project repo bindings.
-- RuntimeGithubApp shipped with zero data (no runtime had one configured), so
-- dropping it is safe.

-- DropTable (per-runtime app — superseded by workspace-scoped GithubApp)
DROP TABLE IF EXISTS "RuntimeGithubApp";

-- CreateTable
CREATE TABLE "GithubApp" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "installationId" TEXT,
    "privateKeyEnc" TEXT NOT NULL,
    "slug" TEXT,
    "clientId" TEXT,
    "createdViaManifest" BOOLEAN NOT NULL DEFAULT false,
    "lastMintedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubApp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GithubApp_workspaceId_idx" ON "GithubApp"("workspaceId");

-- AddForeignKey
ALTER TABLE "GithubApp" ADD CONSTRAINT "GithubApp_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: link a runtime to a shared GithubApp
ALTER TABLE "Runtime" ADD COLUMN "githubAppId" TEXT;

-- CreateIndex
CREATE INDEX "Runtime_githubAppId_idx" ON "Runtime"("githubAppId");

-- AddForeignKey
ALTER TABLE "Runtime" ADD CONSTRAINT "Runtime_githubAppId_fkey" FOREIGN KEY ("githubAppId") REFERENCES "GithubApp"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: per-project repo binding
ALTER TABLE "Project" ADD COLUMN "repoUrl" TEXT;
ALTER TABLE "Project" ADD COLUMN "repoBranch" TEXT;
