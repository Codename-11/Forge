ALTER TABLE "IssueWatcher" ADD COLUMN "wakeOnActivity" BOOLEAN NOT NULL DEFAULT false;

UPDATE "IssueWatcher" w
SET "wakeOnActivity" = true
FROM "Issue" i
WHERE w."issueId" = i.id
  AND w."agentId" IS NOT NULL
  AND i."assignedAgentId" = w."agentId";
