-- CreateTable
CREATE TABLE "RuntimeSecret" (
    "id" TEXT NOT NULL,
    "runtimeId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueEnc" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuntimeSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuntimeRepo" (
    "id" TEXT NOT NULL,
    "runtimeId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "branch" TEXT,
    "path" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuntimeRepo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RuntimeSecret_runtimeId_idx" ON "RuntimeSecret"("runtimeId");

-- CreateIndex
CREATE INDEX "RuntimeSecret_workspaceId_idx" ON "RuntimeSecret"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeSecret_runtimeId_key_key" ON "RuntimeSecret"("runtimeId", "key");

-- CreateIndex
CREATE INDEX "RuntimeRepo_runtimeId_idx" ON "RuntimeRepo"("runtimeId");

-- CreateIndex
CREATE INDEX "RuntimeRepo_workspaceId_idx" ON "RuntimeRepo"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeRepo_runtimeId_path_key" ON "RuntimeRepo"("runtimeId", "path");

-- AddForeignKey
ALTER TABLE "RuntimeSecret" ADD CONSTRAINT "RuntimeSecret_runtimeId_fkey" FOREIGN KEY ("runtimeId") REFERENCES "Runtime"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeRepo" ADD CONSTRAINT "RuntimeRepo_runtimeId_fkey" FOREIGN KEY ("runtimeId") REFERENCES "Runtime"("id") ON DELETE CASCADE ON UPDATE CASCADE;
