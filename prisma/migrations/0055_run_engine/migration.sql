-- Pluggable agent execution engine: completions (Forge owns loop) vs runs
-- (delegate to provider's structured agent-run API, e.g. Hermes /v1/runs).

-- CreateEnum
CREATE TYPE "RunEngine" AS ENUM ('COMPLETIONS', 'RUNS');

-- AlterTable: per-agent engine for interactive chat (null = integration default)
ALTER TABLE "Agent" ADD COLUMN "runEngine" "RunEngine";

-- AlterTable: correlate an AgentRun with a provider-side structured run
ALTER TABLE "AgentRun" ADD COLUMN "externalRunId" TEXT;
