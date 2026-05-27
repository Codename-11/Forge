-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "requireApprovalBeforeStart" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AgentProfile" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "requestedById" TEXT;

-- CreateIndex
CREATE INDEX "AgentProfile_requestedById_idx" ON "AgentProfile"("requestedById");

-- AddForeignKey
ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
