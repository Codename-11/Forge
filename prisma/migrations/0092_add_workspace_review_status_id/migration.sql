-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "reviewStatusId" TEXT;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_reviewStatusId_fkey" FOREIGN KEY ("reviewStatusId") REFERENCES "Status"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "ExternalResource_workspaceId_provider_repoFullName_resourceType" RENAME TO "ExternalResource_workspaceId_provider_repoFullName_resource_key";
