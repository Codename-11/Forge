import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  AuthenticationMode,
  RegistrationMode,
  SsoType,
  type InstanceAuthPolicy,
  type PrismaClient,
} from "@prisma/client";
import { router, instanceAdminProcedure } from "@/server/trpc";
import { encryptSecret } from "@/server/crypto";
import { bustSsoCache, providerIdFor } from "@/server/sso";
import {
  deriveAuthPresentation,
  getInstanceAuthPolicy,
  validateAuthPolicyTransition,
} from "@/server/services/auth-policy";

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

async function assertAdminRecoveryPath(
  database: Pick<PrismaClient, "user">,
  policy: Pick<InstanceAuthPolicy, "mode" | "breakGlassCredentialsEnabled" | "breakGlassUserId">,
  providers: Array<{ id: string; type: SsoType; enabled: boolean; archivedAt: Date | null }>,
): Promise<void> {
  if (
    policy.breakGlassCredentialsEnabled &&
    process.env.ADMIN_EMAIL &&
    process.env.ADMIN_PASSWORD &&
    policy.breakGlassUserId
  ) {
    const designated = await database.user.findFirst({
      where: {
        id: policy.breakGlassUserId,
        instanceRole: "INSTANCE_ADMIN",
        status: "ACTIVE",
        disabledAt: null,
        deletedAt: null,
        OR: [
          { normalizedEmail: process.env.ADMIN_EMAIL.trim().toLowerCase() },
          { email: { equals: process.env.ADMIN_EMAIL, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });
    if (designated) return;
  }
  const providerKeys = providers
    .filter((provider) => provider.enabled && !provider.archivedAt)
    .map((provider) => providerIdFor(provider));
  const methodClauses = [
    ...(policy.mode !== "EXTERNAL_ONLY" ? [{ localCredential: { isNot: null } }] : []),
    ...(policy.mode !== "LOCAL_ONLY" && providerKeys.length
      ? [{ accounts: { some: { provider: { in: providerKeys } } } }]
      : []),
  ];
  if (
    methodClauses.length === 0 ||
    (await database.user.count({
      where: {
        instanceRole: "INSTANCE_ADMIN",
        status: "ACTIVE",
        disabledAt: null,
        deletedAt: null,
        OR: methodClauses,
      },
    })) === 0
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Keep at least one active instance administrator with a usable sign-in method or configured break-glass credentials.",
    });
  }
}

export const ssoRouter = router({
  policy: instanceAdminProcedure.query(async ({ ctx }) => {
    const [policy, providers, breakGlassCandidates] = await Promise.all([
      getInstanceAuthPolicy(ctx.db),
      ctx.db.ssoProvider.findMany({
        where: { archivedAt: null },
        select: { id: true, type: true, enabled: true, archivedAt: true },
      }),
      ctx.db.user.findMany({
        where: {
          instanceRole: "INSTANCE_ADMIN",
          status: "ACTIVE",
          disabledAt: null,
          deletedAt: null,
        },
        orderBy: [{ name: "asc" }, { email: "asc" }],
        select: { id: true, name: true, email: true },
      }),
    ]);
    const configuredEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase() ?? null;
    const designated = breakGlassCandidates.find(
      (candidate) => candidate.id === policy.breakGlassUserId,
    );
    const breakGlassConfigured = Boolean(configuredEmail && process.env.ADMIN_PASSWORD);
    const breakGlassReady = Boolean(
      policy.breakGlassCredentialsEnabled &&
      breakGlassConfigured &&
      designated &&
      designated.email.trim().toLowerCase() === configuredEmail,
    );
    return {
      policy,
      presentation: deriveAuthPresentation(policy, providers),
      breakGlassConfigured,
      breakGlassReady,
      breakGlassPrincipal: designated ?? null,
      breakGlassCandidates,
    };
  }),

  updatePolicy: instanceAdminProcedure
    .input(
      z.object({
        mode: z.nativeEnum(AuthenticationMode),
        registrationMode: z.nativeEnum(RegistrationMode),
        breakGlassCredentialsEnabled: z.boolean(),
        breakGlassUserId: z.string().cuid().nullable(),
        autoRedirectProviderId: z.string().cuid().nullable(),
        passwordMinLength: z.number().int().min(8).max(128),
        passwordResetTtlMinutes: z.number().int().min(5).max(1440),
        lockoutThreshold: z.number().int().min(3).max(100),
        lockoutMinutes: z.number().int().min(1).max(1440),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const providers = await ctx.db.ssoProvider.findMany({
        where: { archivedAt: null },
        select: { id: true, type: true, enabled: true, archivedAt: true },
      });
      validateAuthPolicyTransition({ id: "default", ...input }, providers, {
        breakGlassConfigured: Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD),
      });
      if (!input.breakGlassCredentialsEnabled && input.breakGlassUserId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Disable break-glass recovery without retaining a designated principal.",
        });
      }
      if (input.breakGlassCredentialsEnabled) {
        const configuredEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
        if (!configuredEmail || !process.env.ADMIN_PASSWORD || !input.breakGlassUserId) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Break-glass recovery requires configured environment credentials and a designated active instance administrator.",
          });
        }
        const designated = await ctx.db.user.findFirst({
          where: {
            id: input.breakGlassUserId,
            instanceRole: "INSTANCE_ADMIN",
            status: "ACTIVE",
            disabledAt: null,
            deletedAt: null,
            OR: [
              { normalizedEmail: configuredEmail },
              { email: { equals: configuredEmail, mode: "insensitive" } },
            ],
          },
          select: { id: true },
        });
        if (!designated) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "The designated break-glass principal must be an active instance administrator whose email matches ADMIN_EMAIL.",
          });
        }
      }
      await assertAdminRecoveryPath(ctx.db, input, providers);
      const policy = await ctx.db.instanceAuthPolicy.upsert({
        where: { id: "default" },
        update: input,
        create: { id: "default", ...input },
      });
      await ctx.db.instanceAuditLog.create({
        data: {
          actorId: ctx.session.user.id,
          action: "AUTH_POLICY_UPDATED",
          metadata: input,
          ipAddress: ctx.ip,
          userAgent: ctx.userAgent,
        },
      });
      bustSsoCache();
      return policy;
    }),

  /**
   * Full provider inventory for the admin UI. Secrets are never returned —
   * only a `hasSecret` flag so the form can show "configured" / "replace".
   */
  list: instanceAdminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.ssoProvider.findMany({
      where: { archivedAt: null },
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
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "OIDC providers require an issuer URL.",
        });
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
          ...(input.clientSecret ? { clientSecret: encryptSecret(input.clientSecret) } : {}),
        },
      });
      bustSsoCache();
      return { ok: true };
    }),

  setEnabled: instanceAdminProcedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [policy, providers] = await Promise.all([
        getInstanceAuthPolicy(ctx.db),
        ctx.db.ssoProvider.findMany({
          where: { archivedAt: null },
          select: { id: true, type: true, enabled: true, archivedAt: true },
        }),
      ]);
      const nextProviders = providers.map((provider) =>
        provider.id === input.id ? { ...provider, enabled: input.enabled } : provider,
      );
      const nextPolicy = {
        ...policy,
        autoRedirectProviderId:
          !input.enabled && policy.autoRedirectProviderId === input.id
            ? null
            : policy.autoRedirectProviderId,
      };
      validateAuthPolicyTransition(nextPolicy, nextProviders, {
        breakGlassConfigured: Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD),
      });
      await assertAdminRecoveryPath(ctx.db, nextPolicy, nextProviders);
      await ctx.db.$transaction(async (tx) => {
        await tx.ssoProvider.update({ where: { id: input.id }, data: { enabled: input.enabled } });
        if (nextPolicy.autoRedirectProviderId !== policy.autoRedirectProviderId) {
          await tx.instanceAuthPolicy.update({
            where: { id: policy.id },
            data: { autoRedirectProviderId: null },
          });
        }
        await tx.instanceAuditLog.create({
          data: {
            actorId: ctx.session.user.id,
            action: input.enabled ? "SSO_PROVIDER_ENABLED" : "SSO_PROVIDER_DISABLED",
            metadata: { providerId: input.id },
            ipAddress: ctx.ip,
            userAgent: ctx.userAgent,
          },
        });
      });
      bustSsoCache();
      return { ok: true };
    }),

  remove: instanceAdminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [policy, providers] = await Promise.all([
        getInstanceAuthPolicy(ctx.db),
        ctx.db.ssoProvider.findMany({
          where: { archivedAt: null },
          select: { id: true, type: true, enabled: true, archivedAt: true },
        }),
      ]);
      const nextProviders = providers
        .filter((provider) => provider.id !== input.id)
        .map((provider) => ({ ...provider }));
      const nextPolicy = {
        ...policy,
        autoRedirectProviderId:
          policy.autoRedirectProviderId === input.id ? null : policy.autoRedirectProviderId,
      };
      validateAuthPolicyTransition(nextPolicy, nextProviders, {
        breakGlassConfigured: Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD),
      });
      await assertAdminRecoveryPath(ctx.db, nextPolicy, nextProviders);
      await ctx.db.$transaction(async (tx) => {
        await tx.ssoProvider.update({
          where: { id: input.id },
          data: { enabled: false, archivedAt: new Date() },
        });
        if (nextPolicy.autoRedirectProviderId !== policy.autoRedirectProviderId) {
          await tx.instanceAuthPolicy.update({
            where: { id: policy.id },
            data: { autoRedirectProviderId: null },
          });
        }
        await tx.instanceAuditLog.create({
          data: {
            actorId: ctx.session.user.id,
            action: "SSO_PROVIDER_ARCHIVED",
            metadata: { providerId: input.id },
            ipAddress: ctx.ip,
            userAgent: ctx.userAgent,
          },
        });
      });
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
        const authz =
          typeof doc.authorization_endpoint === "string" ? doc.authorization_endpoint : null;
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
          error:
            err instanceof Error ? `Could not reach issuer: ${err.message}` : "Discovery failed.",
        };
      }
    }),
});
