-- Per-thread runtime permission override for chat.
ALTER TABLE "ChatThread"
  ADD COLUMN "yoloModeOverride" BOOLEAN;
