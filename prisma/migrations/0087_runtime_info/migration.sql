-- Structured runtime version/environment metadata for operator display.
ALTER TABLE "Runtime" ADD COLUMN "runtimeInfo" JSONB;
ALTER TABLE "Runtime" ADD COLUMN "lastInfoAt" TIMESTAMP(3);
