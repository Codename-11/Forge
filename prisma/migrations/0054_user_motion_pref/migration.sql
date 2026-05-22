-- Per-user motion preference. "full" (default, ambient motion on) |
-- "reduced" (freeze the forge-* motion layer to static fallbacks via
-- data-motion="off"). Nullable; null = "full".

-- AlterTable
ALTER TABLE "User" ADD COLUMN "motion" TEXT;
