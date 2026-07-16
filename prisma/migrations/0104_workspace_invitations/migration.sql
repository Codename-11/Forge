CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

ALTER TYPE "EventKind" ADD VALUE 'INVITATION_CREATED';
ALTER TYPE "EventKind" ADD VALUE 'INVITATION_RESENT';
ALTER TYPE "EventKind" ADD VALUE 'INVITATION_REVOKED';
ALTER TYPE "EventKind" ADD VALUE 'INVITATION_ACCEPTED';

ALTER TABLE "Workspace"
  ADD COLUMN "inviteExpiryHours" INTEGER NOT NULL DEFAULT 168;

CREATE TABLE "WorkspaceInvitation" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" "Role" NOT NULL DEFAULT 'MEMBER',
  "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
  "tokenHash" TEXT NOT NULL,
  "note" TEXT,
  "invitedById" TEXT NOT NULL,
  "acceptedById" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastSentAt" TIMESTAMP(3),
  "sendCount" INTEGER NOT NULL DEFAULT 0,
  "lastSendError" TEXT,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceInvitation_tokenHash_key" ON "WorkspaceInvitation"("tokenHash");
CREATE INDEX "WorkspaceInvitation_workspaceId_status_createdAt_idx" ON "WorkspaceInvitation"("workspaceId", "status", "createdAt");
CREATE INDEX "WorkspaceInvitation_workspaceId_email_status_idx" ON "WorkspaceInvitation"("workspaceId", "email", "status");
CREATE INDEX "WorkspaceInvitation_email_status_idx" ON "WorkspaceInvitation"("email", "status");
CREATE UNIQUE INDEX "WorkspaceInvitation_pending_email_key"
  ON "WorkspaceInvitation"("workspaceId", lower("email"))
  WHERE "status" = 'PENDING';

ALTER TABLE "WorkspaceInvitation"
  ADD CONSTRAINT "WorkspaceInvitation_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceInvitation"
  ADD CONSTRAINT "WorkspaceInvitation_invitedById_fkey"
  FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkspaceInvitation"
  ADD CONSTRAINT "WorkspaceInvitation_acceptedById_fkey"
  FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
