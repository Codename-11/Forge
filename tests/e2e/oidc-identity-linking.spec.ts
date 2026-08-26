import { createCipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";

const localE2eDatabase = "postgresql://forge:forge@localhost:55432/forge_e2e?schema=public";
const prisma = new PrismaClient({
  datasourceUrl:
    process.env.E2E_DATABASE_URL ??
    (process.env.E2E_MANAGE_STACK === "0" ? process.env.DATABASE_URL : localE2eDatabase),
});
const localUserEmail = process.env.E2E_OIDC_EMAIL ?? "oidc-link-user@forge.local";
const localUserPassword = "forge strict OIDC local password";
const issuer = process.env.E2E_OIDC_ISSUER ?? "http://127.0.0.1:3211";
let providerId = "";
let localUserId = "";

function encryptSecret(plaintext: string): string {
  const secret = process.env.AUTH_SECRET ?? "e2e-secret-changeme-0000000000000000";
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join(":");
}

async function localSignIn(page: import("@playwright/test").Page) {
  await page.goto("/signin?manual=1");
  await page.getByLabel("Email").fill(localUserEmail);
  await page.getByLabel("Password").fill(localUserPassword);
  await page.getByRole("button", { name: /^sign in/i }).click();
  await expect(page).not.toHaveURL(/\/signin/);
}

async function linkStrictOidc(page: import("@playwright/test").Page) {
  await page.goto("/settings/security");
  await page.getByRole("button", { name: "Link Strict OIDC" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    `You are signed in as ${localUserEmail}`,
  );
  await expect(page.getByRole("alertdialog")).toContainText(
    "does not create an integration connection",
  );
  await page.getByRole("button", { name: "Continue to Strict OIDC" }).click();
  await expect(page).toHaveURL(/\/settings\/security/);
  await expect(page.getByText("Strict OIDC", { exact: true }).first()).toBeVisible();
}

test.describe("strict generic OIDC identity linking", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async () => {
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { slug: "forge" },
      select: { id: true },
    });
    const salt = randomBytes(16);
    const passwordKey = await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        localUserPassword,
        salt,
        32,
        { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
        (error, derived) => (error ? reject(error) : resolve(derived)),
      );
    });
    const passwordHash = `$forge$scrypt$v=1$n=32768,r=8,p=3$${salt.toString("base64url")}$${passwordKey.toString("base64url")}`;
    const localUser = await prisma.user.create({
      data: {
        email: localUserEmail,
        normalizedEmail: localUserEmail,
        emailVerified: new Date(),
        name: "OIDC Link Test User",
        status: "ACTIVE",
        localCredential: { create: { passwordHash } },
        memberships: { create: { workspaceId: workspace.id, role: "MEMBER" } },
      },
      select: { id: true },
    });
    localUserId = localUser.id;
    const provider = await prisma.ssoProvider.create({
      data: {
        type: "OIDC",
        name: "Strict OIDC",
        issuer,
        clientId: "forge-strict-oidc",
        clientSecret: encryptSecret("forge-strict-oidc-secret"),
        scopes: "openid profile email",
        allowLinking: true,
        enabled: true,
      },
    });
    providerId = provider.id;
  });

  test.afterAll(async () => {
    if (providerId) {
      await prisma.account.deleteMany({ where: { provider: providerId } });
      await prisma.ssoProvider.deleteMany({ where: { id: providerId } });
    }
    if (localUserId) await prisma.user.deleteMany({ where: { id: localUserId } });
    await prisma.$disconnect();
  });

  test("requires strong state, PKCE, and nonce while linking and relinking the same user", async ({
    page,
    request,
  }) => {
    const weak = await request.get(
      `${issuer}/authorize?client_id=forge-strict-oidc&redirect_uri=${encodeURIComponent("http://localhost:3200/api/auth/callback/example")}&response_type=code&scope=openid&state=weak&nonce=missing-pkce`,
    );
    expect(weak.status()).toBe(400);
    await expect(weak.json()).resolves.toEqual({ error: "weak_state" });

    await localSignIn(page);
    await linkStrictOidc(page);

    await expect(
      prisma.account.findUniqueOrThrow({
        where: {
          provider_providerAccountId: { provider: providerId, providerAccountId: "strict-user" },
        },
        select: { userId: true },
      }),
    ).resolves.toEqual({ userId: localUserId });

    await page.getByRole("button", { name: "Unlink" }).click();
    await expect(page.getByText("Unlink Strict OIDC?", { exact: true })).toBeVisible();
    await page.locator('[role="alertdialog"] button[type="submit"]').click();
    await expect(page).toHaveURL(/\/signin/);
    await expect(prisma.account.count({ where: { provider: providerId } })).resolves.toBe(0);

    await localSignIn(page);
    await linkStrictOidc(page);
    await expect(
      prisma.account.count({ where: { provider: providerId, userId: localUserId } }),
    ).resolves.toBe(1);
  });
});
