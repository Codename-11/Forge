-- Add agent attribution for issue claims. `claimedById` (a User) records the
-- api-key owner; `claimedByAgentId` records the agent that actually claimed via
-- `issues.claim`, so the UI can attribute the claim to the agent. Null for
-- human claims. SetNull on agent delete mirrors `assignedAgentId`.

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN "claimedByAgentId" TEXT;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_claimedByAgentId_fkey" FOREIGN KEY ("claimedByAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
