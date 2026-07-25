import { mkdtemp, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireDirectoryLock,
  buildLocalCiPlan,
  buildPortCandidates,
  parseLocalCiOptions,
} from "../../scripts/lib/ci-local-workflow";

describe("local CI workflow", () => {
  it("defaults to the full release gate and supports explicit modes", () => {
    expect(parseLocalCiOptions([])).toEqual({
      mode: "full",
      dryRun: false,
      reuseE2eBuild: false,
    });
    expect(parseLocalCiOptions(["--", "--quality", "--dry-run"])).toMatchObject({
      mode: "quality",
      dryRun: true,
    });
    expect(parseLocalCiOptions(["--e2e-only", "--reuse-e2e-build"])).toMatchObject({
      mode: "e2e-only",
      reuseE2eBuild: true,
    });
  });

  it("rejects conflicting modes and unknown options", () => {
    expect(() => parseLocalCiOptions(["--quality", "--full"])).toThrow(/exactly one/);
    expect(() => parseLocalCiOptions(["--quick"])).toThrow(/Unknown/);
  });

  it("resets a dedicated test database before one quality pass and adds E2E only for full mode", () => {
    const quality = buildLocalCiPlan(parseLocalCiOptions(["--quality"]));
    expect(quality.map((step) => step.label)).toEqual([
      "Ensure local services",
      "Reset disposable test database",
      "Apply test database migrations",
      "Generate Prisma client",
      "Lint",
      "Typecheck",
      "Unit and integration tests",
    ]);
    expect(quality.filter((step) => step.label === "Unit and integration tests")).toHaveLength(1);

    const full = buildLocalCiPlan(parseLocalCiOptions([]), 3277);
    expect(full).toHaveLength(8);
    expect(full[7]).toMatchObject({
      label: "Playwright E2E",
      env: {
        E2E_PORT: "3277",
        PLAYWRIGHT_BASE_URL: "http://localhost:3277",
        E2E_FORCE_FRESH_SERVER: "1",
        E2E_RESET_DB: "1",
        E2E_FORCE_BUILD: "1",
      },
    });
  });

  it("uses a reusable E2E build only when requested", () => {
    const [e2e] = buildLocalCiPlan(parseLocalCiOptions(["--e2e-only", "--reuse-e2e-build"]), 3201);
    expect(e2e.env?.E2E_FORCE_BUILD).toBe("0");
  });

  it("builds a bounded deterministic port search", () => {
    expect(buildPortCandidates(3200, 3)).toEqual([3200, 3201, 3202]);
    expect(() => buildPortCandidates(0)).toThrow(/Invalid/);
  });

  it("serializes E2E work with a portable directory lock", async () => {
    const parent = await mkdtemp(join(tmpdir(), "forge-ci-lock-test-"));
    const lockPath = join(parent, "e2e.lock");
    const release = await acquireDirectoryLock(lockPath);
    await expect(stat(lockPath)).resolves.toBeDefined();
    await expect(
      acquireDirectoryLock(lockPath, { timeoutMs: 5, pollMs: 1, staleMs: 60_000 }),
    ).rejects.toThrow(/Timed out/);
    await release();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(lockPath);
    const releaseStale = await acquireDirectoryLock(lockPath, { staleMs: -1 });
    await releaseStale();
  });
});
