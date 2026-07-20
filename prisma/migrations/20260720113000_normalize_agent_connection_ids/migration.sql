-- Normalize deterministic connection-backfill ids to the same CUID-shaped
-- primary keys Prisma creates for new endpoints. All relational references
-- were created with ON UPDATE CASCADE; the temporary map also updates the
-- actionable JSON/dedupe references that are not protected by foreign keys.

CREATE TEMPORARY TABLE "_AgentConnectionIdMigration" (
  "oldId" TEXT PRIMARY KEY,
  "newId" TEXT UNIQUE NOT NULL
) ON COMMIT DROP;

ALTER TABLE "AgentConnection" ADD COLUMN "legacyId" TEXT;

INSERT INTO "_AgentConnectionIdMigration" ("oldId", "newId")
SELECT
  "id",
  'c' || substring(md5('forge-agent-connection-v1:' || "id") FROM 1 FOR 24)
FROM "AgentConnection"
WHERE "id" LIKE 'ac\_%' ESCAPE '\';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "_AgentConnectionIdMigration" migration
    JOIN "AgentConnection" connection ON connection."id" = migration."newId"
    WHERE connection."id" <> migration."oldId"
  ) THEN
    RAISE EXCEPTION 'Cannot normalize AgentConnection ids: generated id collision';
  END IF;
END $$;

-- Retain a durable, immutable alias so historical audit/event JSON that names
-- the old connection can still be correlated without rewriting history or
-- relying on mutable heartbeat metadata.
UPDATE "AgentConnection" connection
SET "legacyId" = migration."oldId"
FROM "_AgentConnectionIdMigration" migration
WHERE connection."id" = migration."oldId";

CREATE UNIQUE INDEX "AgentConnection_legacyId_key"
  ON "AgentConnection"("legacyId");

-- Typed delivery-conflict payloads hold live identifiers outside relational
-- columns. Rewrite both connection roles before changing the primary key.
UPDATE "ActionRequest" request
SET "payload" = jsonb_set(
  request."payload",
  '{expectedOwnerConnectionId}',
  to_jsonb(migration."newId"),
  false
)
FROM "_AgentConnectionIdMigration" migration
WHERE request."kind" = 'DELIVERY_CONNECTION_CONFLICT'
  AND request."payload"->>'expectedOwnerConnectionId' = migration."oldId";

UPDATE "ActionRequest" request
SET "payload" = jsonb_set(
  request."payload",
  '{candidateConnectionId}',
  to_jsonb(migration."newId"),
  false
)
FROM "_AgentConnectionIdMigration" migration
WHERE request."kind" = 'DELIVERY_CONNECTION_CONFLICT'
  AND request."payload"->>'candidateConnectionId' = migration."oldId";

-- Historical FREE_FORM conflict rows may contain the candidate id only in
-- their dedupe key. Updating all matching keys prevents the legacy alias from
-- splitting one logical conflict into two identities.
UPDATE "ActionRequest" request
SET "dedupeKey" = replace(request."dedupeKey", migration."oldId", migration."newId")
FROM "_AgentConnectionIdMigration" migration
WHERE request."dedupeKey" IS NOT NULL
  AND strpos(request."dedupeKey", migration."oldId") > 0;

UPDATE "AgentConnection" connection
SET "id" = migration."newId"
FROM "_AgentConnectionIdMigration" migration
WHERE connection."id" = migration."oldId";
