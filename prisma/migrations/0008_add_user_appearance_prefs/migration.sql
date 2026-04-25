-- Per-user appearance preferences (saved server-side, loaded by the
-- AppearanceProvider on the workspace shell). `density` controls spacing
-- and identifier sizes; `textSize` overlays a +1px bump on top.
--
-- Both columns are nullable; null === "compact" / "default" (the current
-- behavior). No backfill needed — existing rows simply read as defaults.
ALTER TABLE "User" ADD COLUMN "density" TEXT;
ALTER TABLE "User" ADD COLUMN "textSize" TEXT;
