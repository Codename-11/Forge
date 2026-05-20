-- Per-workspace Mission Control default-tab override.
--
-- The global `User.missionControlDefaultTab` (migration 0042) is still
-- the fallback. This column lets an operator set a different default
-- per workspace. Null = use the user-global default.

ALTER TABLE "Membership" ADD COLUMN "missionControlDefaultTab" TEXT;
