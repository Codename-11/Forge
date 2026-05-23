-- Provider-agnostic runtime adapter key (Phase 1 of runtime-adapter refactor).
-- Additive + backfill only; no behavior change.

-- AddColumn
ALTER TABLE "Runtime" ADD COLUMN "adapterKey" TEXT;

-- Backfill: mirror adapterKeyForLegacyRuntime() in
-- src/server/runtimes/adapters.ts so code and data agree.
UPDATE "Runtime" SET "adapterKey" = 'local-daemon' WHERE "kind" = 'LOCAL_DAEMON' AND "adapterKey" IS NULL;
UPDATE "Runtime" SET "adapterKey" = 'hermes'
  WHERE "kind" = 'REMOTE_HTTP' AND 'HERMES' = ANY("providersAvailable") AND "adapterKey" IS NULL;
UPDATE "Runtime" SET "adapterKey" = 'custom-http' WHERE "adapterKey" IS NULL;
