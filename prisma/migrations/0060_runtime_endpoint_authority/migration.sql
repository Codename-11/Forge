-- Phase 3 of the runtime-adapter refactor: make Runtime.endpoint authoritative
-- for the runs gateway.
--
-- A managed Hermes runtime's `endpoint` must be the runs **gateway base**
-- (e.g. http://127.0.0.1:8642/v1), but migration 0018 backfilled the per-agent
-- *webhook* URL there. Null those (endpoint + secret) so getRunsConnectorForAgent
-- falls back to the env gateway — behavior-identical to today — until an operator
-- sets the real base via Settings → Runtimes. The per-agent webhook stays on the
-- Agent row and continues to drive webhook delivery.
UPDATE "Runtime" SET "endpoint" = NULL, "secret" = NULL WHERE "adapterKey" = 'hermes';
