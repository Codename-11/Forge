import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { ConnectionProvider, ConnectionStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { router, globalProcedure, protectedProcedure } from "@/server/trpc";
import { encryptSecret } from "@/server/crypto";

/**
 * Global, user-owned **connections** — external OAuth/OIDC identities
 * (your GitHub login, your Authelia OIDC identity, your Slack auth).
 * Defined once at the account level; mapped into workspaces via
 * `connectionMappings.*`. The provider config is generic (issuer /
 * authUrl / tokenUrl / clientId / scopes), modelled on `SsoProvider` so
 * operators configure their own IdP rather than picking from a hardcoded
 * vendor list. Tokens are encrypted at rest and never returned.
 */

const oidcConfigSchema = z
  .object({
    issuer: z.string().url().optional(),
    authUrl: z.string().url().optional(),
    tokenUrl: z.string().url().optional(),
    userinfoUrl: z.string().url().optional(),
    clientId: z.string().max(256).optional(),
    // clientSecret is encrypted into `tokenEnc` via setToken — not stored here.
  })
  .passthrough();

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
    return rows.map(({ tokenEnc, ...c }) => ({ ...c, hasToken: !!tokenEnc }));
  }),

  get: globalProcedure.input(z.object({ id: z.string().cuid() })).query(async ({ ctx, input }) => {
    const c = await ctx.db.connection.findUnique({
      where: { id: input.id },
      include: { mappings: { include: { workspace: { select: { id: true, slug: true, name: true, key: true } } } } },
    });
    if (!c || c.ownerId !== ctx.session.user.id) throw new TRPCError({ code: "NOT_FOUND" });
    const { tokenEnc, ...rest } = c;
    return { ...rest, hasToken: !!tokenEnc };
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
    .mutation(async ({ ctx, input }) =>
      ctx.db.connection.create({
        data: {
          ownerId: ctx.session.user.id,
          provider: input.provider,
          label: input.label,
          account: input.account,
          scopes: input.scopes,
          config: (input.config ?? undefined) as Prisma.InputJsonValue | undefined,
          status: ConnectionStatus.DISCONNECTED,
        },
      }),
    ),

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
      const owned = await ctx.db.connection.findFirst({ where: { id: input.id, ownerId: ctx.session.user.id }, select: { id: true } });
      if (!owned) throw new TRPCError({ code: "NOT_FOUND" });
      const { id, ...data } = input;
      return ctx.db.connection.update({
        where: { id },
        data: { ...data, config: (input.config ?? undefined) as Prisma.InputJsonValue | undefined },
      });
    }),

  /**
   * Store/refresh the connection's token (encrypted) and flip it
   * CONNECTED. The generic path: an operator pastes a token or the OAuth
   * callback hands one over. `clientSecret` for OIDC providers lives here
   * too (also encrypted).
   */
  setToken: protectedProcedure
    .input(z.object({ id: z.string().cuid(), token: z.string().min(1).max(8192), expiresAt: z.date().nullish() }))
    .mutation(async ({ ctx, input }) => {
      const owned = await ctx.db.connection.findFirst({ where: { id: input.id, ownerId: ctx.session.user.id }, select: { id: true } });
      if (!owned) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.db.connection.update({
        where: { id: input.id },
        data: {
          tokenEnc: encryptSecret(input.token),
          status: ConnectionStatus.CONNECTED,
          error: null,
          expiresAt: input.expiresAt ?? null,
        },
      });
    }),

  disconnect: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const owned = await ctx.db.connection.findFirst({ where: { id: input.id, ownerId: ctx.session.user.id }, select: { id: true } });
      if (!owned) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.db.connection.update({
        where: { id: input.id },
        data: { tokenEnc: null, status: ConnectionStatus.DISCONNECTED },
      });
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const owned = await ctx.db.connection.findFirst({ where: { id: input.id, ownerId: ctx.session.user.id }, select: { id: true } });
      if (!owned) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.db.connection.delete({ where: { id: input.id } });
    }),
});
