-- CreateEnum
CREATE TYPE "ApiKeyKind" AS ENUM ('AGENT', 'PERSONAL', 'SESSION');

-- AlterTable: add column with AGENT default
ALTER TABLE "ApiKey" ADD COLUMN "kind" "ApiKeyKind" NOT NULL DEFAULT 'AGENT';

-- Backfill: rows without an agent link are PERSONAL by intent
UPDATE "ApiKey" SET "kind" = 'PERSONAL' WHERE "linkedAgentId" IS NULL;
