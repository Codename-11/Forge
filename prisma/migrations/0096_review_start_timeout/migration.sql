-- A delivered judge wake is not proof that review actually started. Give
-- each workspace a configurable window before Forge opens a human fallback.
ALTER TABLE "Workspace"
  ADD COLUMN "reviewStartTimeoutMinutes" INTEGER NOT NULL DEFAULT 5;
