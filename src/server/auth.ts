import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import NextAuth, { type NextAuthConfig, type Session } from "next-auth";
import type { Adapter, AdapterUser } from "next-auth/adapters";
import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { UserStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "@/server/db";
import { decryptSecret } from "@/server/crypto";
import { getEnabledSsoRows, providerIdFor } from "@/server/sso";
import { getInstanceAuthPolicy } from "@/server/services/auth-policy";
import {
  hashPassword,
  needsPasswordRehash,
  verifyPasswordOrDummy,
} from "@/server/services/local-credentials";
import { normalizeAuthEmail } from "@/server/services/auth-tokens";
import { rateLimit } from "@/server/rate-limit";

const credentialInput = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(4096),
  breakGlass: z.enum(["0", "1"]).optional(),
});

function secureStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

async function authRateLimit(email: string, request: Request): Promise<boolean> {
  const emailKey = createHash("sha256").update(email).digest("hex");
  const [byIp, byAccount] = await Promise.all([
    rateLimit(`signin:ip:${requestIp(request)}`, 30, 60),
    rateLimit(`signin:account:${emailKey}`, 12, 15 * 60),
  ]);
  return byIp.ok && byAccount.ok;
}

async function ensureBootstrapOperator(email: string): Promise<AdapterUser | null> {
  const configured = process.env.ADMIN_EMAIL;
  if (!configured || normalizeAuthEmail(configured) !== email) return null;

  const existing = await db.user.findFirst({
    where: { OR: [{ normalizedEmail: email }, { email: configured }] },
  });
  if (existing) return existing as AdapterUser;
  if ((await db.user.count()) > 0) return null;

  const user = await db.user.create({
    data: {
      email,
      normalizedEmail: email,
      emailVerified: new Date(),
      name: process.env.ADMIN_NAME ?? "Admin",
      handle: (process.env.ADMIN_HANDLE ?? "admin").toLowerCase(),
      instanceRole: "INSTANCE_ADMIN",
      status: UserStatus.ACTIVE,
    },
  });

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
  return user as AdapterUser;
}

async function verifyBootstrapCredential(email: string, password: string): Promise<boolean> {
  const configuredEmail = process.env.ADMIN_EMAIL;
  const configuredPassword = process.env.ADMIN_PASSWORD;
  return Boolean(
    configuredEmail &&
    configuredPassword &&
    secureStringEqual(normalizeAuthEmail(configuredEmail), email) &&
    secureStringEqual(configuredPassword, password),
  );
}

const credentialsProvider = Credentials({
  name: "Forge password",
  credentials: {
    email: { label: "Email", type: "email" },
    password: { label: "Password", type: "password" },
    breakGlass: { label: "Break glass", type: "hidden" },
  },
  async authorize(raw, request) {
    const parsed = credentialInput.safeParse(raw);
    if (!parsed.success) return null;
    const email = normalizeAuthEmail(parsed.data.email);
    if (!(await authRateLimit(email, request))) return null;

    const policy = await getInstanceAuthPolicy();
    const explicitBreakGlass = parsed.data.breakGlass === "1";
    const localAllowed = policy.mode !== "EXTERNAL_ONLY";
    const breakGlassAllowed = explicitBreakGlass && policy.breakGlassCredentialsEnabled;

    let user = await db.user.findFirst({
      where: {
        OR: [{ normalizedEmail: email }, { email: { equals: email, mode: "insensitive" } }],
      },
      include: { localCredential: true },
    });
    const localMatch = await verifyPasswordOrDummy(
      parsed.data.password,
      user?.localCredential?.passwordHash,
    );
    const bootstrapMatch =
      policy.breakGlassCredentialsEnabled &&
      (breakGlassAllowed || localAllowed) &&
      (await verifyBootstrapCredential(email, parsed.data.password));

    if ((!localAllowed || !localMatch) && !bootstrapMatch) {
      if (user?.localCredential) {
        const nextAttempts = user.localCredential.failedAttempts + 1;
        const lockedUntil =
          nextAttempts >= policy.lockoutThreshold
            ? new Date(Date.now() + policy.lockoutMinutes * 60_000)
            : undefined;
        await db.localCredential.update({
          where: { userId: user.id },
          data: {
            failedAttempts: { increment: 1 },
            lastFailedAt: new Date(),
            ...(lockedUntil ? { lockedUntil } : {}),
          },
        });
      }
      return null;
    }

    if (!user && bootstrapMatch) {
      const bootstrapped = await ensureBootstrapOperator(email);
      if (!bootstrapped) return null;
      user = await db.user.findUnique({
        where: { id: bootstrapped.id },
        include: { localCredential: true },
      });
    }
    if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt || user.disabledAt)
      return null;
    if (user.localCredential?.lockedUntil && user.localCredential.lockedUntil > new Date())
      return null;
    if (explicitBreakGlass && user.instanceRole !== "INSTANCE_ADMIN") return null;

    if (localMatch && user.localCredential) {
      const nextHash = needsPasswordRehash(user.localCredential.passwordHash)
        ? await hashPassword(parsed.data.password)
        : undefined;
      await db.localCredential.update({
        where: { userId: user.id },
        data: {
          failedAttempts: 0,
          lastFailedAt: null,
          lockedUntil: null,
          lastUsedAt: new Date(),
          ...(nextHash ? { passwordHash: nextHash, passwordChangedAt: new Date() } : {}),
        },
      });
    }

    await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), normalizedEmail: email },
    });
    return { id: user.id, email: user.email, name: user.name, image: user.image };
  },
});

async function ssoProvidersFromDb(): Promise<Provider[]> {
  const policy = await getInstanceAuthPolicy();
  if (policy.mode === "LOCAL_ONLY") return [];

  const rows = await getEnabledSsoRows();
  const providers: Provider[] = [];
  for (const row of rows) {
    let clientSecret: string;
    try {
      clientSecret = decryptSecret(row.clientSecret);
    } catch (error) {
      console.error(`[sso] skipping provider ${row.id} (${row.type}): bad secret`, error);
      continue;
    }
    const common = { allowDangerousEmailAccountLinking: row.allowLinking };
    if (row.type === "OIDC" && row.issuer) {
      providers.push({
        id: providerIdFor(row),
        name: row.name,
        type: "oidc",
        issuer: row.issuer,
        clientId: row.clientId,
        clientSecret,
        ...common,
        ...(row.scopes ? { authorization: { params: { scope: row.scopes } } } : {}),
      });
    } else if (row.type === "GITHUB") {
      providers.push(GitHub({ clientId: row.clientId, clientSecret, ...common }));
    } else if (row.type === "GOOGLE") {
      providers.push(Google({ clientId: row.clientId, clientSecret, ...common }));
    }
  }
  return providers;
}

function forgeAdapter(): Adapter {
  const base = PrismaAdapter(db);
  return {
    ...base,
    async createUser(data) {
      const email = normalizeAuthEmail(data.email);
      const existing = await db.user.findFirst({
        where: {
          OR: [{ normalizedEmail: email }, { email: { equals: email, mode: "insensitive" } }],
        },
      });
      if (existing) {
        if (existing.status === UserStatus.SUSPENDED || existing.status === UserStatus.DELETED) {
          throw new Error("This Forge account is not active.");
        }
        return db.user.update({
          where: { id: existing.id },
          data: {
            normalizedEmail: email,
            status: UserStatus.ACTIVE,
            emailVerified: data.emailVerified ?? existing.emailVerified,
            name: existing.name ?? data.name,
            image: existing.image ?? data.image,
            lastLoginAt: new Date(),
          },
        }) as Promise<AdapterUser>;
      }

      const policy = await getInstanceAuthPolicy();
      const invited = await db.workspaceInvitation.findFirst({
        where: { email, status: "PENDING", expiresAt: { gt: new Date() } },
        select: { id: true },
      });
      if (policy.registrationMode !== "OPEN" && !invited) {
        throw new Error("This Forge instance requires an invitation.");
      }
      return db.user.create({
        data: {
          email,
          normalizedEmail: email,
          emailVerified: data.emailVerified,
          name: data.name,
          image: data.image,
          status: UserStatus.ACTIVE,
        },
      }) as Promise<AdapterUser>;
    },
    async getUserByEmail(email) {
      const normalizedEmail = normalizeAuthEmail(email);
      return db.user.findFirst({
        where: {
          OR: [{ normalizedEmail }, { email: { equals: normalizedEmail, mode: "insensitive" } }],
        },
      }) as Promise<AdapterUser | null>;
    },
    async updateUser(data) {
      const normalizedEmail = data.email ? normalizeAuthEmail(data.email) : undefined;
      return db.user.update({
        where: { id: data.id },
        data: {
          ...data,
          ...(normalizedEmail ? { email: normalizedEmail, normalizedEmail } : {}),
        },
      }) as Promise<AdapterUser>;
    },
    async linkAccount(account) {
      if (!base.linkAccount) throw new Error("Auth adapter cannot link accounts.");
      await base.linkAccount({
        ...account,
        access_token: undefined,
        refresh_token: undefined,
        id_token: undefined,
      });
    },
  };
}

const nextAuth = NextAuth(async () => {
  const config: NextAuthConfig = {
    adapter: forgeAdapter(),
    session: { strategy: "jwt" },
    providers: [credentialsProvider, ...(await ssoProvidersFromDb())],
    pages: { signIn: "/signin" },
    callbacks: {
      async signIn({ user, account }) {
        if (account?.provider !== "credentials") {
          const policy = await getInstanceAuthPolicy();
          if (policy.mode === "LOCAL_ONLY") return false;
          const normalizedEmail = user.email ? normalizeAuthEmail(user.email) : null;
          const current = await db.user.findFirst({
            where: {
              OR: [
                ...(user.id ? [{ id: user.id }] : []),
                ...(normalizedEmail
                  ? [
                      { normalizedEmail },
                      { email: { equals: normalizedEmail, mode: "insensitive" as const } },
                    ]
                  : []),
              ],
            },
          });
          // A new provider profile has not passed through adapter.createUser
          // yet. Registration/invitation policy is enforced there. Existing
          // principals must already be active.
          if (!current) return true;
          if (current.status !== UserStatus.ACTIVE || current.disabledAt || current.deletedAt) {
            return false;
          }
          await db.user.update({ where: { id: current.id }, data: { lastLoginAt: new Date() } });
          return true;
        }

        if (!user.id) return false;
        const current = await db.user.findUnique({ where: { id: user.id } });
        if (
          !current ||
          current.status !== UserStatus.ACTIVE ||
          current.disabledAt ||
          current.deletedAt
        ) {
          return false;
        }
        return true;
      },
      async jwt({ token, user }) {
        if (user?.id) {
          const current = await db.user.findUnique({
            where: { id: user.id },
            select: { authVersion: true, status: true },
          });
          token.id = user.id;
          token.authVersion = current?.authVersion ?? 0;
          token.accountStatus = current?.status ?? UserStatus.ACTIVE;
        }
        return token;
      },
      async session({ session, token }) {
        if (session.user && token.id) {
          session.user.id = token.id as string;
          session.user.authVersion = Number(token.authVersion ?? 0);
          session.user.status = String(token.accountStatus ?? UserStatus.ACTIVE) as UserStatus;
        }
        return session;
      },
    },
  };
  return config;
});

export const { handlers, signIn, signOut } = nextAuth;

/**
 * Auth.js JWTs are stateless, so every protected request re-checks the durable
 * account status and authVersion. Password changes, suspension, deletion, and
 * explicit session revocation increment the version and take effect at once.
 */
export async function auth(): Promise<Session | null> {
  const session = await nextAuth.auth();
  if (!session?.user?.id) return null;
  const current = await db.user.findUnique({
    where: { id: session.user.id },
    select: { status: true, authVersion: true, disabledAt: true, deletedAt: true },
  });
  if (
    !current ||
    current.status !== UserStatus.ACTIVE ||
    current.disabledAt ||
    current.deletedAt ||
    current.authVersion !== session.user.authVersion
  ) {
    return null;
  }
  return session;
}

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
      authVersion: number;
      status: UserStatus;
    };
  }
}
