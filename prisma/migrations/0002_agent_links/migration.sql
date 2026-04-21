-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "lastDispatchedAt" TIMESTAMP(3),
ADD COLUMN     "webhookSecret" TEXT;

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "linkedAgentId" TEXT;

-- CreateIndex
CREATE INDEX "ApiKey_linkedAgentId_idx" ON "ApiKey"("linkedAgentId");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_linkedAgentId_fkey" FOREIGN KEY ("linkedAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

