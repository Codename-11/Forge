import { describe, expect, it } from "vitest";
import {
  LOCAL_DEV,
  assertSafeLocalEnvironment,
  decideDevDryRun,
  decidePrismaActions,
  parseWindowsPnpmEntry,
  parseDevOptions,
  servicesToStart,
  shouldSeedBase,
} from "../../scripts/lib/dev-workflow";

describe("safe local dev command decisions", () => {
  it("defaults to the intelligent local start and parses scenario/reset controls", () => {
    expect(parseDevOptions([])).toMatchObject({ mode: "start", fresh: false });
    expect(parseDevOptions(["start", "--", "--fresh", "--yes"])).toMatchObject({
      fresh: true,
      yes: true,
    });
    expect(parseDevOptions(["start", "--fresh", "--yes"])).toMatchObject({
      fresh: true,
      yes: true,
    });
    expect(
      parseDevOptions(["scenario", "delivery-github,status-freshness", "--scale", "3"]),
    ).toMatchObject({ mode: "scenario", scenario: "delivery-github,status-freshness", scale: 3 });
  });

  it("rejects missing scenarios, invalid scale, and unknown options", () => {
    expect(() => parseDevOptions(["scenario"])).toThrow(/requires a scenario/);
    expect(() => parseDevOptions(["scenario", "tenancy", "--scale", "0"])).toThrow(/1-100/);
    expect(() => parseDevOptions(["start", "--mystery"])).toThrow(/Unknown/);
  });

  it("hard-guards production-like endpoints and container overrides", () => {
    expect(() => assertSafeLocalEnvironment({ DATABASE_URL: LOCAL_DEV.databaseUrl })).not.toThrow();
    expect(() =>
      assertSafeLocalEnvironment({ DATABASE_URL: "postgresql://forge@prod/forge" }),
    ).toThrow(/non-local/);
    expect(() => assertSafeLocalEnvironment({ S3_ENDPOINT: "https://forge-s3.example" })).toThrow(
      /non-local/,
    );
    expect(() =>
      assertSafeLocalEnvironment({ FORGE_LOCAL_POSTGRES_CONTAINER: "forge-postgres" }),
    ).toThrow(/guarded local container/);
  });

  it("starts only missing or stopped services", () => {
    expect(
      servicesToStart({
        postgres: { exists: true, running: true, healthy: true },
        redis: { exists: true, running: false, healthy: false },
        minio: { exists: false, running: false, healthy: false },
      }),
    ).toEqual(["redis", "minio"]);
  });

  it("keeps dry-run decisions aligned with each command mode", () => {
    const ready = {
      postgres: { exists: true, running: true, healthy: true },
      redis: { exists: true, running: true, healthy: true },
      minio: { exists: true, running: true, healthy: true },
    };
    const missingRedis = {
      ...ready,
      redis: { exists: false, running: false, healthy: false },
    };
    expect(decideDevDryRun(parseDevOptions(["services", "--dry-run"]), missingRedis)).toMatchObject({
      startServices: ["redis"],
      reconcileSchema: false,
      launchApp: false,
    });
    expect(decideDevDryRun(parseDevOptions(["app", "--dry-run"]), missingRedis)).toMatchObject({
      startServices: [],
      unavailableServices: ["redis"],
      reconcileSchema: false,
      launchApp: true,
    });
    expect(decideDevDryRun(parseDevOptions(["reset", "--dry-run"]), ready)).toMatchObject({
      resetDatabase: true,
      reconcileSchema: true,
      launchApp: true,
    });
    expect(
      decideDevDryRun(parseDevOptions(["scenario", "tenancy", "--dry-run"]), ready),
    ).toMatchObject({ seedScenario: true, reconcileSchema: true, launchApp: true });
  });

  it("resolves pnpm and Corepack JavaScript entries from Windows shims", () => {
    expect(parseWindowsPnpmEntry('node "%~dp0\\pnpm.mjs" %*')).toBe("pnpm.mjs");
    expect(parseWindowsPnpmEntry('node "%~dp0\\node_modules\\corepack\\dist\\pnpm.js" %*')).toBe(
      "node_modules\\corepack\\dist\\pnpm.js",
    );
  });

  it("runs only necessary Prisma and seed work", () => {
    expect(decidePrismaActions({ migrationsCurrent: true, clientCurrent: true })).toEqual({
      deploy: false,
      generate: false,
    });
    expect(decidePrismaActions({ migrationsCurrent: false, clientCurrent: true })).toEqual({
      deploy: true,
      generate: false,
    });
    expect(shouldSeedBase(0)).toBe(true);
    expect(shouldSeedBase(2)).toBe(false);
  });
});
