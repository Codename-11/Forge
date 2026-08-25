import "server-only";
import type { SsoProvider, SsoType } from "@prisma/client";
import { db } from "@/server/db";
import { encryptSecret } from "@/server/crypto";

/**
 * DB-backed sign-in provider plumbing.
 *
 * Providers live in the `SsoProvider` table (instance-global) instead of
 * env vars, so an instance admin can add / enable / disable them from the
 * UI without a redeploy. NextAuth reads them at request time via the lazy
 * config in `auth.ts`; this module owns the DB read (cached), the
 * one-time env→DB migration seed, and the public (secret-free) listing the
 * sign-in page renders buttons from.
 */

// ---- read cache ----------------------------------------------------------
// Auth reads happen on most RSC renders (`auth()`), so we don't want a DB
// round-trip every time. A short TTL keeps newly-toggled providers from
// going stale for long; mutations call `bustSsoCache()` for instant effect
// within the same process.
const TTL_MS = 30_000;
let cache: { rows: SsoProvider[]; at: number } | null = null;

export function bustSsoCache() {
  cache = null;
}

/** All *enabled* providers, cached. Includes the encrypted secret. */
export async function getEnabledSsoRows(): Promise<SsoProvider[]> {
  await seedSsoFromEnvOnce();
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.rows;
  const rows = await db.ssoProvider.findMany({
    where: { enabled: true, archivedAt: null },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  cache = { rows, at: now };
  return rows;
}

/** The NextAuth provider id for a row (callback URL = /api/auth/callback/<id>). */
export function providerIdFor(row: Pick<SsoProvider, "id" | "type">): string {
  // GitHub/Google use NextAuth's built-in factory ids so existing OAuth-app
  // callback URLs keep working; OIDC rows are addressed by their row id.
  return row.type === "OIDC" ? row.id : row.type.toLowerCase();
}

export type PublicSsoProvider = { providerId: string; name: string; type: SsoType };

/** Secret-free listing for the sign-in page (and anywhere client-reachable). */
export async function listEnabledSsoProviders(): Promise<PublicSsoProvider[]> {
  const rows = await getEnabledSsoRows();
  return rows.map((r) => ({ providerId: providerIdFor(r), name: r.name, type: r.type }));
}

// ---- one-time env → DB seed ----------------------------------------------
// Preserves the previous env-driven behavior: if AUTH_GITHUB_* / AUTH_GOOGLE_*
// are set and no row of that type exists yet, create an enabled row so the
// provider keeps working after the migration. Idempotent and deduped per
// process.
let seedPromise: Promise<void> | null = null;

export function seedSsoFromEnvOnce(): Promise<void> {
  seedPromise ??= (async () => {
    const seeds: { type: SsoType; name: string; id?: string; secret?: string }[] = [];
    if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
      seeds.push({
        type: "GITHUB",
        name: "GitHub",
        id: process.env.AUTH_GITHUB_ID,
        secret: process.env.AUTH_GITHUB_SECRET,
      });
    }
    if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
      seeds.push({
        type: "GOOGLE",
        name: "Google",
        id: process.env.AUTH_GOOGLE_ID,
        secret: process.env.AUTH_GOOGLE_SECRET,
      });
    }
    if (seeds.length === 0) return;

    for (const s of seeds) {
      const existing = await db.ssoProvider.findFirst({ where: { type: s.type } });
      if (existing) continue;
      await db.ssoProvider.create({
        data: {
          type: s.type,
          name: s.name,
          enabled: true,
          clientId: s.id!,
          clientSecret: encryptSecret(s.secret!),
        },
      });
    }
  })().catch((err) => {
    // Don't let a seed failure wedge auth forever — log and allow retry.
    seedPromise = null;
    console.error("[sso] env seed failed:", err);
  });
  return seedPromise;
}
