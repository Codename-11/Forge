-- CreateEnum
CREATE TYPE "InstanceRole" AS ENUM ('INSTANCE_ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "ConnectionProvider" AS ENUM ('OIDC', 'GITHUB', 'GOOGLE', 'SLACK', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('CONNECTED', 'DEGRADED', 'DISCONNECTED');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "autoDispatchEligible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "engagementMode" "EngagementMode",
ADD COLUMN     "profileId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "instanceRole" "InstanceRole" NOT NULL DEFAULT 'MEMBER';

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "provider" "ConnectionProvider" NOT NULL,
    "label" TEXT NOT NULL,
    "account" TEXT,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "config" JSONB,
    "tokenEnc" TEXT,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionMapping" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'inbound+outbound',
    "labelIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "routeTo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectionMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentProfile" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "profileKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "avatar" TEXT,
    "provider" "AgentProvider" NOT NULL DEFAULT 'HERMES',
    "runtimeMode" "AgentRuntimeMode" NOT NULL DEFAULT 'PERSISTENT',
    "runEngine" "RunEngine",
    "webhookUrl" TEXT,
    "webhookSecret" TEXT,
    "runtimeId" TEXT,
    "baseCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "role" "AgentRole" NOT NULL DEFAULT 'WORKER',
    "templateMarkdown" TEXT,
    "instanceShared" BOOLEAN NOT NULL DEFAULT false,
    "disabledAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Connection_ownerId_idx" ON "Connection"("ownerId");

-- CreateIndex
CREATE INDEX "Connection_provider_idx" ON "Connection"("provider");

-- CreateIndex
CREATE INDEX "ConnectionMapping_workspaceId_idx" ON "ConnectionMapping"("workspaceId");

-- CreateIndex
CREATE INDEX "ConnectionMapping_connectionId_idx" ON "ConnectionMapping"("connectionId");

-- CreateIndex
CREATE INDEX "AgentProfile_ownerId_idx" ON "AgentProfile"("ownerId");

-- CreateIndex
CREATE INDEX "AgentProfile_instanceShared_idx" ON "AgentProfile"("instanceShared");

-- CreateIndex
CREATE INDEX "AgentProfile_runtimeId_idx" ON "AgentProfile"("runtimeId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfile_ownerId_profileKey_key" ON "AgentProfile"("ownerId", "profileKey");

-- CreateIndex
CREATE INDEX "Agent_profileId_idx" ON "Agent"("profileId");

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionMapping" ADD CONSTRAINT "ConnectionMapping_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionMapping" ADD CONSTRAINT "ConnectionMapping_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_runtimeId_fkey" FOREIGN KEY ("runtimeId") REFERENCES "Runtime"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
