import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";
import { router, workspaceProcedure, adminProcedure } from "@/server/trpc";
import { encryptSecret, decryptSecret } from "@/server/crypto";
import {
  configureStoredGithubAppWebhook,
  refreshStoredGithubAppSyncReadiness,
  verifyGithubApp,
  invalidateInstallationToken,
} from "@/server/services/github-app";

/**
 * Workspace-scoped **GitHub App** management for runtime git auth. One app can
 * be shared across many runtimes (each `Runtime.githubAppId` points at a row
 * here). Apps are created either via the manifest flow (API routes under
 * `/api/integrations/github-app/*`, which create the row directly) or manually
 * here. Token minting + injection happens in `runtimes.provisioning`.
 *
 * The PEM private key is write-only — never returned to any client.
 */

const appId = z.string().min(1).max(40);

/** Numeric GitHub identifier (App ID, installation ID). */
const githubNumericId = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^\d+$/, "Must be a numeric GitHub ID (digits only).");

/** A GitHub App's PEM private key (must look like a PEM, not a token). */
const githubPrivateKey = z
  .string()
  .trim()
  .min(1)
  .max(20_000)
  .refine((p) => p.includes("PRIVATE KEY"), {
    message: "Paste the full PEM private key, including the BEGIN/END lines.",
  });

/** GitHub App slug (from the app's URL, e.g. `forge-bot`). */
const githubAppSlug = z
  .string()
  .trim()
  .max(60)
  .regex(/^[a-z0-9-]*$/, "Lowercase letters, numbers, and hyphens only.")
  .optional()
  .or(z.literal(""));

const appName = z.string().trim().min(1).max(120);

/** Metadata-only projection — never includes privateKeyEnc. */
const appSelect = {
  id: true,
  name: true,
  appId: true,
  installationId: true,
  slug: true,
  createdViaManifest: true,
  lastMintedAt: true,
  lastError: true,
  webhookConfiguredAt: true,
  webhookLastCheckedAt: true,
  webhookLastError: true,
  updatedAt: true,
} as const;

function forgeWebhookUrl(): string {
  const configured = process.env.AUTH_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Set AUTH_URL before enabling GitHub webhooks.",
    });
  }
  let url: URL;
  try {
    url = new URL("/api/ingest/github", configured);
  } catch {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "AUTH_URL is not a valid URL." });
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "GitHub webhooks require an HTTPS public URL.",
    });
  }
  return url.toString();
}

/** Confirm an app belongs to the caller's workspace, or 404. */
async function assertAppInWorkspace(
  db: PrismaClient,
  workspaceId: string,
  id: string,
): Promise<{ id: string }> {
  const app = await db.githubApp.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });
  if (!app) {
    throw new TRPCError({ code: "NOT_FOUND", message: "GitHub App not found in this workspace." });
  }
  return app;
}

export const githubAppRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.githubApp.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { createdAt: "asc" },
      select: { ...appSelect, _count: { select: { runtimes: true } } },
    });
    return rows.map((r) => ({
      ...r,
      runtimeCount: r._count.runtimes,
      installed: !!r.installationId,
    }));
  }),

  get: workspaceProcedure.input(z.object({ id: appId })).query(async ({ ctx, input }) => {
    const app = await ctx.db.githubApp.findFirst({
      where: { id: input.id, workspaceId: ctx.workspaceId },
      select: appSelect,
    });
    return app; // null if not found
  }),

  createManual: adminProcedure
    .input(
      z.object({
        name: appName,
        appId: githubNumericId,
        installationId: githubNumericId,
        privateKey: githubPrivateKey,
        slug: githubAppSlug,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.githubApp.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: input.name,
          appId: input.appId,
          installationId: input.installationId,
          privateKeyEnc: encryptSecret(input.privateKey),
          slug: input.slug || null,
          createdViaManifest: false,
        },
        select: appSelect,
      });
    }),

  update: adminProcedure
    .input(
      z.object({
        id: appId,
        name: appName.optional(),
        appId: githubNumericId.optional(),
        installationId: githubNumericId.optional(),
        // Omit to keep the stored key.
        privateKey: githubPrivateKey.optional(),
        slug: githubAppSlug,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const app = await assertAppInWorkspace(ctx.db, ctx.workspaceId, input.id);
      invalidateInstallationToken(app.id);
      return ctx.db.githubApp.update({
        where: { id: app.id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.appId ? { appId: input.appId } : {}),
          ...(input.installationId ? { installationId: input.installationId } : {}),
          ...(input.privateKey ? { privateKeyEnc: encryptSecret(input.privateKey) } : {}),
          ...(input.slug !== undefined ? { slug: input.slug || null } : {}),
          lastError: null,
        },
        select: appSelect,
      });
    }),

  delete: adminProcedure.input(z.object({ id: appId })).mutation(async ({ ctx, input }) => {
    const app = await assertAppInWorkspace(ctx.db, ctx.workspaceId, input.id);
    invalidateInstallationToken(app.id);
    // Runtimes pointing here are unlinked (FK is SET NULL).
    await ctx.db.githubApp.delete({ where: { id: app.id } });
    return { ok: true };
  }),

  // Live credential check: sign as the app, mint a token, report what it can
  // reach. Persists discovered slug + health for the UI.
  test: adminProcedure.input(z.object({ id: appId })).mutation(async ({ ctx, input }) => {
    const app = await ctx.db.githubApp.findFirst({
      where: { id: input.id, workspaceId: ctx.workspaceId },
      select: { id: true, appId: true, installationId: true, privateKeyEnc: true, slug: true },
    });
    if (!app) {
      throw new TRPCError({ code: "NOT_FOUND", message: "GitHub App not found." });
    }
    if (!app.installationId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Install the app on GitHub first — no installation ID yet.",
      });
    }
    try {
      const result = await verifyGithubApp({
        appId: app.appId,
        installationId: app.installationId,
        privateKeyPem: decryptSecret(app.privateKeyEnc),
      });
      await ctx.db.githubApp.update({
        where: { id: app.id },
        data: {
          lastMintedAt: new Date(),
          lastError: null,
          ...(result.slug && !app.slug ? { slug: result.slug } : {}),
        },
      });
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : "GitHub App check failed.";
      await ctx.db.githubApp.update({ where: { id: app.id }, data: { lastError: message } });
      throw new TRPCError({ code: "BAD_REQUEST", message });
    }
  }),

  /**
   * Make this workspace App authoritative for native issue/PR webhooks. The
   * secret rotates with an old+new grace pair so a process interruption cannot
   * leave GitHub and Forge unable to authenticate each other.
   */
  configureWebhook: adminProcedure
    .input(z.object({ id: appId }))
    .mutation(async ({ ctx, input }) => {
      const url = forgeWebhookUrl();
      try {
        return await configureStoredGithubAppWebhook({
          db: ctx.db,
          githubAppId: input.id,
          workspaceId: ctx.workspaceId,
          url,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "GitHub webhook setup failed.";
        throw new TRPCError({ code: "BAD_REQUEST", message });
      }
    }),

  /** Recheck GitHub without rotating or otherwise changing credentials. */
  refreshSyncStatus: adminProcedure
    .input(z.object({ id: appId }))
    .mutation(async ({ ctx, input }) => {
      const url = forgeWebhookUrl();
      try {
        return await refreshStoredGithubAppSyncReadiness({
          db: ctx.db,
          githubAppId: input.id,
          workspaceId: ctx.workspaceId,
          expectedWebhookUrl: url,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "GitHub sync check failed.";
        throw new TRPCError({ code: "BAD_REQUEST", message });
      }
    }),
});
