import "server-only";
import NextAuth, { type NextAuthConfig } from "next-auth";
import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/server/db";
import { decryptSecret } from "@/server/crypto";
import { getEnabledSsoRows, providerIdFor } from "@/server/sso";
import { z } from "zod";

/**
 * Env-driven admin authentication.
 *
 * The Credentials provider compares the submitted email+password against
 * ADMIN_EMAIL / ADMIN_PASSWORD. On first successful sign-in, the user
 * and their default workspace are upserted into the DB so later requests
 * resolve a stable `session.user.id`.
 *
 * Credentials + the Prisma adapter require `jwt` session strategy — the
 * adapter only writes the User/Account rows; the session lives in the
 * JWT cookie.
 */

const credentialsProvider = Credentials({
    name: "Admin",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    async authorize(raw) {
      const parsed = z
        .object({ email: z.string().email(), password: z.string().min(1) })
        .safeParse(raw);
      if (!parsed.success) return null;
      const { email, password } = parsed.data;

      const adminEmail = process.env.ADMIN_EMAIL;
      const adminPass = process.env.ADMIN_PASSWORD;
      if (!adminEmail || !adminPass) return null;
      if (email.toLowerCase() !== adminEmail.toLowerCase()) return null;

      // Constant-time-ish compare — for a single admin secret the risk
      // window is tiny, but avoid short-circuit just in case.
      if (password.length !== adminPass.length) return null;
      let ok = 1;
      for (let i = 0; i < password.length; i++) {
        ok &= password.charCodeAt(i) === adminPass.charCodeAt(i) ? 1 : 0;
      }
      if (!ok) return null;

      const user = await db.user.upsert({
        where: { email: adminEmail },
        // The bootstrap operator is the instance admin. Stamp it on both
        // paths so an existing pre-restructure admin row self-heals to
        // INSTANCE_ADMIN on next sign-in (the env-based fallback in
        // trpc.ts covers the gap before that happens).
        update: { instanceRole: "INSTANCE_ADMIN" },
        create: {
          email: adminEmail,
          name: process.env.ADMIN_NAME ?? "Admin",
          handle: (process.env.ADMIN_HANDLE ?? "admin").toLowerCase(),
          instanceRole: "INSTANCE_ADMIN",
        },
      });

      const existing = await db.membership.findFirst({ where: { userId: user.id } });
      if (!existing) {
        await db.workspace.create({
          data: {
            slug: (process.env.ADMIN_HANDLE ?? "admin").toLowerCase(),
            name: process.env.ADMIN_NAME ?? "Admin",
            key: "FRG",
            memberships: { create: { userId: user.id, role: "OWNER" } },
            statuses: {
              create: [
                { name: "Backlog", category: "BACKLOG", color: "#78716c", position: 0, isDefault: true },
                { name: "Todo", category: "TODO", color: "#a8a29e", position: 1 },
                { name: "In Progress", category: "IN_PROGRESS", color: "#d97706", position: 2 },
                { name: "In Review", category: "IN_REVIEW", color: "#ca8a04", position: 3 },
                { name: "Done", category: "DONE", color: "#65a30d", position: 4 },
                { name: "Canceled", category: "CANCELED", color: "#57534e", position: 5 },
              ],
            },
          },
        });
      }

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
      };
    },
  },
);

/**
 * Map the enabled `SsoProvider` rows to NextAuth provider instances.
 *
 * - **OIDC** rows become a generic OpenID-Connect provider (auto-discovery
 *   from `<issuer>/.well-known/openid-configuration`). One row type covers
 *   every compliant IdP — Authelia, Authentik, Keycloak, Okta, Azure AD…
 * - **GitHub / Google** rows use NextAuth's built-in factories so their
 *   callback URLs stay `/api/auth/callback/{github,google}`.
 *
 * Client secrets are decrypted here (server-only) right before handing them
 * to NextAuth; `allowDangerousEmailAccountLinking` is opt-in per row.
 */
async function ssoProvidersFromDb(): Promise<Provider[]> {
  const rows = await getEnabledSsoRows();
  const providers: Provider[] = [];
  for (const row of rows) {
    let clientSecret: string;
    try {
      clientSecret = decryptSecret(row.clientSecret);
    } catch (err) {
      // A single un-decryptable secret (e.g. AUTH_SECRET rotated) must not
      // take down sign-in for every other provider.
      console.error(`[sso] skipping provider ${row.id} (${row.type}): bad secret`, err);
      continue;
    }
    const link = row.allowLinking;
    if (row.type === "OIDC") {
      if (!row.issuer) continue;
      providers.push({
        id: providerIdFor(row),
        name: row.name,
        type: "oidc",
        issuer: row.issuer,
        clientId: row.clientId,
        clientSecret,
        allowDangerousEmailAccountLinking: link,
        ...(row.scopes ? { authorization: { params: { scope: row.scopes } } } : {}),
      });
    } else if (row.type === "GITHUB") {
      providers.push(
        GitHub({ clientId: row.clientId, clientSecret, allowDangerousEmailAccountLinking: link }),
      );
    } else if (row.type === "GOOGLE") {
      providers.push(
        Google({ clientId: row.clientId, clientSecret, allowDangerousEmailAccountLinking: link }),
      );
    }
  }
  return providers;
}

export const { handlers, auth, signIn, signOut } = NextAuth(async () => {
  const config: NextAuthConfig = {
    adapter: PrismaAdapter(db),
    session: { strategy: "jwt" },
    providers: [credentialsProvider, ...(await ssoProvidersFromDb())],
    pages: {
      signIn: "/signin",
    },
    callbacks: {
      async jwt({ token, user }) {
        if (user?.id) token.id = user.id;
        return token;
      },
      async session({ session, token }) {
        if (session.user && token.id) {
          session.user.id = token.id as string;
        }
        return session;
      },
    },
  };
  return config;
});

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
    };
  }
}
