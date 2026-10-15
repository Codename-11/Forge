CREATE TYPE "ResourceOwnerType" AS ENUM ('PERSONAL', 'SERVICE', 'UNASSIGNED');
CREATE TYPE "PersonalAgentCreation" AS ENUM ('DISABLED', 'APPROVAL_REQUIRED', 'SELF_SERVICE');

ALTER TABLE "AgentProfile"
  ADD COLUMN "ownerType" "ResourceOwnerType" NOT NULL DEFAULT 'PERSONAL',
  ADD COLUMN "createdById" TEXT,
  ALTER COLUMN "ownerId" DROP NOT NULL;
ALTER TABLE "Runtime"
  ADD COLUMN "ownerType" "ResourceOwnerType" NOT NULL DEFAULT 'UNASSIGNED',
  ADD COLUMN "createdById" TEXT;

-- Keep existing human ownership. Do not invent a service owner or historical creator.
UPDATE "Runtime" SET "ownerType" = 'PERSONAL' WHERE "ownerId" IS NOT NULL;

ALTER TABLE "AgentProfile" DROP CONSTRAINT "AgentProfile_ownerId_fkey";
ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Runtime" DROP CONSTRAINT "Runtime_ownerId_fkey";
ALTER TABLE "Runtime" ADD CONSTRAINT "Runtime_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Runtime" ADD CONSTRAINT "Runtime_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_owner_shape_check" CHECK (
  ("ownerType" = 'PERSONAL' AND "ownerId" IS NOT NULL) OR
  ("ownerType" = 'SERVICE' AND "ownerId" IS NULL)
);
ALTER TABLE "Runtime" ADD CONSTRAINT "Runtime_owner_shape_check" CHECK (
  ("ownerType" = 'PERSONAL' AND "ownerId" IS NOT NULL) OR
  ("ownerType" IN ('SERVICE', 'UNASSIGNED') AND "ownerId" IS NULL)
);
-- SQL partial uniqueness covers service identities with no human owner.
CREATE UNIQUE INDEX "AgentProfile_service_profileKey_key" ON "AgentProfile"("profileKey") WHERE "ownerType" = 'SERVICE';

CREATE TABLE "InstanceAgentPolicy" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "personalAgentCreation" "PersonalAgentCreation" NOT NULL DEFAULT 'APPROVAL_REQUIRED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InstanceAgentPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InstanceAgentPolicy_singleton_check" CHECK ("id" = 'default')
);
