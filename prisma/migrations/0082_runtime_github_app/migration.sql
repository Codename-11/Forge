-- CreateTable
CREATE TABLE "RuntimeGithubApp" (
    "id" TEXT NOT NULL,
    "runtimeId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "slug" TEXT,
    "lastMintedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuntimeGithubApp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeGithubApp_runtimeId_key" ON "RuntimeGithubApp"("runtimeId");

-- CreateIndex
CREATE INDEX "RuntimeGithubApp_workspaceId_idx" ON "RuntimeGithubApp"("workspaceId");

-- AddForeignKey
ALTER TABLE "RuntimeGithubApp" ADD CONSTRAINT "RuntimeGithubApp_runtimeId_fkey" FOREIGN KEY ("runtimeId") REFERENCES "Runtime"("id") ON DELETE CASCADE ON UPDATE CASCADE;
