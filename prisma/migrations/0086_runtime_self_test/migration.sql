CREATE TYPE "RuntimeSelfTestStatus" AS ENUM ('PASSED', 'FAILED', 'UNSUPPORTED');

ALTER TABLE "Runtime"
  ADD COLUMN "lastSelfTestAt" TIMESTAMP(3),
  ADD COLUMN "lastSelfTestStatus" "RuntimeSelfTestStatus",
  ADD COLUMN "lastSelfTestDetail" TEXT,
  ADD COLUMN "lastSelfTestDurationMs" INTEGER;
