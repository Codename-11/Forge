import { createHash, randomBytes, scrypt } from "node:crypto";
import { PrismaClient, UserActionTokenType, UserStatus } from "@prisma/client";
import { expect, test } from "@playwright/test";

const localE2eDatabase = "postgresql://forge:forge@localhost:55432/forge_e2e?schema=public";
const prisma = new PrismaClient({
  datasourceUrl:
    process.env.E2E_DATABASE_URL ??
    (process.env.E2E_MANAGE_STACK === "0" ? process.env.DATABASE_URL : localE2eDatabase),
});
const initialPassword = "forge identity initial password";
const resetPassword = "forge identity reset password";
const email = `identity-e2e-${Date.now()}@forge.local`;

async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      32,
      { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
  return `$forge$scrypt$v=1$n=32768,r=8,p=3$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

function resetTokenHash(raw: string): string {
  return createHash("sha256").update("forge:user-action:v1:").update(raw).digest("hex");
}

function invitationTokenHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

test.describe("local identity lifecycle", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email,
        normalizedEmail: email,
        emailVerified: new Date(),
        name: "Identity E2E",
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.localCredential.create({
      data: { userId: user.id, passwordHash: await passwordHash(initialPassword) },
    });
  });

  test.afterAll(async () => {
    await prisma.user.deleteMany({ where: { normalizedEmail: email } });
    await prisma.$disconnect();
  });

  test("signs in with a durable local credential", async ({ page }) => {
    await page.goto("/signin?manual=1&callbackUrl=/settings/security");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(initialPassword);
    await page.getByRole("button", { name: /^sign in/i }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/settings/security");
    await expect(page.getByRole("heading", { name: "Security & sign-in" })).toBeVisible();
  });

  test("keeps forgotten-password requests enumeration safe", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(`missing-${email}`);
    await page.getByRole("button", { name: /send reset link/i }).click();
    await expect(page).toHaveURL(/sent=1/);
    await expect(page.getByText(/if an eligible local account exists/i)).toBeVisible();
  });

  test("consumes one reset token, revokes the old password, and accepts the new one", async ({
    page,
  }) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { normalizedEmail: email } });
    const rawToken = randomBytes(32).toString("base64url");
    await prisma.userActionToken.create({
      data: {
        userId: user.id,
        type: UserActionTokenType.PASSWORD_RESET,
        tokenHash: resetTokenHash(rawToken),
        emailSnapshot: email,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });

    await page.goto(`/reset-password/${rawToken}`);
    await page.getByLabel("New password").fill(resetPassword);
    await page.getByLabel("Confirm password").fill(resetPassword);
    await page.getByRole("button", { name: /save new password/i }).click();
    await expect(page).toHaveURL(/\/signin\/local/);

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(initialPassword);
    await page.getByRole("button", { name: /^sign in/i }).click();
    await expect(page).toHaveURL(/error=/);

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(resetPassword);
    await page.getByRole("button", { name: /^sign in/i }).click();
    await expect(page).not.toHaveURL(/\/signin/);

    const consumed = await prisma.userActionToken.findUniqueOrThrow({
      where: { tokenHash: resetTokenHash(rawToken) },
    });
    expect(consumed.usedAt).not.toBeNull();
  });

  test("creates a local account directly from a workspace invitation", async ({ page }) => {
    const invitedEmail = `workspace-local-${Date.now()}@forge.local`;
    const invitedPassword = "workspace invitation password";
    const token = randomBytes(32).toString("base64url");
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: "forge" } });
    const owner = await prisma.membership.findFirstOrThrow({
      where: { workspaceId: workspace.id, role: "OWNER" },
      select: { userId: true },
    });
    await prisma.workspaceInvitation.create({
      data: {
        workspaceId: workspace.id,
        email: invitedEmail,
        tokenHash: invitationTokenHash(token),
        invitedById: owner.userId,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });

    await page.goto(`/invite/${token}/local`);
    await page.getByLabel("Name").fill("Workspace Local User");
    await page.getByLabel("Password", { exact: true }).fill(invitedPassword);
    await page.getByLabel("Confirm password").fill(invitedPassword);
    await page.getByRole("button", { name: /create account and join/i }).click();
    await expect(page).toHaveURL(/\/signin\/local/);

    await page.getByLabel("Email").fill(invitedEmail);
    await page.getByLabel("Password").fill(invitedPassword);
    await page.getByRole("button", { name: /^sign in/i }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/w/forge/dashboard");

    await expect(
      prisma.user.findUniqueOrThrow({
        where: { normalizedEmail: invitedEmail },
        include: { localCredential: true, memberships: true },
      }),
    ).resolves.toMatchObject({
      status: "ACTIVE",
      localCredential: expect.objectContaining({ userId: expect.any(String) }),
      memberships: expect.arrayContaining([
        expect.objectContaining({ workspaceId: workspace.id, role: "MEMBER" }),
      ]),
    });
  });
});
