-- Add a presentation/defaults profile without changing workspace tenancy or
-- capability. Existing workspaces remain TEAM; new PERSONAL workspaces opt in.
CREATE TYPE "WorkspaceExperienceProfile" AS ENUM ('TEAM', 'PERSONAL');

ALTER TABLE "Workspace"
ADD COLUMN "experienceProfile" "WorkspaceExperienceProfile" NOT NULL DEFAULT 'TEAM';
