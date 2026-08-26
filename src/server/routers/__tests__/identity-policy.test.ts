import { InstanceRole } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ssoRouter } from "@/server/routers/sso";
import { userRouter } from "@/server/routers/user";
import { instanceAdminRouter } from "@/server/routers/instance-admin";
import {
  buildContext,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";
import { hashPassword } from "@/server/services/local-credentials";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  const db = getPrisma();
  await db.instanceAuthPolicy.upsert({
    where: { id: "default" },
    update: {
      mode: "HYBRID",
      registrationMode: "INVITE_ONLY",
      breakGlassCredentialsEnabled: true,
      breakGlassUserId: null,
      autoRedirectProviderId: null,
      passwordMinLength: 12,
      passwordResetTtlMinutes: 30,
      lockoutThreshold: 10,
      lockoutMinutes: 15,
    },
    create: { id: "default" },
  });
  while (fixtures.length) await fixtures.pop()!.cleanup();
  await db.ssoProvider.deleteMany({ where: { name: { startsWith: "Identity policy test" } } });
  vi.unstubAllEnvs();
});

afterAll(async () => disconnectPrisma());

async function adminFixture() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "IP" });
  fixtures.push(fixture);
  await getPrisma().user.update({
    where: { id: fixture.user.id },
    data: { instanceRole: InstanceRole.INSTANCE_ADMIN },
  });
  return fixture;
}

const policyInput = {
  mode: "HYBRID" as const,
  registrationMode: "INVITE_ONLY" as const,
  breakGlassCredentialsEnabled: false,
  breakGlassUserId: null,
  autoRedirectProviderId: null,
  passwordMinLength: 12,
  passwordResetTtlMinutes: 30,
  lockoutThreshold: 10,
  lockoutMinutes: 15,
};

describe("identity policy guards", () => {
  it("refuses to remove the final administrator recovery path", async () => {
    const fixture = await adminFixture();
    vi.stubEnv("ADMIN_EMAIL", "");
    vi.stubEnv("ADMIN_PASSWORD", "");
    const caller = ssoRouter.createCaller(await buildContext(fixture));

    await expect(caller.updatePolicy(policyInput)).rejects.toThrow(/usable sign-in method/i);
  });

  it("allows a local-only policy when an active administrator has a password", async () => {
    const fixture = await adminFixture();
    vi.stubEnv("ADMIN_EMAIL", "");
    vi.stubEnv("ADMIN_PASSWORD", "");
    await getPrisma().localCredential.create({
      data: {
        userId: fixture.user.id,
        passwordHash: await hashPassword("identity policy password"),
      },
    });
    const caller = ssoRouter.createCaller(await buildContext(fixture));

    await expect(
      caller.updatePolicy({ ...policyInput, mode: "LOCAL_ONLY" }),
    ).resolves.toMatchObject({ mode: "LOCAL_ONLY", breakGlassCredentialsEnabled: false });
  });

  it("does not count a disabled provider account as a usable password replacement", async () => {
    const fixture = await adminFixture();
    const password = "identity removal password";
    await getPrisma().localCredential.create({
      data: { userId: fixture.user.id, passwordHash: await hashPassword(password) },
    });
    await getPrisma().account.create({
      data: {
        userId: fixture.user.id,
        type: "oauth",
        provider: "github",
        providerAccountId: `disabled-${fixture.user.id}`,
      },
    });
    const caller = userRouter.createCaller(await buildContext(fixture));

    await expect(caller.removePassword({ currentPassword: password })).rejects.toThrow(
      /enabled external sign-in method/i,
    );
  });

  it("does not count a local password in external-only mode when unlinking the final provider", async () => {
    const fixture = await adminFixture();
    const db = getPrisma();
    await db.localCredential.create({
      data: { userId: fixture.user.id, passwordHash: await hashPassword("external-only password") },
    });
    const provider = await db.ssoProvider.create({
      data: {
        type: "GITHUB",
        name: "Identity policy test GitHub",
        enabled: true,
        clientId: "test-client",
        clientSecret: "test-secret",
      },
    });
    void provider;
    const account = await db.account.create({
      data: {
        userId: fixture.user.id,
        type: "oauth",
        provider: "github",
        providerAccountId: `enabled-${fixture.user.id}`,
      },
    });
    await db.instanceAuthPolicy.update({
      where: { id: "default" },
      data: { mode: "EXTERNAL_ONLY" },
    });
    const caller = userRouter.createCaller(await buildContext(fixture));

    await expect(caller.unlinkIdentity({ accountId: account.id })).rejects.toThrow(
      /final sign-in method/i,
    );
  });

  it("designates an active matching administrator and reports recovery readiness", async () => {
    const fixture = await adminFixture();
    vi.stubEnv("ADMIN_EMAIL", fixture.user.email);
    vi.stubEnv("ADMIN_PASSWORD", "environment recovery password");
    const caller = ssoRouter.createCaller(await buildContext(fixture));

    await expect(
      caller.updatePolicy({
        ...policyInput,
        breakGlassCredentialsEnabled: true,
        breakGlassUserId: fixture.user.id,
      }),
    ).resolves.toMatchObject({
      breakGlassCredentialsEnabled: true,
      breakGlassUserId: fixture.user.id,
    });
    await expect(caller.policy()).resolves.toMatchObject({
      breakGlassConfigured: true,
      breakGlassReady: true,
      breakGlassPrincipal: { id: fixture.user.id, email: fixture.user.email },
    });
  });

  it("rejects a mismatched principal and protects the designated recovery administrator", async () => {
    const fixture = await adminFixture();
    vi.stubEnv("ADMIN_EMAIL", "recovery@example.test");
    vi.stubEnv("ADMIN_PASSWORD", "environment recovery password");
    const context = await buildContext(fixture);
    const sso = ssoRouter.createCaller(context);

    await expect(
      sso.updatePolicy({
        ...policyInput,
        breakGlassCredentialsEnabled: true,
        breakGlassUserId: fixture.user.id,
      }),
    ).rejects.toThrow(/email matches ADMIN_EMAIL/i);

    vi.stubEnv("ADMIN_EMAIL", fixture.user.email);
    await sso.updatePolicy({
      ...policyInput,
      breakGlassCredentialsEnabled: true,
      breakGlassUserId: fixture.user.id,
    });
    const admin = instanceAdminRouter.createCaller(context);
    await expect(
      admin.setInstanceRole({ userId: fixture.user.id, role: "MEMBER" }),
    ).rejects.toThrow(/reassign or disable break-glass/i);
    await expect(admin.suspendUser({ userId: fixture.user.id })).rejects.toThrow(
      /reassign or disable break-glass/i,
    );
  });
});
