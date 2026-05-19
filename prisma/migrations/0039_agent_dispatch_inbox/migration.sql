-- Durable Agent Dispatch Inbox lifecycle metadata.
--
-- Adds the columns and indexes required to make AgentRun + ChatMessage
-- the canonical source of "agent X owes work on Y", with webhooks
-- demoted to wake accelerators. All columns are nullable / defaulted
-- so existing rows remain valid; the worker + audit edits in the same
-- patch begin populating them on new events.

-- AgentRun: durable trigger + ack + output + wake lifecycle.
ALTER TABLE "AgentRun"
  ADD COLUMN "triggerEventId" TEXT,
  ADD COLUMN "triggerKind" TEXT,
  ADD COLUMN "acknowledgedAt" TIMESTAMP(3),
  ADD COLUMN "outputStartedAt" TIMESTAMP(3),
  ADD COLUMN "lastWakeAt" TIMESTAMP(3),
  ADD COLUMN "wakeAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastWakeDeliveryId" TEXT;

-- Inbox query: "what does Victor owe right now?"
CREATE INDEX "AgentRun_workspaceId_agentId_acknowledgedAt_lastEventAt_idx"
  ON "AgentRun" ("workspaceId", "agentId", "acknowledgedAt", "lastEventAt");

-- Reverse lookup from an ActivityEvent to its canonical run.
CREATE INDEX "AgentRun_workspaceId_triggerEventId_idx"
  ON "AgentRun" ("workspaceId", "triggerEventId");

-- ChatMessage: per-USER-turn dispatch lifecycle, parallel to AgentRun
-- but scoped to chat threads (where there is no Issue).
ALTER TABLE "ChatMessage"
  ADD COLUMN "acknowledgedAt" TIMESTAMP(3),
  ADD COLUMN "outputStartedAt" TIMESTAMP(3),
  ADD COLUMN "lastWakeAt" TIMESTAMP(3),
  ADD COLUMN "wakeAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastWakeDeliveryId" TEXT;

-- Inbox: USER messages addressed to an agent that haven't been
-- acknowledged yet.
CREATE INDEX "ChatMessage_threadId_role_acknowledgedAt_idx"
  ON "ChatMessage" ("threadId", "role", "acknowledgedAt");
