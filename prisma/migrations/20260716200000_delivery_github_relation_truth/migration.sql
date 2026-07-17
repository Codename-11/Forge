-- AXI-117: make GitHub relations singular/truthful and expand delivery source
-- vocabulary without conflating invocation, transport, and runtime.

ALTER TYPE "WorkSessionSource" ADD VALUE IF NOT EXISTS 'MCP';
ALTER TYPE "WorkSessionSource" ADD VALUE IF NOT EXISTS 'NATIVE_SESSION';
ALTER TYPE "WorkSessionSource" ADD VALUE IF NOT EXISTS 'ISSUE_DISPATCH';
ALTER TYPE "WorkSessionSource" ADD VALUE IF NOT EXISTS 'SCHEDULED';

-- Release assembly PRs are containment evidence, not implementation PRs.
UPDATE "ExternalResourceLink" link
SET "kind" = 'RELEASES'
FROM "ExternalResource" resource
WHERE link."externalResourceId" = resource."id"
  AND link."kind" = 'IMPLEMENTS'
  AND resource."resourceType" = 'PULL_REQUEST'
  AND (
    resource."title" ~* '^\s*release\s+v?[0-9]'
    OR COALESCE(resource."metadata" #>> '{head,ref}', '') ~* '(^|/)release([-\/]|$)'
  );

-- A release-only relation cannot support an older Ready-to-Close request.
-- Dismiss requests only when no implementation PR remains for the issue.
UPDATE "ActionRequest" request
SET
  "status" = 'DISMISSED',
  "resolvedAt" = NOW(),
  "resolution" = 'The linked pull request is release containment, not implementation evidence.'
WHERE request."status" = 'OPEN'
  AND request."sourceType" = 'completion-candidate'
  AND request."issueId" IN (
    SELECT DISTINCT release_link."issueId"
    FROM "ExternalResourceLink" release_link
    JOIN "ExternalResource" release_resource
      ON release_resource."id" = release_link."externalResourceId"
    WHERE release_link."kind" = 'RELEASES'
      AND release_resource."resourceType" = 'PULL_REQUEST'
      AND (
        release_resource."title" ~* '^\s*release\s+v?[0-9]'
        OR COALESCE(release_resource."metadata" #>> '{head,ref}', '') ~* '(^|/)release([-\/]|$)'
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "ExternalResourceLink" implementation_link
    JOIN "ExternalResource" implementation_resource
      ON implementation_resource."id" = implementation_link."externalResourceId"
    WHERE implementation_link."issueId" = request."issueId"
      AND implementation_link."kind" IN ('IMPLEMENTS', 'FIXES')
      AND implementation_resource."resourceType" = 'PULL_REQUEST'
  );

-- Older rows could carry multiple semantic kinds for the same issue/resource.
-- Keep one deterministic relation before enforcing the native invariant.
WITH ranked AS (
  SELECT "id",
    ROW_NUMBER() OVER (
      PARTITION BY "issueId", "externalResourceId"
      ORDER BY
        CASE "kind"
          -- SOURCE is the durable identity used to de-duplicate imported
          -- GitHub issues/PRs. Derived relations must not erase it.
          WHEN 'SOURCE' THEN 0
          WHEN 'FIXES' THEN 1
          WHEN 'IMPLEMENTS' THEN 2
          WHEN 'RELEASES' THEN 3
          WHEN 'REVIEWS' THEN 4
          ELSE 5
        END,
        "createdAt" ASC,
        "id" ASC
    ) AS rn
  FROM "ExternalResourceLink"
)
DELETE FROM "ExternalResourceLink" link
USING ranked
WHERE link."id" = ranked."id" AND ranked.rn > 1;

DROP INDEX "ExternalResourceLink_issueId_externalResourceId_kind_key";
CREATE UNIQUE INDEX "ExternalResourceLink_issueId_externalResourceId_key"
  ON "ExternalResourceLink"("issueId", "externalResourceId");
