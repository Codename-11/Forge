-- Add NOTE to ArtifactType so the Canvas can spawn lightweight
-- markdown sticky notes that live in the standard Artifact table
-- (searchable, attachable, linkable like any other artifact).

ALTER TYPE "ArtifactType" ADD VALUE IF NOT EXISTS 'NOTE';
