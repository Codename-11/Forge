-- ProviderCredential: per-workspace chat-model credentials (DB-backed,
-- AES-256-GCM apiKeyEnc). Takes precedence over env for that providerId.
CREATE TABLE "ProviderCredential" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "label" TEXT,
    "baseUrl" TEXT,
    "apiKeyEnc" TEXT,
    "defaultModel" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderCredential_workspaceId_providerId_key" ON "ProviderCredential"("workspaceId", "providerId");
CREATE INDEX "ProviderCredential_workspaceId_idx" ON "ProviderCredential"("workspaceId");

ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
