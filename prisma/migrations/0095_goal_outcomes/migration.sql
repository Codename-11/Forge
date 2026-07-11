ALTER TABLE "Goal"
  ADD COLUMN "successCriteria" TEXT,
  ADD COLUMN "outcomeSummary" TEXT,
  ADD COLUMN "targetDate" TIMESTAMP(3);

CREATE INDEX "Goal_workspaceId_targetDate_idx"
  ON "Goal"("workspaceId", "targetDate");
