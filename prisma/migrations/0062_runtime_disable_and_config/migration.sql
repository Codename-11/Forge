-- Runtime soft kill-switch + adapter-specific config.
-- Additive only: both columns are nullable, so existing rows are unaffected
-- (NULL disabledAt = enabled; NULL config = adapter defaults). Applies on
-- prod boot via `migrate deploy`.
ALTER TABLE "Runtime" ADD COLUMN "disabledAt" TIMESTAMP(3);
ALTER TABLE "Runtime" ADD COLUMN "config" JSONB;
