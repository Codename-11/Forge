-- Agent provider/runtime metadata.
--
-- Hermes remains the first-class persistent runtime. Claude and Codex are
-- represented explicitly so onboarding, API keys, and docs can show the right
-- wiring without implying every agent must expose a webhook.
CREATE TYPE "AgentProvider" AS ENUM ('HERMES', 'CLAUDE', 'CODEX', 'CUSTOM');
CREATE TYPE "AgentRuntimeMode" AS ENUM ('PERSISTENT', 'EPHEMERAL');

ALTER TABLE "Agent"
  ADD COLUMN "provider" "AgentProvider" NOT NULL DEFAULT 'HERMES',
  ADD COLUMN "runtimeMode" "AgentRuntimeMode" NOT NULL DEFAULT 'PERSISTENT';

CREATE INDEX "Agent_workspaceId_provider_idx" ON "Agent"("workspaceId", "provider");
