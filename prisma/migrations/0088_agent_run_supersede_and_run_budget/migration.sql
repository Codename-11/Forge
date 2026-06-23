-- Phase 1 agentic-runtime correctness: run supersede/collapse, clean
-- completion timestamp, per-run safety budgets, and action-request dedup.

-- ── Enums / types ──────────────────────────────────────────────────────────
ALTER TYPE "ActionRequestStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'AGENT_RUN_BUDGET_WARNING';
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'AGENT_RUN_BUDGET_BREACHED';
CREATE TYPE "RunBudgetAction" AS ENUM ('PAUSE', 'STOP');

-- ── AgentRun: supersede chain + clean-completion timestamp ──────────────────
ALTER TABLE "AgentRun" ADD COLUMN "supersededByRunId" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN "completedAt" TIMESTAMP(3);
CREATE INDEX "AgentRun_supersededByRunId_idx" ON "AgentRun"("supersededByRunId");
ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_supersededByRunId_fkey"
  FOREIGN KEY ("supersededByRunId") REFERENCES "AgentRun"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill completedAt for runs that completed cleanly (best-effort: any
-- run already COMPLETED is treated as a clean completion historically).
UPDATE "AgentRun" SET "completedAt" = "finishedAt"
  WHERE "status" = 'COMPLETED' AND "finishedAt" IS NOT NULL;

-- Collapse the existing STALLED backlog: for each (issueId, agentId), link
-- every older STALLED attempt to the most-recent run so operator surfaces
-- show one thread instead of N repeated cards (the AXI-75 pathology).
WITH latest AS (
  SELECT DISTINCT ON ("issueId", "agentId")
    "id", "issueId", "agentId"
  FROM "AgentRun"
  ORDER BY "issueId", "agentId", "startedAt" DESC, "id" DESC
)
UPDATE "AgentRun" r
SET "supersededByRunId" = latest."id"
FROM latest
WHERE r."issueId" = latest."issueId"
  AND r."agentId" = latest."agentId"
  AND r."id" <> latest."id"
  AND r."status" = 'STALLED'
  AND r."supersededByRunId" IS NULL;

-- ── Workspace: opt-in per-run budgets (null/0 = unlimited) ──────────────────
ALTER TABLE "Workspace" ADD COLUMN "runTokenBudget" INTEGER;
ALTER TABLE "Workspace" ADD COLUMN "runCostBudgetUsd" DECIMAL(10,4);
ALTER TABLE "Workspace" ADD COLUMN "runMaxMinutes" INTEGER;
ALTER TABLE "Workspace" ADD COLUMN "runBudgetWarnPct" INTEGER NOT NULL DEFAULT 80;
ALTER TABLE "Workspace" ADD COLUMN "runBudgetAction" "RunBudgetAction" NOT NULL DEFAULT 'PAUSE';

-- ── ActionRequest: supersede lineage + create-time dedup ────────────────────
ALTER TABLE "ActionRequest" ADD COLUMN "supersededById" TEXT;
CREATE INDEX "ActionRequest_supersededById_idx" ON "ActionRequest"("supersededById");
ALTER TABLE "ActionRequest"
  ADD CONSTRAINT "ActionRequest_supersededById_fkey"
  FOREIGN KEY ("supersededById") REFERENCES "ActionRequest"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Resolve pre-existing OPEN duplicates (e.g. AXI-26's read-only + full
-- grants) BEFORE the unique index, keeping the newest per dedup key.
-- Uses DISMISSED rather than the freshly-added SUPERSEDED value, which
-- cannot be used in the same transaction as its ALTER TYPE ADD VALUE.
-- Scoped to requests that carry a scopePath (runtime-tool grants), matching
-- the partial index below — distinct FREE_FORM asks are never collapsed.
WITH ranked AS (
  SELECT "id",
    ROW_NUMBER() OVER (
      PARTITION BY "workspaceId", "issueId", "kind", "requestedByAgentId",
        ("payload"->>'scopePath')
      ORDER BY "createdAt" DESC, "id" DESC
    ) AS rn
  FROM "ActionRequest"
  WHERE "status" = 'OPEN'
    AND "issueId" IS NOT NULL
    AND "requestedByAgentId" IS NOT NULL
    AND ("payload"->>'scopePath') IS NOT NULL
)
UPDATE "ActionRequest" a
SET "status" = 'DISMISSED',
    "resolution" = 'Auto-dismissed: superseded by a newer request (dedup backfill).',
    "resolvedAt" = NOW()
FROM ranked
WHERE a."id" = ranked."id" AND ranked.rn > 1;

-- At most one OPEN request per (workspace, issue, kind, requester, scopePath),
-- but only for requests that carry a scopePath (runtime-tool grants). Partial
-- + expression index: cannot be expressed in schema.prisma, so it is managed
-- here. Rows without a scopePath (all FREE_FORM, and any NULL issue/requester)
-- are exempt, so genuinely distinct asks are never blocked or deduped.
CREATE UNIQUE INDEX "ActionRequest_open_dedup_key"
  ON "ActionRequest" (
    "workspaceId", "issueId", "kind", "requestedByAgentId",
    ("payload"->>'scopePath')
  )
  WHERE "status" = 'OPEN' AND ("payload"->>'scopePath') IS NOT NULL;
