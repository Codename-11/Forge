-- Attachment kind + external links.
--
-- Background: an HTML upload from a live agent silently became
-- `.html.txt` because the storage MIME allowlist blocked `text/html`,
-- so the agent renamed and re-uploaded as text/plain. This migration
-- supports the broader fix:
--
--   * `AttachmentKind` enum (FILE | LINK).
--   * `kind` column with default FILE (existing rows backfill).
--   * `externalUrl` for LINK rows pointing at Google Docs / GitHub /
--     Linear / arbitrary web resources.
--   * `linkTitle` optional human label (defaults to URL hostname).
--
-- For LINK rows callers still populate the FILE-shaped columns
-- (filename = linkTitle ?? hostname, mimeType = "text/url", size = 0,
-- url = externalUrl) so existing select(filename/url/...) code paths
-- keep working without schema-level changes.

-- ---------------------------------------------------------------------------
-- Enum: AttachmentKind
-- ---------------------------------------------------------------------------
CREATE TYPE "AttachmentKind" AS ENUM (
  'FILE',
  'LINK'
);

-- ---------------------------------------------------------------------------
-- Attachment columns
-- ---------------------------------------------------------------------------
ALTER TABLE "Attachment"
  ADD COLUMN "kind" "AttachmentKind" NOT NULL DEFAULT 'FILE',
  ADD COLUMN "externalUrl" TEXT,
  ADD COLUMN "linkTitle" TEXT;
