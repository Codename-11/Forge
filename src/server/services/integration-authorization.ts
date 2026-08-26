import "server-only";
import { createHash } from "node:crypto";
import {
  ConnectionProvider,
  ConnectionStatus,
  IntegrationCapability,
  IntegrationCredentialSource,
  IntegrationGrantScope,
  IntegrationPrincipalType,
  type PrismaClient,
} from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { canPerformProjectAction, type ProjectAction } from "@/server/services/authorization";
import {
  githubInstallationId,
  readGitHubConnectionConfig,
} from "@/server/services/github/mapping-policy";
import { readGithubAppSyncReadiness } from "@/server/services/github-app";
import { decryptSecret } from "@/server/crypto";

export type IntegrationAction = IntegrationCapability;

export type IntegrationPrincipal =
  | { type: "USER"; userId: string }
  | { type: "AGENT"; agentId: string; apiKeyId: string }
  | { type: "API_KEY"; apiKeyId: string }
  | { type: "WORKSPACE_AUTOMATION" };

const ACTION_CAPABILITIES: Record<IntegrationAction, readonly IntegrationCapability[]> = {
  READ: [IntegrationCapability.READ],
  LINK: [IntegrationCapability.READ, IntegrationCapability.LINK],
  IMPORT: [IntegrationCapability.READ, IntegrationCapability.IMPORT],
  SYNC: [IntegrationCapability.READ, IntegrationCapability.SYNC],
  WRITE: [IntegrationCapability.READ, IntegrationCapability.WRITE],
  ADMIN: [IntegrationCapability.ADMIN],
};

export function integrationRequiredCapabilities(
  action: IntegrationAction,
): readonly IntegrationCapability[] {
  return ACTION_CAPABILITIES[action];
}

const ACTION_PROJECT_AUTHORITY: Record<IntegrationAction, ProjectAction> = {
  READ: "READ",
  LINK: "CONTRIBUTE",
  IMPORT: "CONTRIBUTE",
  SYNC: "CONTRIBUTE",
  WRITE: "CONTRIBUTE",
  ADMIN: "MANAGE",
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

/**
 * Digest only fields that can widen a mapping's authority. Cosmetic timestamps
 * and health diagnostics deliberately do not invalidate consent.
 */
export function connectionAuthorizationDigest(mapping: {
  connectionId: string;
  kind: string;
  target: string;
  direction: string;
  labelIds: string[];
  routeTo: string | null;
  config: unknown;
}): string {
  const policy = stableValue({
    connectionId: mapping.connectionId,
    kind: mapping.kind,
    target: mapping.target.trim().toLowerCase(),
    direction: mapping.direction,
    labelIds: [...mapping.labelIds].sort(),
    routeTo: mapping.routeTo,
    config: mapping.config,
  });
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

function includesAll(
  actual: readonly IntegrationCapability[],
  required: readonly IntegrationCapability[],
): boolean {
  const set = new Set(actual);
  return required.every((capability) => set.has(capability));
}

export function integrationDirectionAllows(direction: string, action: IntegrationAction): boolean {
  if (action === IntegrationCapability.ADMIN) return true;
  const required = action === IntegrationCapability.WRITE ? "outbound" : "inbound";
  return direction === required || direction === "inbound+outbound";
}

function principalWhere(principal: IntegrationPrincipal) {
  switch (principal.type) {
    case "USER":
      return {
        principalType: IntegrationPrincipalType.USER,
        principalUserId: principal.userId,
      } as const;
    case "AGENT":
      return {
        principalType: IntegrationPrincipalType.AGENT,
        principalAgentId: principal.agentId,
      } as const;
    case "API_KEY":
      return {
        principalType: IntegrationPrincipalType.API_KEY,
        principalApiKeyId: principal.apiKeyId,
      } as const;
    case "WORKSPACE_AUTOMATION":
      return { principalType: IntegrationPrincipalType.WORKSPACE_AUTOMATION } as const;
  }
}

async function assertHumanProjectAuthority(args: {
  db: PrismaClient;
  workspaceId: string;
  userId: string;
  projectId: string | null;
  action: IntegrationAction;
}): Promise<void> {
  const membership = await args.db.membership.findUnique({
    where: { userId_workspaceId: { userId: args.userId, workspaceId: args.workspaceId } },
    select: { id: true, role: true },
  });
  if (!membership)
    throw new TRPCError({ code: "FORBIDDEN", message: "Workspace access required." });
  if (!args.projectId) return;
  const project = await args.db.project.findFirst({
    where: { id: args.projectId, workspaceId: args.workspaceId, deletedAt: null },
    select: {
      visibility: true,
      accessGrants: {
        where: { membershipId: membership.id },
        select: { role: true },
        take: 1,
      },
    },
  });
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found." });
  if (
    !canPerformProjectAction({
      membershipRole: membership.role,
      visibility: project.visibility,
      accessRole: project.accessGrants[0]?.role ?? null,
      action: ACTION_PROJECT_AUTHORITY[args.action],
    })
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Project access does not permit this integration action.",
    });
  }
}

async function assertExactGithubAuthority(args: {
  db: PrismaClient;
  workspaceId: string;
  authorization: {
    credentialSource: IntegrationCredentialSource;
    githubAppId: string | null;
    authorizedById: string;
  };
  connection: { ownerId: string; provider: ConnectionProvider; config: unknown };
}): Promise<void> {
  if (args.connection.provider !== ConnectionProvider.GITHUB) return;
  if (args.authorization.credentialSource === IntegrationCredentialSource.USER_CONNECTION) {
    if (args.authorization.authorizedById !== args.connection.ownerId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "The credential owner has not authorized this mapping.",
      });
    }
    return;
  }
  if (!args.authorization.githubAppId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Workspace GitHub App authorization is incomplete.",
    });
  }
  const app = await args.db.githubApp.findFirst({
    where: { id: args.authorization.githubAppId, workspaceId: args.workspaceId },
    select: { installationId: true },
  });
  const installationId = githubInstallationId(args.connection as never);
  if (!app?.installationId || app.installationId !== installationId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "The mapping is not bound to its authorized GitHub App installation.",
    });
  }
}

export type IntegrationAuthorization = {
  mappingId: string;
  connectionAuthorizationId: string;
  grantId: string;
  projectId: string | null;
  capabilities: IntegrationCapability[];
};

/** Central deny-by-default integration authorization boundary. */
export async function assertIntegrationAction(args: {
  db: PrismaClient;
  workspaceId: string;
  mappingId: string;
  principal: IntegrationPrincipal;
  action: IntegrationAction;
  projectId?: string | null;
}): Promise<IntegrationAuthorization> {
  const required = ACTION_CAPABILITIES[args.action];
  const mapping = await args.db.connectionMapping.findFirst({
    where: { id: args.mappingId, workspaceId: args.workspaceId },
    include: {
      connection: {
        select: {
          id: true,
          ownerId: true,
          provider: true,
          status: true,
          config: true,
          scopes: true,
        },
      },
      authorization: true,
    },
  });
  if (!mapping)
    throw new TRPCError({ code: "NOT_FOUND", message: "Integration mapping not found." });
  if (mapping.status !== "active" || mapping.connection.status !== ConnectionStatus.CONNECTED) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Integration mapping is not active and connected.",
    });
  }
  if (!integrationDirectionAllows(mapping.direction, args.action)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Mapping direction does not permit this action.",
    });
  }
  const authorization = mapping.authorization;
  const digestMatches = authorization
    ? authorization.authorizationDigest === connectionAuthorizationDigest(mapping) ||
      (authorization.authorizationDigest === `legacy:${mapping.id}` &&
        authorization.authorizedAt >= mapping.updatedAt)
    : false;
  if (
    !authorization ||
    authorization.revokedAt ||
    !digestMatches ||
    !includesAll(authorization.capabilities, required)
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Credential-owner authorization is missing, stale, or insufficient.",
    });
  }
  await assertExactGithubAuthority({
    db: args.db,
    workspaceId: args.workspaceId,
    authorization,
    connection: mapping.connection,
  });

  const projectId = args.projectId ?? null;
  const grants = await args.db.integrationGrant.findMany({
    where: {
      workspaceId: args.workspaceId,
      connectionAuthorizationId: authorization.id,
      revokedAt: null,
      ...principalWhere(args.principal),
      OR: [
        { scope: IntegrationGrantScope.WORKSPACE, projectId: null },
        ...(projectId ? [{ scope: IntegrationGrantScope.PROJECT, projectId }] : []),
      ],
    },
    select: { id: true, capabilities: true },
  });
  const grant = grants.find((candidate) => includesAll(candidate.capabilities, required));
  if (!grant) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "An explicit integration grant is required for this action.",
    });
  }

  if (args.principal.type === "USER") {
    await assertHumanProjectAuthority({
      db: args.db,
      workspaceId: args.workspaceId,
      userId: args.principal.userId,
      projectId,
      action: args.action,
    });
  } else if (args.principal.type === "AGENT" || args.principal.type === "API_KEY") {
    const keyId = args.principal.apiKeyId;
    const key = await args.db.apiKey.findFirst({
      where: {
        id: keyId,
        workspaceId: args.workspaceId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true, projectIds: true },
    });
    if (!key || (projectId && key.projectIds.length > 0 && !key.projectIds.includes(projectId))) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "API key scope does not permit this integration action.",
      });
    }
  }

  return {
    mappingId: mapping.id,
    connectionAuthorizationId: authorization.id,
    grantId: grant.id,
    projectId,
    capabilities: [...required],
  };
}

/** Resolve an exact principal; never use a fallback author as authority. */
export function integrationPrincipalFromContext(ctx: {
  userId: string | null;
  apiKey?: { keyId: string; linkedAgentId: string | null } | null;
}): IntegrationPrincipal {
  if (ctx.apiKey?.linkedAgentId) {
    return { type: "AGENT", agentId: ctx.apiKey.linkedAgentId, apiKeyId: ctx.apiKey.keyId };
  }
  if (ctx.apiKey) return { type: "API_KEY", apiKeyId: ctx.apiKey.keyId };
  if (ctx.userId) return { type: "USER", userId: ctx.userId };
  throw new TRPCError({
    code: "UNAUTHORIZED",
    message: "An exact integration principal is required.",
  });
}

/** Read current GitHub installation permissions from the exact authorized app. */
export async function assertGitHubProviderCapabilities(args: {
  db: PrismaClient;
  workspaceId: string;
  mappingId: string;
}): Promise<void> {
  const row = await args.db.connectionMapping.findFirst({
    where: { id: args.mappingId, workspaceId: args.workspaceId },
    include: { authorization: true, connection: { select: { config: true } } },
  });
  const appId = row?.authorization?.githubAppId;
  if (!row || !appId) return; // personal OAuth/App fallback is enforced by the provider request itself
  const app = await args.db.githubApp.findFirst({
    where: { id: appId, workspaceId: args.workspaceId },
    select: { appId: true, installationId: true, privateKeyEnc: true },
  });
  if (!app?.installationId)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Authorized GitHub App is not installed.",
    });
  const readiness = await readGithubAppSyncReadiness({
    appId: app.appId,
    installationId: app.installationId,
    privateKeyPem: decryptSecret(app.privateKeyEnc),
  });
  if (readiness.missingInstallationPermissions.length > 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `GitHub installation lacks required permissions: ${readiness.missingInstallationPermissions.join(", ")}.`,
    });
  }
  const configuredInstallationId = readGitHubConnectionConfig(row.connection.config).installationId;
  if (String(configuredInstallationId ?? "") !== app.installationId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "GitHub App installation binding is inconsistent.",
    });
  }
}
