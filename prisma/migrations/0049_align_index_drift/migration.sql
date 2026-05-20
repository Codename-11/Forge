-- Align prod indexes with prisma/schema.prisma.
--
-- This migration is a no-op as far as the application is concerned —
-- it only corrects index naming + drops a handful of stale composite
-- indexes that were superseded by narrower or differently-named ones
-- defined in the current schema. `prisma migrate diff` flagged these
-- as drift, which blocked `prisma migrate dev` for unrelated work
-- (the action-request wave had to author its migration manually as a
-- result). Closing the drift now so future `migrate dev` runs are
-- straightforward.
--
-- Verified state (from pg_indexes) before this migration:
--   Agent_workspaceId_provider_idx                                    (drop, no longer in schema)
--   ChatMessage_threadId_dispatchedAt_idx                             (drop, no longer in schema)
--   ChatThread_workspaceId_userId_lastMessageAt_idx                   (drop — duplicate of agent_conversations)
--   ChatThread_agent_conversations_idx                                (rename to canonical)
--   ChatThread_archive_idx                                            (rename to canonical)
--   NotificationState_workspaceId_userId_status_importance_createdA   (truncated; rename to canonical)
--   Workspace_startedStatusId_idx                                     (drop, no longer in schema)
--   NotificationState.updatedAt default NOW()                         (drop — schema uses @updatedAt only)
--
-- All operations are idempotent via IF EXISTS so re-running this
-- migration against an already-aligned DB is safe.

-- Indexes that are no longer in the schema. None of them are unique
-- so dropping them only loses lookup speed for queries that aren't
-- in the codebase any more.
DROP INDEX IF EXISTS "Agent_workspaceId_provider_idx";
DROP INDEX IF EXISTS "ChatMessage_threadId_dispatchedAt_idx";
DROP INDEX IF EXISTS "ChatThread_workspaceId_userId_lastMessageAt_idx";
DROP INDEX IF EXISTS "Workspace_startedStatusId_idx";

-- Rename indexes whose body matches the current schema but whose name
-- was customised at some point. Prisma's auto-generated names are the
-- target. ALTER INDEX RENAME is metadata-only so this is instant.
ALTER INDEX IF EXISTS "ChatThread_agent_conversations_idx"
  RENAME TO "ChatThread_workspaceId_userId_agentId_lastMessageAt_idx";

ALTER INDEX IF EXISTS "ChatThread_archive_idx"
  RENAME TO "ChatThread_workspaceId_userId_archivedAt_lastMessageAt_idx";

ALTER INDEX IF EXISTS "NotificationState_workspaceId_userId_status_importance_createdA"
  RENAME TO "NotificationState_workspaceId_userId_status_importance_crea_idx";

-- Schema uses `@updatedAt` (Prisma writes the timestamp on every update
-- at the application layer) and explicitly does NOT set a DB-level
-- DEFAULT. The DB picked one up at some point — drop it so the columns
-- match.
ALTER TABLE "NotificationState" ALTER COLUMN "updatedAt" DROP DEFAULT;
