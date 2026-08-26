-- Managed runtime diagnostics execute in the worker and retain bounded
-- provenance so manual checks and scheduled sweeps cannot look contradictory.
CREATE TYPE "RuntimeDiagnosticKind" AS ENUM ('PROBE', 'SELF_TEST');
CREATE TYPE "RuntimeDiagnosticExecutor" AS ENUM ('WORKER');
CREATE TYPE "RuntimeDiagnosticTrigger" AS ENUM ('MANUAL_RUNTIME', 'MANUAL_AGENT', 'SCHEDULED_SWEEP');

CREATE TABLE "RuntimeDiagnosticAttempt" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "runtimeId" TEXT NOT NULL,
  "kind" "RuntimeDiagnosticKind" NOT NULL,
  "executor" "RuntimeDiagnosticExecutor" NOT NULL DEFAULT 'WORKER',
  "trigger" "RuntimeDiagnosticTrigger" NOT NULL,
  "requestedById" TEXT,
  "attempted" BOOLEAN NOT NULL DEFAULT false,
  "reachable" BOOLEAN,
  "selfTestStatus" "RuntimeSelfTestStatus",
  "detail" TEXT,
  "durationMs" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "RuntimeDiagnosticAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RuntimeDiagnosticAttempt_requestId_key"
  ON "RuntimeDiagnosticAttempt"("requestId");
CREATE INDEX "RuntimeDiagnosticAttempt_workspaceId_runtimeId_createdAt_idx"
  ON "RuntimeDiagnosticAttempt"("workspaceId", "runtimeId", "createdAt" DESC);
CREATE INDEX "RuntimeDiagnosticAttempt_runtimeId_kind_createdAt_idx"
  ON "RuntimeDiagnosticAttempt"("runtimeId", "kind", "createdAt" DESC);

ALTER TABLE "RuntimeDiagnosticAttempt"
  ADD CONSTRAINT "RuntimeDiagnosticAttempt_runtimeId_fkey"
  FOREIGN KEY ("runtimeId") REFERENCES "Runtime"("id") ON DELETE CASCADE ON UPDATE CASCADE;
