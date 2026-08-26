import { z } from "zod";
import {
  ConnectionProvider,
  EventKind,
  IntegrationCapability,
  IntegrationCredentialSource,
  IntegrationGrantScope,
  IntegrationPrincipalType,
  Role,
  type Prisma,
} from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { adminProcedure, router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { connectionAuthorizationDigest } from "@/server/services/integration-authorization";
import { githubInstallationId } from "@/server/services/github/mapping-policy";

const capabilities = z.array(z.nativeEnum(IntegrationCapability)).min(1);

const principalInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal(IntegrationPrincipalType.USER), userId: z.string().cuid() }),
  z.object({ type: z.literal(IntegrationPrincipalType.AGENT), agentId: z.string().cuid() }),
  z.object({ type: z.literal(IntegrationPrincipalType.API_KEY), apiKeyId: z.string().cuid() }),
  z.object({ type: z.literal(IntegrationPrincipalType.WORKSPACE_AUTOMATION) }),
]);

function isSubset(values: IntegrationCapability[], ceiling: IntegrationCapability[]): boolean {
  const allowed = new Set(ceiling);
  return values.every((value) => allowed.has(value));
}

const authorizationManagementInclude = {
  connectionMapping: {
    select: {
      id: true,
      kind: true,
      target: true,
      direction: true,
      status: true,
      connection: {
        select: {
          id: true,
          provider: true,
          label: true,
          account: true,
          ownerId: true,
          owner: { select: { id: true, name: true, email: true, image: true } },
        },
      },
    },
  },
  githubApp: { select: { id: true, name: true, installationId: true } },
  authorizedBy: { select: { id: true, name: true, email: true, image: true } },
  revokedBy: { select: { id: true, name: true, email: true, image: true } },
  grants: {
    orderBy: { createdAt: "asc" },
    include: {
      principalUser: { select: { id: true, name: true, email: true, image: true } },
      principalAgent: { select: { id: true, name: true, profileKey: true, avatar: true } },
      principalApiKey: {
        select: {
          id: true,
          name: true,
          prefix: true,
          kind: true,
          revokedAt: true,
          expiresAt: true,
        },
      },
      project: { select: { id: true, key: true, name: true, visibility: true } },
      grantedBy: { select: { id: true, name: true, email: true } },
      revokedBy: { select: { id: true, name: true, email: true } },
    },
  },
} satisfies Prisma.ConnectionAuthorizationInclude;

export const integrationGrantRouter = router({
  list: adminProcedure.query(({ ctx }) =>
    ctx.db.connectionAuthorization.findMany({
      where: { workspaceId: ctx.workspaceId },
      include: authorizationManagementInclude,
      orderBy: { createdAt: "asc" },
    }),
  ),

  /**
   * A credential owner may inspect consent and every grant derived from their
   * personal connection without gaining workspace-wide integration inventory.
   * Workspace App credentials remain admin-managed even when their legacy
   * synthesized Connection row records a creating user.
   */
  listOwned: workspaceProcedure.query(({ ctx }) =>
    ctx.db.connectionAuthorization.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        credentialSource: IntegrationCredentialSource.USER_CONNECTION,
        connectionMapping: { connection: { ownerId: ctx.session.user.id } },
      },
      include: authorizationManagementInclude,
      orderBy: { createdAt: "asc" },
    }),
  ),

  /** Credential-owner consent. Workspace admins cannot authorize a colleague's personal credential. */
  authorize: workspaceProcedure
    .input(
      z.object({
        mappingId: z.string().cuid(),
        credentialSource: z.nativeEnum(IntegrationCredentialSource),
        githubAppId: z.string().cuid().nullable().optional(),
        capabilities,
      }),
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const mapping = await tx.connectionMapping.findFirst({
          where: { id: input.mappingId, workspaceId: ctx.workspaceId },
          include: { connection: true, authorization: true },
        });
        if (!mapping)
          throw new TRPCError({ code: "NOT_FOUND", message: "Integration mapping not found." });

        let githubAppId: string | null = null;
        if (input.credentialSource === IntegrationCredentialSource.USER_CONNECTION) {
          if (mapping.connection.ownerId !== ctx.session.user.id) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Only the credential owner can authorize this mapping.",
            });
          }
          if (input.githubAppId) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "A personal credential cannot bind a workspace GitHub App.",
            });
          }
        } else {
          if (ctx.membership.role !== Role.OWNER && ctx.membership.role !== Role.ADMIN) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Workspace admin access is required to authorize a workspace GitHub App.",
            });
          }
          if (mapping.connection.provider !== ConnectionProvider.GITHUB || !input.githubAppId) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Workspace App authorization requires an exact GitHub App.",
            });
          }
          const app = await tx.githubApp.findFirst({
            where: {
              id: input.githubAppId,
              workspaceId: ctx.workspaceId,
              installationId: { not: null },
            },
            select: { id: true, installationId: true },
          });
          if (
            !app?.installationId ||
            app.installationId !== githubInstallationId(mapping.connection)
          ) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "GitHub App does not own this mapping's installation.",
            });
          }
          githubAppId = app.id;
        }

        const digest = connectionAuthorizationDigest(mapping);
        const prior = mapping.authorization;
        const now = new Date();
        const authorization = prior
          ? await tx.connectionAuthorization.update({
              where: { id: prior.id },
              data: {
                credentialSource: input.credentialSource,
                githubAppId,
                capabilities: input.capabilities,
                authorizedById: ctx.session.user.id,
                authorizationDigest: digest,
                authorizedAt: now,
                revokedById: null,
                revokedAt: null,
              },
            })
          : await tx.connectionAuthorization.create({
              data: {
                workspaceId: ctx.workspaceId,
                connectionMappingId: mapping.id,
                credentialSource: input.credentialSource,
                githubAppId,
                capabilities: input.capabilities,
                authorizedById: ctx.session.user.id,
                authorizationDigest: digest,
                authorizedAt: now,
              },
            });

        if (prior && prior.authorizationDigest !== digest) {
          await tx.integrationGrant.updateMany({
            where: { connectionAuthorizationId: prior.id, revokedAt: null },
            data: { revokedAt: now, revokedById: ctx.session.user.id },
          });
        }
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "ConnectionAuthorization",
          entityId: authorization.id,
          action: prior ? "reauthorize" : "authorize",
          before: prior ?? undefined,
          after: authorization,
          eventKind: EventKind.INTEGRATION_AUTHORIZATION_CHANGED,
          subjectType: "connection-authorization",
          subjectId: authorization.id,
          payload: { mappingId: mapping.id, credentialSource: input.credentialSource },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return authorization;
      }),
    ),

  revokeAuthorization: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const row = await tx.connectionAuthorization.findFirst({
          where: { id: input.id, workspaceId: ctx.workspaceId },
          include: {
            connectionMapping: { include: { connection: { select: { ownerId: true } } } },
          },
        });
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
        const isAdmin = ctx.membership.role === Role.OWNER || ctx.membership.role === Role.ADMIN;
        if (!isAdmin && row.connectionMapping.connection.ownerId !== ctx.session.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        const now = new Date();
        const updated = await tx.connectionAuthorization.update({
          where: { id: row.id },
          data: { revokedAt: now, revokedById: ctx.session.user.id },
        });
        await tx.integrationGrant.updateMany({
          where: { connectionAuthorizationId: row.id, revokedAt: null },
          data: { revokedAt: now, revokedById: ctx.session.user.id },
        });
        await tx.connectionMapping.update({
          where: { id: row.connectionMappingId },
          data: { status: "paused" },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "ConnectionAuthorization",
          entityId: row.id,
          action: "revoke",
          before: row,
          after: updated,
          eventKind: EventKind.INTEGRATION_AUTHORIZATION_CHANGED,
          subjectType: "connection-authorization",
          subjectId: row.id,
          payload: { mappingId: row.connectionMappingId },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return updated;
      }),
    ),

  upsertGrant: adminProcedure
    .input(
      z.object({
        connectionAuthorizationId: z.string().cuid(),
        principal: principalInput,
        scope: z.nativeEnum(IntegrationGrantScope),
        projectId: z.string().cuid().nullable().optional(),
        capabilities,
      }),
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const authorization = await tx.connectionAuthorization.findFirst({
          where: {
            id: input.connectionAuthorizationId,
            workspaceId: ctx.workspaceId,
            revokedAt: null,
          },
        });
        if (!authorization)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Active credential authorization not found.",
          });
        if (!isSubset(input.capabilities, authorization.capabilities)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Grant exceeds the credential owner's authorized capability ceiling.",
          });
        }
        const projectId =
          input.scope === IntegrationGrantScope.PROJECT ? (input.projectId ?? null) : null;
        if (input.scope === IntegrationGrantScope.PROJECT && !projectId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Project-scoped grants require projectId.",
          });
        }
        if (projectId) {
          const project = await tx.project.findFirst({
            where: { id: projectId, workspaceId: ctx.workspaceId },
            select: { id: true },
          });
          if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found." });
        }

        let principalUserId: string | null = null;
        let principalAgentId: string | null = null;
        let principalApiKeyId: string | null = null;
        if (input.principal.type === IntegrationPrincipalType.USER) {
          const membership = await tx.membership.findUnique({
            where: {
              userId_workspaceId: { userId: input.principal.userId, workspaceId: ctx.workspaceId },
            },
            select: { id: true },
          });
          if (!membership)
            throw new TRPCError({ code: "NOT_FOUND", message: "Workspace member not found." });
          principalUserId = input.principal.userId;
        } else if (input.principal.type === IntegrationPrincipalType.AGENT) {
          const agent = await tx.agent.findFirst({
            where: { id: input.principal.agentId, workspaceId: ctx.workspaceId },
            select: { id: true },
          });
          if (!agent)
            throw new TRPCError({ code: "NOT_FOUND", message: "Workspace agent not found." });
          principalAgentId = agent.id;
        } else if (input.principal.type === IntegrationPrincipalType.API_KEY) {
          const key = await tx.apiKey.findFirst({
            where: { id: input.principal.apiKeyId, workspaceId: ctx.workspaceId, revokedAt: null },
            select: { id: true },
          });
          if (!key)
            throw new TRPCError({ code: "NOT_FOUND", message: "Active API key not found." });
          principalApiKeyId = key.id;
        }

        const existing = await tx.integrationGrant.findFirst({
          where: {
            connectionAuthorizationId: authorization.id,
            principalType: input.principal.type,
            principalUserId,
            principalAgentId,
            principalApiKeyId,
            scope: input.scope,
            projectId,
            revokedAt: null,
          },
        });
        const grant = existing
          ? await tx.integrationGrant.update({
              where: { id: existing.id },
              data: { capabilities: input.capabilities, grantedById: ctx.session.user.id },
            })
          : await tx.integrationGrant.create({
              data: {
                workspaceId: ctx.workspaceId,
                connectionAuthorizationId: authorization.id,
                principalType: input.principal.type,
                principalUserId,
                principalAgentId,
                principalApiKeyId,
                scope: input.scope,
                projectId,
                capabilities: input.capabilities,
                grantedById: ctx.session.user.id,
              },
            });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "IntegrationGrant",
          entityId: grant.id,
          action: existing ? "update" : "create",
          before: existing ?? undefined,
          after: grant,
          eventKind: EventKind.INTEGRATION_AUTHORIZATION_CHANGED,
          subjectType: "integration-grant",
          subjectId: grant.id,
          payload: {
            connectionAuthorizationId: authorization.id,
            principalType: input.principal.type,
            scope: input.scope,
            projectId,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return grant;
      }),
    ),

  revokeGrant: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const row = await tx.integrationGrant.findFirst({
          where: { id: input.id, workspaceId: ctx.workspaceId },
        });
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
        if (row.revokedAt) return row;
        const updated = await tx.integrationGrant.update({
          where: { id: row.id },
          data: { revokedAt: new Date(), revokedById: ctx.session.user.id },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "IntegrationGrant",
          entityId: row.id,
          action: "revoke",
          before: row,
          after: updated,
          eventKind: EventKind.INTEGRATION_AUTHORIZATION_CHANGED,
          subjectType: "integration-grant",
          subjectId: row.id,
          payload: { connectionAuthorizationId: row.connectionAuthorizationId },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return updated;
      }),
    ),
});
