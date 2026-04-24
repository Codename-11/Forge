-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "authoringAgentId" TEXT;

-- CreateIndex
CREATE INDEX "Comment_authoringAgentId_idx" ON "Comment"("authoringAgentId");

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authoringAgentId_fkey" FOREIGN KEY ("authoringAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
