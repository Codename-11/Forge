import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma, PluginStatus, PluginScope } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { router, adminProcedure, workspaceProcedure } from "@/server/trpc";
import { manifestSchema, type PluginManifest } from "@/server/services/plugin-manifest";

function generateApiKey(prefix = "forge_sk"): { raw: string; hashed: string; prefix: string } {
  const rawBytes = randomBytes(32).toString("base64url");
  const raw = `${prefix}_${rawBytes}`;
  const hashed = createHash("sha256").update(raw).digest("hex");
  return { raw, hashed, prefix: raw.slice(0, prefix.length + 9) };
}

function sorted<T extends string>(values: T[]): T[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function scopeDelta(previous: PluginScope[], next: PluginScope[]) {
  const prior = new Set(previous);
  const current = new Set(next);
  return {
    addedScopes: next.filter((scope) => !prior.has(scope)),
    removedScopes: previous.filter((scope) => !current.has(scope)),
  };
}

function normalizeManifest(manifest: PluginManifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    slug: manifest.slug,
    name: manifest.name,
    description: manifest.description ?? null,
    version: manifest.version,
    author: manifest.author ?? null,
    scopes: sorted(manifest.scopes),
    events: sorted(manifest.events),
    skills: [...manifest.skills]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((skill) => ({
        name: skill.name,
        description: skill.description ?? null,
        inputSchema: skill.inputSchema,
        outputSchema: skill.outputSchema ?? null,
        runtime: skill.runtime,
      })),
    rateLimit: manifest.rateLimit,
  };
}

function manifestFingerprint(value: unknown): string {
  const parsed = manifestSchema.safeParse(value);
  return JSON.stringify(parsed.success ? normalizeManifest(parsed.data) : value);
}

export const pluginRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) =>
    ctx.db.plugin.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { createdAt: "desc" },
      include: { skills: true },
    }),
  ),

  byId: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const plugin = await ctx.db.plugin.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          skills: true,
          apiKeys: {
            where: { revokedAt: null },
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              name: true,
              prefix: true,
              scopes: true,
              lastUsedAt: true,
              expiresAt: true,
              createdAt: true,
            },
          },
          webhooks: {
            select: { id: true, url: true, events: true, active: true },
          },
        },
      });
      if (!plugin) throw new TRPCError({ code: "NOT_FOUND" });
      // Never expose the HMAC `secret` to the client.
      const { secret: _secret, ...rest } = plugin;
      return rest;
    }),

  register: adminProcedure
    .input(
      z.object({
        manifest: manifestSchema,
        webhookUrl: z.string().url().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const m = input.manifest;
      const existing = await ctx.db.plugin.findUnique({
        where: { workspaceId_slug: { workspaceId: ctx.workspaceId, slug: m.slug } },
        include: { skills: true },
      });

      return ctx.db.$transaction(async (tx) => {
        if (existing) {
          const { addedScopes, removedScopes } = scopeDelta(existing.scopes, m.scopes);
          const webhookChanged =
            input.webhookUrl !== undefined && input.webhookUrl !== existing.webhookUrl;
          const manifestChanged =
            manifestFingerprint(existing.manifest) !== manifestFingerprint(m);
          const reviewRequired = manifestChanged || webhookChanged;
          const nextStatus = reviewRequired ? PluginStatus.PENDING : existing.status;

          const plugin = await tx.plugin.update({
            where: { id: existing.id },
            data: {
              name: m.name,
              description: m.description ?? null,
              version: m.version,
              manifest: m as unknown as Prisma.InputJsonValue,
              scopes: m.scopes,
              status: nextStatus,
              ...(input.webhookUrl !== undefined ? { webhookUrl: input.webhookUrl } : {}),
            },
          });
          await tx.skill.deleteMany({ where: { pluginId: existing.id } });
          for (const s of m.skills ?? []) {
            await tx.skill.create({
              data: {
                workspaceId: ctx.workspaceId,
                pluginId: plugin.id,
                name: s.name,
                description: s.description ?? null,
                inputSchema: s.inputSchema as Prisma.InputJsonValue,
                outputSchema: (s.outputSchema ?? Prisma.JsonNull) as Prisma.InputJsonValue,
                runtime: s.runtime,
              },
            });
          }
          return {
            ...plugin,
            installAction: reviewRequired ? ("updated" as const) : ("unchanged" as const),
            reviewRequired,
            priorVersion: existing.version,
            priorStatus: existing.status,
            addedScopes,
            removedScopes,
          };
        }

        const plugin = await tx.plugin.create({
          data: {
            workspaceId: ctx.workspaceId,
            slug: m.slug,
            name: m.name,
            description: m.description ?? null,
            version: m.version,
            manifest: m as unknown as Prisma.InputJsonValue,
            scopes: m.scopes,
            status: PluginStatus.PENDING,
            webhookUrl: input.webhookUrl,
            secret: randomBytes(24).toString("base64url"),
          },
        });
        for (const s of m.skills ?? []) {
          await tx.skill.create({
            data: {
              workspaceId: ctx.workspaceId,
              pluginId: plugin.id,
              name: s.name,
              description: s.description ?? null,
              inputSchema: s.inputSchema as Prisma.InputJsonValue,
              outputSchema: (s.outputSchema ?? Prisma.JsonNull) as Prisma.InputJsonValue,
              runtime: s.runtime,
            },
          });
        }
        return {
          ...plugin,
          installAction: "registered" as const,
          reviewRequired: true,
          priorVersion: null,
          priorStatus: null,
          addedScopes: m.scopes,
          removedScopes: [],
        };
      });
    }),

  approve: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.plugin.update({
        where: { id: input.id },
        data: { status: PluginStatus.APPROVED },
      }),
    ),

  suspend: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.plugin.update({
        where: { id: input.id },
        data: { status: PluginStatus.SUSPENDED },
      }),
    ),

  issueApiKey: adminProcedure
    .input(
      z.object({
        pluginId: z.string().cuid(),
        name: z.string().min(1).max(80),
        scopes: z.array(z.nativeEnum(PluginScope)).min(1),
        expiresInDays: z.number().min(1).max(365).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const plugin = await ctx.db.plugin.findFirstOrThrow({
        where: { id: input.pluginId, workspaceId: ctx.workspaceId },
      });
      if (plugin.status !== PluginStatus.APPROVED) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Plugin must be approved before issuing API keys.",
        });
      }
      // Enforce that requested scopes are a subset of declared plugin scopes.
      const allowed = new Set(plugin.scopes);
      const bad = input.scopes.filter((s) => !allowed.has(s));
      if (bad.length)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Requested scopes not declared in manifest: ${bad.join(", ")}`,
        });

      const { raw, hashed, prefix } = generateApiKey();
      const key = await ctx.db.apiKey.create({
        data: {
          workspaceId: ctx.workspaceId,
          pluginId: plugin.id,
          name: input.name,
          hashedKey: hashed,
          prefix,
          scopes: input.scopes,
          expiresAt: input.expiresInDays
            ? new Date(Date.now() + input.expiresInDays * 86_400_000)
            : undefined,
        },
      });
      // Returned once. Never stored in plaintext.
      return { ...key, rawKey: raw };
    }),

  revokeApiKey: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.apiKey.update({
        where: { id: input.id },
        data: { revokedAt: new Date() },
      }),
    ),

  // Hard-delete the registration. Cascades drop the plugin's skills,
  // api keys, and webhooks (FK onDelete: Cascade). Linked issues are
  // unaffected — they don't reference the plugin.
  remove: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const plugin = await ctx.db.plugin.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!plugin) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.db.plugin.delete({ where: { id: plugin.id } });
      return { id: plugin.id };
    }),

  // Roll the plugin's HMAC signing secret. The raw value is never
  // returned to the client; the plugin re-fetches it out of band.
  rotateSecret: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const plugin = await ctx.db.plugin.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!plugin) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.db.plugin.update({
        where: { id: plugin.id },
        data: { secret: randomBytes(24).toString("base64url") },
      });
      return { id: plugin.id };
    }),
});
