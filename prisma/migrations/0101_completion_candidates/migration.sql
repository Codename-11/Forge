-- Settings-driven completion automation and durable shared candidate dedupe.
CREATE TYPE "CompletionAutomation" AS ENUM ('OFF', 'RECOMMEND', 'AUTO_WHEN_SAFE');

ALTER TABLE "Workspace"
  ADD COLUMN "completionAutomation" "CompletionAutomation" NOT NULL DEFAULT 'RECOMMEND',
  ADD COLUMN "completionStatusId" TEXT;

ALTER TABLE "Project"
  ADD COLUMN "completionAutomation" "CompletionAutomation";

ALTER TABLE "ActionRequest"
  ADD COLUMN "dedupeKey" TEXT;

ALTER TABLE "Workspace"
  ADD CONSTRAINT "Workspace_completionStatusId_fkey"
  FOREIGN KEY ("completionStatusId") REFERENCES "Status"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ActionRequest_workspaceId_dedupeKey_idx"
  ON "ActionRequest"("workspaceId", "dedupeKey");

CREATE UNIQUE INDEX "ActionRequest_open_generic_dedupe"
  ON "ActionRequest"("workspaceId", "dedupeKey")
  WHERE "status" = 'OPEN' AND "dedupeKey" IS NOT NULL;

-- Existing workspaces already have at least one DONE status. Choose the first
-- configured position as the safe default; admins can change or clear it.
UPDATE "Workspace" w
SET "completionStatusId" = (
  SELECT s."id"
  FROM "Status" s
  WHERE s."workspaceId" = w."id" AND s."category" = 'DONE'
  ORDER BY s."position" ASC, s."id" ASC
  LIMIT 1
);
