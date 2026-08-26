-- Project visibility and explicit project/integration authorization.
-- Existing projects remain workspace-visible. Existing guest and integration
-- access is materialized explicitly so the authorization layer can become
-- deny-by-default without silently breaking established installations.

CREATE TYPE "ProjectVisibility" AS ENUM ('WORKSPACE', 'RESTRICTED');
CREATE TYPE "ProjectAccessRole" AS ENUM ('VIEWER', 'CONTRIBUTOR', 'MANAGER');
CREATE TYPE "IntegrationCapability" AS ENUM ('READ', 'IMPORT', 'LINK', 'SYNC', 'WRITE', 'ADMIN');
CREATE TYPE "IntegrationCredentialSource" AS ENUM ('USER_CONNECTION', 'WORKSPACE_GITHUB_APP');
CREATE TYPE "IntegrationPrincipalType" AS ENUM ('USER', 'AGENT', 'API_KEY', 'WORKSPACE_AUTOMATION');
CREATE TYPE "IntegrationGrantScope" AS ENUM ('WORKSPACE', 'PROJECT');

ALTER TYPE "EventKind" ADD VALUE 'PROJECT_ACCESS_CHANGED';
ALTER TYPE "EventKind" ADD VALUE 'INTEGRATION_AUTHORIZATION_CHANGED';

ALTER TABLE "Project"
  ADD COLUMN "visibility" "ProjectVisibility" NOT NULL DEFAULT 'WORKSPACE';

CREATE UNIQUE INDEX "Project_id_workspaceId_key" ON "Project"("id", "workspaceId");
CREATE UNIQUE INDEX "Membership_id_workspaceId_key" ON "Membership"("id", "workspaceId");
CREATE UNIQUE INDEX "ConnectionMapping_id_workspaceId_key" ON "ConnectionMapping"("id", "workspaceId");
CREATE UNIQUE INDEX "GithubApp_id_workspaceId_key" ON "GithubApp"("id", "workspaceId");
CREATE UNIQUE INDEX "ApiKey_id_workspaceId_key" ON "ApiKey"("id", "workspaceId");
CREATE UNIQUE INDEX "Agent_id_workspaceId_key" ON "Agent"("id", "workspaceId");
CREATE INDEX "Project_workspaceId_visibility_archived_idx" ON "Project"("workspaceId", "visibility", "archived");

CREATE TABLE "ProjectAccess" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "membershipId" TEXT NOT NULL,
  "role" "ProjectAccessRole" NOT NULL,
  "grantedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectAccess_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectAccess_projectId_membershipId_key" ON "ProjectAccess"("projectId", "membershipId");
CREATE INDEX "ProjectAccess_workspaceId_membershipId_role_idx" ON "ProjectAccess"("workspaceId", "membershipId", "role");
CREATE INDEX "ProjectAccess_workspaceId_projectId_idx" ON "ProjectAccess"("workspaceId", "projectId");
CREATE INDEX "ProjectAccess_grantedById_idx" ON "ProjectAccess"("grantedById");

ALTER TABLE "ProjectAccess" ADD CONSTRAINT "ProjectAccess_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectAccess" ADD CONSTRAINT "ProjectAccess_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "Project"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectAccess" ADD CONSTRAINT "ProjectAccess_membershipId_workspaceId_fkey"
  FOREIGN KEY ("membershipId", "workspaceId") REFERENCES "Membership"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectAccess" ADD CONSTRAINT "ProjectAccess_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Preserve existing guest reads by turning them into explicit viewer grants.
INSERT INTO "ProjectAccess" (
  "id", "workspaceId", "projectId", "membershipId", "role", "createdAt", "updatedAt"
)
SELECT
  'pa_' || md5(p."id" || ':' || m."id"),
  p."workspaceId",
  p."id",
  m."id",
  'VIEWER'::"ProjectAccessRole",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Project" p
JOIN "Membership" m ON m."workspaceId" = p."workspaceId" AND m."role" = 'GUEST'
WHERE p."deletedAt" IS NULL
ON CONFLICT ("projectId", "membershipId") DO NOTHING;

CREATE TABLE "ConnectionAuthorization" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "connectionMappingId" TEXT NOT NULL,
  "credentialSource" "IntegrationCredentialSource" NOT NULL,
  "githubAppId" TEXT,
  "capabilities" "IntegrationCapability"[] NOT NULL,
  "authorizedById" TEXT NOT NULL,
  "authorizationDigest" TEXT NOT NULL,
  "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedById" TEXT,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConnectionAuthorization_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConnectionAuthorization_source_binding_check" CHECK (
    ("credentialSource" = 'USER_CONNECTION' AND "githubAppId" IS NULL) OR
    ("credentialSource" = 'WORKSPACE_GITHUB_APP' AND "githubAppId" IS NOT NULL)
  ),
  CONSTRAINT "ConnectionAuthorization_capabilities_check" CHECK (cardinality("capabilities") > 0),
  CONSTRAINT "ConnectionAuthorization_digest_check" CHECK (length("authorizationDigest") >= 16)
);

CREATE UNIQUE INDEX "ConnectionAuthorization_connectionMappingId_key" ON "ConnectionAuthorization"("connectionMappingId");
CREATE UNIQUE INDEX "ConnectionAuthorization_id_workspaceId_key" ON "ConnectionAuthorization"("id", "workspaceId");
CREATE UNIQUE INDEX "ConnectionAuthorization_connectionMappingId_workspaceId_key" ON "ConnectionAuthorization"("connectionMappingId", "workspaceId");
CREATE INDEX "ConnectionAuthorization_workspaceId_revokedAt_idx" ON "ConnectionAuthorization"("workspaceId", "revokedAt");
CREATE INDEX "ConnectionAuthorization_githubAppId_idx" ON "ConnectionAuthorization"("githubAppId");
CREATE INDEX "ConnectionAuthorization_authorizedById_idx" ON "ConnectionAuthorization"("authorizedById");
CREATE INDEX "ConnectionAuthorization_revokedById_idx" ON "ConnectionAuthorization"("revokedById");

ALTER TABLE "ConnectionAuthorization" ADD CONSTRAINT "ConnectionAuthorization_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectionAuthorization" ADD CONSTRAINT "ConnectionAuthorization_connectionMappingId_workspaceId_fkey"
  FOREIGN KEY ("connectionMappingId", "workspaceId") REFERENCES "ConnectionMapping"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectionAuthorization" ADD CONSTRAINT "ConnectionAuthorization_githubAppId_workspaceId_fkey"
  FOREIGN KEY ("githubAppId", "workspaceId") REFERENCES "GithubApp"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConnectionAuthorization" ADD CONSTRAINT "ConnectionAuthorization_authorizedById_fkey"
  FOREIGN KEY ("authorizedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConnectionAuthorization" ADD CONSTRAINT "ConnectionAuthorization_revokedById_fkey"
  FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A GithubApp-backed Connection stores its installation id in config. Bind
-- that exact app when possible; all other mappings remain user-owned.
INSERT INTO "ConnectionAuthorization" (
  "id", "workspaceId", "connectionMappingId", "credentialSource",
  "githubAppId", "capabilities", "authorizedById", "authorizationDigest",
  "authorizedAt", "createdAt", "updatedAt"
)
SELECT
  'ca_' || md5(cm."id"),
  cm."workspaceId",
  cm."id",
  CASE WHEN ga."id" IS NULL
    THEN 'USER_CONNECTION'::"IntegrationCredentialSource"
    ELSE 'WORKSPACE_GITHUB_APP'::"IntegrationCredentialSource"
  END,
  ga."id",
  ARRAY['READ','IMPORT','LINK','SYNC','WRITE','ADMIN']::"IntegrationCapability"[],
  c."ownerId",
  'legacy:' || cm."id",
  cm."updatedAt",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "ConnectionMapping" cm
JOIN "Connection" c ON c."id" = cm."connectionId"
LEFT JOIN LATERAL (
  SELECT app."id"
  FROM "GithubApp" app
  WHERE app."workspaceId" = cm."workspaceId"
    AND app."installationId" IS NOT NULL
    AND app."installationId" = c."config"->>'installationId'
  ORDER BY app."createdAt" ASC
  LIMIT 1
) ga ON TRUE;

CREATE TABLE "IntegrationGrant" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "connectionAuthorizationId" TEXT NOT NULL,
  "principalType" "IntegrationPrincipalType" NOT NULL,
  "principalUserId" TEXT,
  "principalAgentId" TEXT,
  "principalApiKeyId" TEXT,
  "scope" "IntegrationGrantScope" NOT NULL,
  "projectId" TEXT,
  "capabilities" "IntegrationCapability"[] NOT NULL,
  "grantedById" TEXT,
  "revokedById" TEXT,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntegrationGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntegrationGrant_principal_check" CHECK (
    ("principalType" = 'USER' AND "principalUserId" IS NOT NULL AND "principalAgentId" IS NULL AND "principalApiKeyId" IS NULL) OR
    ("principalType" = 'AGENT' AND "principalUserId" IS NULL AND "principalAgentId" IS NOT NULL AND "principalApiKeyId" IS NULL) OR
    ("principalType" = 'API_KEY' AND "principalUserId" IS NULL AND "principalAgentId" IS NULL AND "principalApiKeyId" IS NOT NULL) OR
    ("principalType" = 'WORKSPACE_AUTOMATION' AND "principalUserId" IS NULL AND "principalAgentId" IS NULL AND "principalApiKeyId" IS NULL)
  ),
  CONSTRAINT "IntegrationGrant_scope_check" CHECK (
    ("scope" = 'WORKSPACE' AND "projectId" IS NULL) OR
    ("scope" = 'PROJECT' AND "projectId" IS NOT NULL)
  ),
  CONSTRAINT "IntegrationGrant_capabilities_check" CHECK (cardinality("capabilities") > 0)
);

CREATE INDEX "IntegrationGrant_workspaceId_principalType_revokedAt_idx" ON "IntegrationGrant"("workspaceId", "principalType", "revokedAt");
CREATE INDEX "IntegrationGrant_connectionAuthorizationId_revokedAt_idx" ON "IntegrationGrant"("connectionAuthorizationId", "revokedAt");
CREATE INDEX "IntegrationGrant_workspaceId_projectId_idx" ON "IntegrationGrant"("workspaceId", "projectId");
CREATE INDEX "IntegrationGrant_principalUserId_idx" ON "IntegrationGrant"("principalUserId");
CREATE INDEX "IntegrationGrant_principalAgentId_idx" ON "IntegrationGrant"("principalAgentId");
CREATE INDEX "IntegrationGrant_principalApiKeyId_idx" ON "IntegrationGrant"("principalApiKeyId");
CREATE INDEX "IntegrationGrant_grantedById_idx" ON "IntegrationGrant"("grantedById");
CREATE INDEX "IntegrationGrant_revokedById_idx" ON "IntegrationGrant"("revokedById");
CREATE UNIQUE INDEX "IntegrationGrant_active_principal_scope_key"
  ON "IntegrationGrant" (
    "workspaceId", "connectionAuthorizationId", "principalType",
    COALESCE("principalUserId", ''), COALESCE("principalAgentId", ''),
    COALESCE("principalApiKeyId", ''), "scope", COALESCE("projectId", '')
  ) WHERE "revokedAt" IS NULL;

ALTER TABLE "IntegrationGrant" ADD CONSTRAINT "IntegrationGrant_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationGrant" ADD CONSTRAINT "IntegrationGrant_connectionAuthorizationId_workspaceId_fkey"
  FOREIGN KEY ("connectionAuthorizationId", "workspaceId") REFERENCES "ConnectionAuthorization"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationGrant" ADD CONSTRAINT "IntegrationGrant_principalUserId_fkey"
  FOREIGN KEY ("principalUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationGrant" ADD CONSTRAINT "IntegrationGrant_principalUserId_workspaceId_fkey"
  FOREIGN KEY ("principalUserId", "workspaceId") REFERENCES "Membership"("userId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationGrant" ADD CONSTRAINT "IntegrationGrant_principalAgentId_workspaceId_fkey"
  FOREIGN KEY ("principalAgentId", "workspaceId") REFERENCES "Agent"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationGrant" ADD CONSTRAINT "IntegrationGrant_principalApiKeyId_workspaceId_fkey"
  FOREIGN KEY ("principalApiKeyId", "workspaceId") REFERENCES "ApiKey"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationGrant" ADD CONSTRAINT "IntegrationGrant_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "Project"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationGrant" ADD CONSTRAINT "IntegrationGrant_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IntegrationGrant" ADD CONSTRAINT "IntegrationGrant_revokedById_fkey"
  FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Preserve the previously workspace-wide effective access. Existing API-key
-- scope checks remain an independent ceiling; these grants do not widen them.
INSERT INTO "IntegrationGrant" (
  "id", "workspaceId", "connectionAuthorizationId", "principalType",
  "principalUserId", "scope", "capabilities", "grantedById",
  "createdAt", "updatedAt"
)
SELECT
  'ig_u_' || md5(ca."id" || ':' || m."userId"),
  ca."workspaceId",
  ca."id",
  'USER'::"IntegrationPrincipalType",
  m."userId",
  'WORKSPACE'::"IntegrationGrantScope",
  CASE WHEN m."role" IN ('OWNER', 'ADMIN')
    THEN ARRAY['READ','IMPORT','LINK','SYNC','WRITE','ADMIN']::"IntegrationCapability"[]
    ELSE ARRAY['READ','IMPORT','LINK','SYNC']::"IntegrationCapability"[]
  END,
  ca."authorizedById",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "ConnectionAuthorization" ca
JOIN "Membership" m ON m."workspaceId" = ca."workspaceId";

INSERT INTO "IntegrationGrant" (
  "id", "workspaceId", "connectionAuthorizationId", "principalType",
  "principalAgentId", "scope", "capabilities", "grantedById",
  "createdAt", "updatedAt"
)
SELECT
  'ig_a_' || md5(ca."id" || ':' || a."id"),
  ca."workspaceId", ca."id", 'AGENT'::"IntegrationPrincipalType", a."id",
  'WORKSPACE'::"IntegrationGrantScope",
  ARRAY['READ','IMPORT','LINK','SYNC','WRITE','ADMIN']::"IntegrationCapability"[],
  ca."authorizedById", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "ConnectionAuthorization" ca
JOIN "Agent" a ON a."workspaceId" = ca."workspaceId";

INSERT INTO "IntegrationGrant" (
  "id", "workspaceId", "connectionAuthorizationId", "principalType",
  "principalApiKeyId", "scope", "capabilities", "grantedById",
  "createdAt", "updatedAt"
)
SELECT
  'ig_k_' || md5(ca."id" || ':' || k."id"),
  ca."workspaceId", ca."id", 'API_KEY'::"IntegrationPrincipalType", k."id",
  'WORKSPACE'::"IntegrationGrantScope",
  ARRAY['READ','IMPORT','LINK','SYNC','WRITE','ADMIN']::"IntegrationCapability"[],
  ca."authorizedById", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "ConnectionAuthorization" ca
JOIN "ApiKey" k ON k."workspaceId" = ca."workspaceId" AND k."revokedAt" IS NULL;

INSERT INTO "IntegrationGrant" (
  "id", "workspaceId", "connectionAuthorizationId", "principalType",
  "scope", "capabilities", "grantedById", "createdAt", "updatedAt"
)
SELECT
  'ig_w_' || md5(ca."id"),
  ca."workspaceId", ca."id", 'WORKSPACE_AUTOMATION'::"IntegrationPrincipalType",
  'WORKSPACE'::"IntegrationGrantScope",
  ARRAY['READ','IMPORT','LINK','SYNC','WRITE','ADMIN']::"IntegrationCapability"[],
  ca."authorizedById", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "ConnectionAuthorization" ca
JOIN "ConnectionMapping" cm ON cm."id" = ca."connectionMappingId"
WHERE cm."status" = 'active'
  AND cm."direction" IN ('inbound', 'inbound+outbound');
