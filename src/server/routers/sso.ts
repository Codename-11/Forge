import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { SsoType } from "@prisma/client";
import { router, instanceAdminProcedure } from "@/server/trpc";
import { encryptSecret } from "@/server/crypto";
import { bustSsoCache, providerIdFor } from "@/server/sso";

const typeEnum = z.nativeEnum(SsoType);

/** Trim + collapse an issuer URL to a bare origin+path with no trailing slash. */
function normalizeIssuer(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  // Validate it parses; throw a friendly error otherwise.
  try {
    new URL(trimmed);
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Issuer must be a valid URL." });
  }
  return trimmed;
}

export const ssoRouter = router({
  /**
   * Full provider inventory for the admin UI. Secrets are never returned —
   * only a `hasSecret` flag so the form can show "configured" / "replace".
   */
  list: instanceAdminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.ssoProvider.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      providerId: providerIdFor(r),
      type: r.type,
      name: r.name,
      enabled: r.enabled,
      issuer: r.issuer,
      clientId: r.clientId,
      scopes: r.scopes,
      allowLinking: r.allowLinking,
      sortOrder: r.sortOrder,
      hasSecret: r.clientSecret.length > 0,
      createdAt: r.createdAt,
      callbackPath: `/api/auth/callback/${providerIdFor(r)}`,
    }));
  }),

  create: instanceAdminProcedure
    .input(
      z.object({
        type: typeEnum,
        name: z.string().trim().min(1).max(80),
        issuer: z.string().trim().optional(),
        clientId: z.string().trim().min(1),
        clientSecret: z.string().min(1),
        scopes: z.string().trim().optional(),
        allowLinking: z.boolean().default(false),
        enabled: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.type === "OIDC" && !input.issuer) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "OIDC providers require an issuer URL." });
      }
      // GitHub/Google map onto fixed NextAuth provider ids, so only one of
      // each can exist (two would collide on the same callback URL).
      if (input.type !== "OIDC") {
        const dupe = await ctx.db.ssoProvider.findFirst({ where: { type: input.type } });
        if (dupe) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `A ${input.type} provider already exists. Edit it instead.`,
          });
        }
      }
      const count = await ctx.db.ssoProvider.count();
      const row = await ctx.db.ssoProvider.create({
        data: {
          type: input.type,
          name: input.name,
          enabled: input.enabled,
          issuer: input.type === "OIDC" ? normalizeIssuer(input.issuer!) : null,
          clientId: input.clientId,
          clientSecret: encryptSecret(input.clientSecret),
          scopes: input.scopes || null,
          allowLinking: input.allowLinking,
          sortOrder: count,
        },
      });
      bustSsoCache();
      return { id: row.id, callbackPath: `/api/auth/callback/${providerIdFor(row)}` };
    }),

  update: instanceAdminProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().trim().min(1).max(80).optional(),
        issuer: z.string().trim().optional(),
        clientId: z.string().trim().min(1).optional(),
        // Empty string = leave the stored secret unchanged.
        clientSecret: z.string().optional(),
        scopes: z.string().trim().optional(),
        allowLinking: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.ssoProvider.findUnique({ where: { id: input.id } });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });

      await ctx.db.ssoProvider.update({
        where: { id: input.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
          ...(input.scopes !== undefined ? { scopes: input.scopes || null } : {}),
          ...(input.allowLinking !== undefined ? { allowLinking: input.allowLinking } : {}),
          ...(existing.type === "OIDC" && input.issuer !== undefined
            ? { issuer: normalizeIssuer(input.issuer) }
            : {}),
          ...(input.clientSecret
            ? { clientSecret: encryptSecret(input.clientSecret) }
            : {}),
        },
      });
      bustSsoCache();
      return { ok: true };
    }),

  setEnabled: instanceAdminProcedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.ssoProvider.update({
        where: { id: input.id },
        data: { enabled: input.enabled },
      });
      bustSsoCache();
      return { ok: true };
    }),

  remove: instanceAdminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.ssoProvider.delete({ where: { id: input.id } });
      bustSsoCache();
      return { ok: true };
    }),

  /**
   * Probe an OIDC issuer's discovery document so the admin gets immediate
   * feedback (good URL? reachable? endpoints present?) before saving.
   */
  testDiscovery: instanceAdminProcedure
    .input(z.object({ issuer: z.string().trim().min(1) }))
    .mutation(async ({ input }) => {
      const issuer = normalizeIssuer(input.issuer);
      const url = `${issuer}/.well-known/openid-configuration`;
      try {
        const ctl = AbortSignal.timeout(8000);
        const res = await fetch(url, { signal: ctl, headers: { accept: "application/json" } });
        if (!res.ok) {
          return { ok: false as const, error: `Discovery returned HTTP ${res.status}.` };
        }
        const doc = (await res.json()) as Record<string, unknown>;
        const authz = typeof doc.authorization_endpoint === "string" ? doc.authorization_endpoint : null;
        const token = typeof doc.token_endpoint === "string" ? doc.token_endpoint : null;
        if (!authz || !token) {
          return { ok: false as const, error: "Discovery doc is missing required endpoints." };
        }
        return {
          ok: true as const,
          issuer: typeof doc.issuer === "string" ? doc.issuer : issuer,
          authorizationEndpoint: authz,
          tokenEndpoint: token,
        };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? `Could not reach issuer: ${err.message}` : "Discovery failed.",
        };
      }
    }),
});
