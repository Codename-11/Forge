import { InstanceRole } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ssoRouter } from "@/server/routers/sso";
import { userRouter } from "@/server/routers/user";
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
  while (fixtures.length) await fixtures.pop()!.cleanup();
  await db.ssoProvider.deleteMany({ where: { name: { startsWith: "Identity policy test" } } });
  await db.instanceAuthPolicy.upsert({
    where: { id: "default" },
    update: {
      mode: "HYBRID",
      registrationMode: "INVITE_ONLY",
      breakGlassCredentialsEnabled: true,
      autoRedirectProviderId: null,
      passwordMinLength: 12,
      passwordResetTtlMinutes: 30,
      lockoutThreshold: 10,
      lockoutMinutes: 15,
    },
    create: { id: "default" },
  });
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
});
