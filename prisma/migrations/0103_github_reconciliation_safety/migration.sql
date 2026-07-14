ALTER TABLE "Workspace"
  ADD COLUMN "githubRequestTimeoutSeconds" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "githubSweepBudgetSeconds" INTEGER NOT NULL DEFAULT 45,
  ADD COLUMN "githubClosedReprobeMinutes" INTEGER NOT NULL DEFAULT 1440,
  ADD COLUMN "githubManualCooldownSeconds" INTEGER NOT NULL DEFAULT 30;
