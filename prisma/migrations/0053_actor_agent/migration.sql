-- Attribute agent-performed actions to the Agent (actor), keeping the human
-- key-owner (`actorId`) as secondary metadata. Nullable FK on both the audit
-- and activity streams; SetNull on agent delete.

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "actorAgentId" TEXT;

-- AlterTable
ALTER TABLE "ActivityEvent" ADD COLUMN "actorAgentId" TEXT;

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_actorAgentId_idx" ON "AuditLog"("workspaceId", "actorAgentId");

-- CreateIndex
CREATE INDEX "ActivityEvent_workspaceId_actorAgentId_createdAt_idx" ON "ActivityEvent"("workspaceId", "actorAgentId", "createdAt");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorAgentId_fkey" FOREIGN KEY ("actorAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_actorAgentId_fkey" FOREIGN KEY ("actorAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
