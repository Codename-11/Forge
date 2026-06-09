-- Durable per-user read anchors for chat threads.
CREATE TABLE "ChatThreadRead" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatThreadRead_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatThreadRead_threadId_userId_key" ON "ChatThreadRead"("threadId", "userId");
CREATE INDEX "ChatThreadRead_workspaceId_userId_readAt_idx" ON "ChatThreadRead"("workspaceId", "userId", "readAt");

ALTER TABLE "ChatThreadRead"
  ADD CONSTRAINT "ChatThreadRead_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatThreadRead"
  ADD CONSTRAINT "ChatThreadRead_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatThreadRead"
  ADD CONSTRAINT "ChatThreadRead_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
