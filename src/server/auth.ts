import "server-only";
import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/server/db";
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

const providers: NextAuthConfig["providers"] = [
  Credentials({
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
        update: {},
        create: {
          email: adminEmail,
          name: process.env.ADMIN_NAME ?? "Admin",
          handle: (process.env.ADMIN_HANDLE ?? "admin").toLowerCase(),
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
  }),
];

if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
  providers.push(
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
    }),
  );
}
if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: "jwt" },
  providers,
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
