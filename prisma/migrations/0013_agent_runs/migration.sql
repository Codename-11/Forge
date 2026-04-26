-- Agent runs (live monitoring) + rolling status comments.
--
-- Three additions:
--
--   1. CommentKind enum + Comment.kind / runId / currentStep / revisions
--      — gives every AgentRun a single rolling "live status" comment
--      that's upserted via comments.upsertStatus instead of spamming the
--      thread. NULL runId is allowed for normal BODY comments; the
--      unique index treats NULLs as distinct so the constraint only
--      bites the STATUS rows.
--
--   2. AgentRun + AgentRunEvent — durable runs of "agent X is actively
--      working issue Y" with a freshness pointer (lastEventAt) the
--      watchdog reads. Multiple runs per (agent, issue) over time.
--
--   3. EventKind additions — AGENT_RUN_* events drive the live pulse
--      strip on the issue page via the existing SSE bus.
--
-- Workspace.agentRunStaleMinutes (default 0 = disabled) gates the
-- per-run watchdog independently of the issue-level stale-work sweep.

-- New enums.
CREATE TYPE "CommentKind"     AS ENUM ('BODY', 'STATUS');
CREATE TYPE "AgentRunStatus"  AS ENUM ('ACTIVE', 'COMPLETED', 'ABANDONED', 'STALLED');

-- Extend EventKind. Postgres lets us tack values onto an existing enum.
ALTER TYPE "EventKind" ADD VALUE 'AGENT_RUN_STARTED';
ALTER TYPE "EventKind" ADD VALUE 'AGENT_RUN_STEP';
ALTER TYPE "EventKind" ADD VALUE 'AGENT_RUN_BLOCKED';
ALTER TYPE "EventKind" ADD VALUE 'AGENT_RUN_COMPLETED';
ALTER TYPE "EventKind" ADD VALUE 'AGENT_RUN_STALLED';

-- Workspace knob.
ALTER TABLE "Workspace"
  ADD COLUMN "agentRunStaleMinutes" INTEGER NOT NULL DEFAULT 0;

-- Comment additions.
ALTER TABLE "Comment"
  ADD COLUMN "kind"        "CommentKind" NOT NULL DEFAULT 'BODY',
  ADD COLUMN "runId"       TEXT,
  ADD COLUMN "currentStep" TEXT,
  ADD COLUMN "revisions"   JSONB;

-- One STATUS comment per run (NULLs distinct, so BODY rows are unaffected).
CREATE UNIQUE INDEX "Comment_runId_key" ON "Comment" ("runId");
CREATE INDEX "Comment_issueId_kind_idx" ON "Comment" ("issueId", "kind");

-- AgentRun model.
CREATE TABLE "AgentRun" (
  "id"                TEXT NOT NULL,
  "workspaceId"       TEXT NOT NULL,
  "issueId"           TEXT NOT NULL,
  "agentId"           TEXT NOT NULL,
  "status"            "AgentRunStatus" NOT NULL DEFAULT 'ACTIVE',
  "startedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastEventAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"        TIMESTAMP(3),
  "currentStep"       TEXT,
  "summary"           TEXT,
  "assignmentEventId" TEXT,
  CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentRun_workspaceId_status_lastEventAt_idx"
  ON "AgentRun" ("workspaceId", "status", "lastEventAt");
CREATE INDEX "AgentRun_issueId_startedAt_idx"
  ON "AgentRun" ("issueId", "startedAt");
CREATE INDEX "AgentRun_agentId_status_idx"
  ON "AgentRun" ("agentId", "status");

ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "Issue"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AgentRunEvent model.
CREATE TABLE "AgentRunEvent" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "runId"       TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "payload"     JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentRunEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentRunEvent_runId_createdAt_idx"
  ON "AgentRunEvent" ("runId", "createdAt");
CREATE INDEX "AgentRunEvent_workspaceId_createdAt_idx"
  ON "AgentRunEvent" ("workspaceId", "createdAt");

ALTER TABLE "AgentRunEvent"
  ADD CONSTRAINT "AgentRunEvent_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRunEvent"
  ADD CONSTRAINT "AgentRunEvent_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "AgentRun"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- FK from Comment.runId → AgentRun.id (SetNull preserves the comment if
-- the run is hard-deleted via cascade from issue/agent/workspace).
ALTER TABLE "Comment"
  ADD CONSTRAINT "Comment_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "AgentRun"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
