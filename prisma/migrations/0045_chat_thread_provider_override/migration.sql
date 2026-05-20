-- Phase 5C — per-thread provider/model override for ChatThread.
--
-- Null on both columns = inherit Agent.provider + provider default model.
-- /api/chat/stream picks these up when building the upstream request, so
-- operators can drop into a thread, switch the model for one conversation
-- (e.g. Claude Opus for a hard problem), and not touch the agent default.

ALTER TABLE "ChatThread"
  ADD COLUMN "providerOverride" "AgentProvider",
  ADD COLUMN "modelOverride"    TEXT;
