import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetBuildInfoCacheForTests,
  forgeBuildIdentity,
  mcpServerInfo,
} from "@/server/build-info";

describe("build identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetBuildInfoCacheForTests();
  });

  it("reports package version plus baked Forge build metadata", async () => {
    vi.stubEnv("npm_package_version", "9.8.7");
    vi.stubEnv("FORGE_GIT_SHA", "abc1234");
    vi.stubEnv("FORGE_BUILD_TIME", "2026-06-09T06:00:00Z");

    await expect(forgeBuildIdentity()).resolves.toEqual({
      version: "9.8.7",
      gitSha: "abc1234",
      buildTime: "2026-06-09T06:00:00Z",
    });
  });

  it("includes build identity in MCP serverInfo", async () => {
    vi.stubEnv("npm_package_version", "9.8.7");
    vi.stubEnv("FORGE_GIT_SHA", "abc1234");
    vi.stubEnv("FORGE_BUILD_TIME", "2026-06-09T06:00:00Z");

    await expect(mcpServerInfo()).resolves.toEqual({
      name: "forge",
      title: "Forge",
      version: "9.8.7",
      gitSha: "abc1234",
      buildTime: "2026-06-09T06:00:00Z",
    });
  });
});
