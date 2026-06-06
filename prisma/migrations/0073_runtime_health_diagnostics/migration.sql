-- Persist sanitized, handshake-only runtime reachability diagnostics.
ALTER TABLE "Runtime" ADD COLUMN "lastProbeAt" TIMESTAMP(3);
ALTER TABLE "Runtime" ADD COLUMN "lastProbeAttempted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Runtime" ADD COLUMN "lastProbeReachable" BOOLEAN;
ALTER TABLE "Runtime" ADD COLUMN "lastProbeDetail" TEXT;
