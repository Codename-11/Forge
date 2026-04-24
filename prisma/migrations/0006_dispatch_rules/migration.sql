-- CreateTable
CREATE TABLE "DispatchRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL,
    "priority" "Priority",
    "labelId" TEXT,
    "projectId" TEXT,
    "targetAgentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DispatchRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DispatchRule_workspaceId_enabled_order_idx" ON "DispatchRule"("workspaceId", "enabled", "order");

-- AddForeignKey
ALTER TABLE "DispatchRule" ADD CONSTRAINT "DispatchRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchRule" ADD CONSTRAINT "DispatchRule_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchRule" ADD CONSTRAINT "DispatchRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchRule" ADD CONSTRAINT "DispatchRule_targetAgentId_fkey" FOREIGN KEY ("targetAgentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
