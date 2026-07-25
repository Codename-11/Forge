import { InstanceRole } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instanceAdminRouter } from "@/server/routers/instance-admin";
import {
  buildContext,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";
import { _resetBuildInfoCacheForTests } from "@/server/build-info";
import packageJson from "../../../../package.json";

describe("instanceAdmin.system", () => {
  let fixture: TestFixture;

  beforeEach(async () => {
    fixture = await createWorkspaceFixture({ keyPrefix: "IA" });
    await getPrisma().user.update({
      where: { id: fixture.user.id },
      data: { instanceRole: InstanceRole.INSTANCE_ADMIN },
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    _resetBuildInfoCacheForTests();
    await fixture.cleanup();
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  it("uses the canonical packaged version and baked build metadata", async () => {
    vi.stubEnv("npm_package_version", "");
    vi.stubEnv("FORGE_GIT_SHA", "abc1234");
    vi.stubEnv("FORGE_BUILD_TIME", "2026-07-25T15:05:43Z");

    const caller = instanceAdminRouter.createCaller(await buildContext(fixture));

    await expect(caller.system()).resolves.toMatchObject({
      version: packageJson.version,
      buildSha: "abc1234",
      buildTime: "2026-07-25T15:05:43Z",
    });
  });
});
