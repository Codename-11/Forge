import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma, PluginStatus, PluginScope } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { router, adminProcedure, workspaceProcedure } from "@/server/trpc";
import { manifestSchema } from "@/server/services/plugin-manifest";

function generateApiKey(prefix = "forge_sk"): { raw: string; hashed: string; prefix: string } {
  const rawBytes = randomBytes(32).toString("base64url");
  const raw = `${prefix}_${rawBytes}`;
  const hashed = createHash("sha256").update(raw).digest("hex");
  return { raw, hashed, prefix: raw.slice(0, prefix.length + 9) };
}

export const pluginRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) =>
    ctx.db.plugin.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { createdAt: "desc" },
      include: { skills: true },
    }),
  ),

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
      });
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "Slug already registered." });

      return ctx.db.$transaction(async (tx) => {
        const plugin = await tx.plugin.create({
          data: {
            workspaceId: ctx.workspaceId,
            slug: m.slug,
            name: m.name,
            description: m.description,
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
              description: s.description,
              inputSchema: s.inputSchema as Prisma.InputJsonValue,
              outputSchema: (s.outputSchema ?? Prisma.JsonNull) as Prisma.InputJsonValue,
              runtime: s.runtime,
            },
          });
        }
        return plugin;
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
});
