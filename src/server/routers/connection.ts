import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { ConnectionProvider, ConnectionStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { router, globalProcedure, protectedProcedure } from "@/server/trpc";
import { encryptSecret } from "@/server/crypto";
import {
  decryptBundle,
  encryptBundle,
  mergeConfigUpdate,
  readClientSecret,
  readConfig,
  redactConfig,
  refreshTokens,
  resolveEndpoints,
} from "@/server/services/connections/oauth";

/**
 * Global, user-owned **connections** — external OAuth/OIDC identities
 * (your GitHub login, your Authelia OIDC identity, your Slack auth).
 * Defined once at the account level; mapped into workspaces via
 * `connectionMappings.*`. The provider config is generic (issuer /
 * authUrl / tokenUrl / clientId / scopes), modelled on `SsoProvider` so
 * operators configure their own IdP rather than picking from a hardcoded
 * vendor list. Tokens are encrypted at rest and never returned.
 */

/**
 * OAuth/OIDC client config carried on `connection.config`. `clientId` is
 * plain text; `clientSecret` (plain in) is encrypted into
 * `config.clientSecretEnc` server-side and NEVER returned (see
 * {@link redactConfig}). Empty-string `clientSecret` = leave existing
 * unchanged on update.
 */
const oidcConfigSchema = z.object({
  issuer: z.string().url().optional(),
  authUrl: z.string().url().optional(),
  tokenUrl: z.string().url().optional(),
  userinfoUrl: z.string().url().optional(),
  clientId: z.string().max(256).optional(),
  clientSecret: z.string().max(2048).optional(),
});

export const connectionRouter = router({
  /** The caller's connections + per-workspace mappings. Secrets redacted to `hasToken`. */
  list: globalProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.connection.findMany({
      where: { ownerId: ctx.session.user.id },
      orderBy: { createdAt: "asc" },
      include: {
        mappings: {
          select: {
            id: true,
            kind: true,
            target: true,
            direction: true,
            status: true,
            routeTo: true,
            workspace: { select: { id: true, slug: true, name: true, key: true } },
          },
        },
      },
    });
    return rows.map(({ tokenEnc, config, ...c }) => ({
      ...c,
      config: redactConfig(config),
      hasToken: !!tokenEnc,
    }));
  }),

  get: globalProcedure.input(z.object({ id: z.string().cuid() })).query(async ({ ctx, input }) => {
    const c = await ctx.db.connection.findUnique({
      where: { id: input.id },
      include: {
        mappings: {
          include: { workspace: { select: { id: true, slug: true, name: true, key: true } } },
        },
      },
    });
    if (!c || c.ownerId !== ctx.session.user.id) throw new TRPCError({ code: "NOT_FOUND" });
    const { tokenEnc, config, ...rest } = c;
    return { ...rest, config: redactConfig(config), hasToken: !!tokenEnc };
  }),

  create: protectedProcedure
    .input(
      z.object({
        provider: z.nativeEnum(ConnectionProvider),
        label: z.string().min(1).max(120),
        account: z.string().max(200).optional(),
        scopes: z.array(z.string().max(120)).default([]),
        config: oidcConfigSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Encrypt clientSecret into config.clientSecretEnc; never persist plaintext.
      const config = input.config ? mergeConfigUpdate({}, input.config) : undefined;
      const row = await ctx.db.connection.create({
        data: {
          ownerId: ctx.session.user.id,
          provider: input.provider,
          label: input.label,
          account: input.account,
          scopes: input.scopes,
          config: (config ?? undefined) as Prisma.InputJsonValue | undefined,
          status: ConnectionStatus.DISCONNECTED,
        },
      });
      const { tokenEnc, config: cfg, ...rest } = row;
      return { ...rest, config: redactConfig(cfg), hasToken: !!tokenEnc };
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        label: z.string().min(1).max(120).optional(),
        account: z.string().max(200).nullish(),
        scopes: z.array(z.string().max(120)).optional(),
        config: oidcConfigSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const owned = await ctx.db.connection.findFirst({
        where: { id: input.id, ownerId: ctx.session.user.id },
        select: { id: true, config: true },
      });
      if (!owned) throw new TRPCError({ code: "NOT_FOUND" });
      const { id, config: configPatch, ...data } = input;
      // Merge over existing config so partial updates (e.g. just a new
      // clientSecret) don't clobber issuer/clientId; secret is re-encrypted.
      const config = configPatch
        ? mergeConfigUpdate(readConfig(owned.config), configPatch)
        : undefined;
      const row = await ctx.db.connection.update({
        where: { id },
        data: { ...data, config: (config ?? undefined) as Prisma.InputJsonValue | undefined },
      });
      const { tokenEnc, config: cfg, ...rest } = row;
      return { ...rest, config: redactConfig(cfg), hasToken: !!tokenEnc };
    }),

  /**
   * Store/refresh the connection's token (encrypted) and flip it
   * CONNECTED. The generic path: an operator pastes a token or the OAuth
   * callback hands one over. `clientSecret` for OIDC providers lives here
   * too (also encrypted).
   */
  setToken: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        token: z.string().min(1).max(8192),
        expiresAt: z.date().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const owned = await ctx.db.connection.findFirst({
        where: { id: input.id, ownerId: ctx.session.user.id },
        select: { id: true },
      });
      if (!owned) throw new TRPCError({ code: "NOT_FOUND" });
      const row = await ctx.db.connection.update({
        where: { id: input.id },
        data: {
          tokenEnc: encryptSecret(input.token),
          status: ConnectionStatus.CONNECTED,
          error: null,
          expiresAt: input.expiresAt ?? null,
        },
      });
      const { tokenEnc, config, ...rest } = row;
      return { ...rest, config: redactConfig(config), hasToken: !!tokenEnc };
    }),

  /**
   * Refresh the access token via its stored `refresh_token` when it's within
   * the skew window of expiry (or already expired). No-op if there's nothing
   * to refresh. On refresh failure the connection flips to DEGRADED with the
   * error recorded. Secrets/tokens are never returned. A worker sweep could
   * call this periodically; the procedure is enough for on-demand refresh.
   */
  refreshIfNeeded: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        skewSeconds: z.number().int().min(0).max(86400).default(120),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.connection.findFirst({
        where: { id: input.id, ownerId: ctx.session.user.id },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });

      const bundle = decryptBundle(row.tokenEnc);
      if (!bundle?.refreshToken) {
        return { refreshed: false as const, reason: "no-refresh-token", status: row.status };
      }
      const needs = !bundle.expiresAt || bundle.expiresAt - Date.now() <= input.skewSeconds * 1000;
      if (!needs) {
        return { refreshed: false as const, reason: "not-due", status: row.status };
      }

      const config = readConfig(row.config);
      if (!config.clientId) {
        return { refreshed: false as const, reason: "no-client-id", status: row.status };
      }

      try {
        const endpoints = await resolveEndpoints(row.provider, config);
        const next = await refreshTokens({
          endpoints,
          clientId: config.clientId,
          clientSecret: readClientSecret(config),
          refreshToken: bundle.refreshToken,
        });
        await ctx.db.connection.update({
          where: { id: row.id },
          data: {
            tokenEnc: encryptBundle(next),
            status: ConnectionStatus.CONNECTED,
            error: null,
            expiresAt: next.expiresAt ? new Date(next.expiresAt) : null,
            ...(next.scope ? { scopes: next.scope.split(/\s+/).filter(Boolean) } : {}),
          },
        });
        return { refreshed: true as const, status: ConnectionStatus.CONNECTED };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Token refresh failed.";
        await ctx.db.connection.update({
          where: { id: row.id },
          data: { status: ConnectionStatus.DEGRADED, error: msg.slice(0, 500) },
        });
        return {
          refreshed: false as const,
          reason: "refresh-failed",
          error: msg,
          status: ConnectionStatus.DEGRADED,
        };
      }
    }),

  disconnect: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const owned = await ctx.db.connection.findFirst({
        where: { id: input.id, ownerId: ctx.session.user.id },
        select: { id: true },
      });
      if (!owned) throw new TRPCError({ code: "NOT_FOUND" });
      const row = await ctx.db.$transaction(async (tx) => {
        const mappings = await tx.connectionMapping.findMany({
          where: { connectionId: input.id },
          select: { id: true, authorization: { select: { id: true } } },
        });
        const authorizationIds = mappings
          .map((mapping) => mapping.authorization?.id)
          .filter((id): id is string => Boolean(id));
        const now = new Date();
        if (authorizationIds.length > 0) {
          await tx.integrationGrant.updateMany({
            where: { connectionAuthorizationId: { in: authorizationIds }, revokedAt: null },
            data: { revokedAt: now, revokedById: ctx.session.user.id },
          });
          await tx.connectionAuthorization.updateMany({
            where: { id: { in: authorizationIds }, revokedAt: null },
            data: { revokedAt: now, revokedById: ctx.session.user.id },
          });
        }
        await tx.connectionMapping.updateMany({
          where: { connectionId: input.id },
          data: { status: "paused" },
        });
        return tx.connection.update({
          where: { id: input.id },
          data: { tokenEnc: null, status: ConnectionStatus.DISCONNECTED },
        });
      });
      const { tokenEnc, config, ...rest } = row;
      return { ...rest, config: redactConfig(config), hasToken: !!tokenEnc };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const owned = await ctx.db.connection.findFirst({
        where: { id: input.id, ownerId: ctx.session.user.id },
        select: { id: true },
      });
      if (!owned) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.db.connection.delete({ where: { id: input.id } });
      return { id: input.id, deleted: true as const };
    }),
});
