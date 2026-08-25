-- CreateEnum
CREATE TYPE "AuthenticationMode" AS ENUM ('LOCAL_ONLY', 'EXTERNAL_ONLY', 'HYBRID');

-- CreateEnum
CREATE TYPE "RegistrationMode" AS ENUM ('DISABLED', 'INVITE_ONLY', 'OPEN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "UserActionTokenType" AS ENUM ('ACCOUNT_SETUP', 'PASSWORD_RESET', 'EMAIL_VERIFICATION');

-- AlterTable: add identity lifecycle columns without changing current access.
ALTER TABLE "User"
  ADD COLUMN "normalizedEmail" TEXT,
  ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastLoginAt" TIMESTAMP(3),
  ADD COLUMN "disabledAt" TIMESTAMP(3),
  ADD COLUMN "deletedAt" TIMESTAMP(3);

UPDATE "User"
SET "normalizedEmail" = lower(trim("email"));

-- Fail explicitly rather than silently merging pre-existing case variants.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User"
    GROUP BY "normalizedEmail"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enable normalized user emails: case-insensitive duplicates exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "User_normalizedEmail_key" ON "User"("normalizedEmail");
CREATE UNIQUE INDEX "User_email_case_insensitive_key" ON "User" (lower(trim("email")));

-- AlterTable
ALTER TABLE "SsoProvider" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "InstanceAuthPolicy" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "mode" "AuthenticationMode" NOT NULL DEFAULT 'HYBRID',
  "registrationMode" "RegistrationMode" NOT NULL DEFAULT 'INVITE_ONLY',
  "breakGlassCredentialsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "autoRedirectProviderId" TEXT,
  "passwordMinLength" INTEGER NOT NULL DEFAULT 12,
  "passwordResetTtlMinutes" INTEGER NOT NULL DEFAULT 30,
  "lockoutThreshold" INTEGER NOT NULL DEFAULT 10,
  "lockoutMinutes" INTEGER NOT NULL DEFAULT 15,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InstanceAuthPolicy_pkey" PRIMARY KEY ("id")
);

-- Preserve the pre-policy behavior: credentials and configured external
-- providers remain available, with the environment operator as break glass.
INSERT INTO "InstanceAuthPolicy" (
  "id",
  "mode",
  "registrationMode",
  "breakGlassCredentialsEnabled",
  "updatedAt"
) VALUES ('default', 'HYBRID', 'INVITE_ONLY', true, CURRENT_TIMESTAMP);

-- CreateTable
CREATE TABLE "LocalCredential" (
  "userId" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
  "failedAttempts" INTEGER NOT NULL DEFAULT 0,
  "lastFailedAt" TIMESTAMP(3),
  "lockedUntil" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LocalCredential_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "UserActionToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "UserActionTokenType" NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "emailSnapshot" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "UserActionToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstanceAuditLog" (
  "id" TEXT NOT NULL,
  "actorId" TEXT,
  "targetUserId" TEXT,
  "action" TEXT NOT NULL,
  "metadata" JSONB,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InstanceAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserAvatar" (
  "userId" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "etag" TEXT,
  "fallbackImage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UserAvatar_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserActionToken_tokenHash_key" ON "UserActionToken"("tokenHash");
CREATE INDEX "UserActionToken_userId_type_expiresAt_idx" ON "UserActionToken"("userId", "type", "expiresAt");
CREATE INDEX "InstanceAuditLog_actorId_createdAt_idx" ON "InstanceAuditLog"("actorId", "createdAt");
CREATE INDEX "InstanceAuditLog_targetUserId_createdAt_idx" ON "InstanceAuditLog"("targetUserId", "createdAt");
CREATE INDEX "InstanceAuditLog_action_createdAt_idx" ON "InstanceAuditLog"("action", "createdAt");
CREATE UNIQUE INDEX "UserAvatar_objectKey_key" ON "UserAvatar"("objectKey");

-- AddForeignKey
ALTER TABLE "InstanceAuthPolicy"
  ADD CONSTRAINT "InstanceAuthPolicy_autoRedirectProviderId_fkey"
  FOREIGN KEY ("autoRedirectProviderId") REFERENCES "SsoProvider"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LocalCredential"
  ADD CONSTRAINT "LocalCredential_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserActionToken"
  ADD CONSTRAINT "UserActionToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InstanceAuditLog"
  ADD CONSTRAINT "InstanceAuditLog_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InstanceAuditLog"
  ADD CONSTRAINT "InstanceAuditLog_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UserAvatar"
  ADD CONSTRAINT "UserAvatar_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
