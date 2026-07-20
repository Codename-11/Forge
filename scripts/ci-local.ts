import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireDirectoryLock,
  buildLocalCiPlan,
  buildPortCandidates,
  findAvailablePort,
  parseLocalCiOptions,
  type LocalCiStep,
} from "./lib/ci-local-workflow";
import { LOCAL_DEV, assertSafeLocalEnvironment, parseWindowsPnpmEntry } from "./lib/dev-workflow";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function resolvePnpm(): { command: string; prefix: string[] } {
  if (process.platform !== "win32") return { command: "pnpm", prefix: [] };
  const located = spawnSync("where.exe", ["pnpm.cmd"], { encoding: "utf8", shell: false });
  const wrapper = located.stdout?.split(/\r?\n/).find(Boolean);
  if (!wrapper) throw new Error("pnpm.cmd was not found on PATH");
  const entry = parseWindowsPnpmEntry(readFileSync(wrapper, "utf8"));
  if (!entry) throw new Error(`Could not resolve the pnpm JavaScript entry from ${wrapper}`);
  return { command: process.execPath, prefix: [resolve(dirname(wrapper), entry)] };
}

function formatStep(step: LocalCiStep): string {
  const env = Object.entries(step.env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return `${env ? `${env} ` : ""}pnpm ${step.args.join(" ")}`;
}

const localCiEnv: Record<string, string> = {
  DATABASE_URL: LOCAL_DEV.databaseUrl,
  REDIS_URL: LOCAL_DEV.redisUrl,
  S3_ENDPOINT: LOCAL_DEV.s3Endpoint,
  S3_PUBLIC_ENDPOINT: LOCAL_DEV.s3Endpoint,
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "forgeminio",
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "forgeminio-dev-password",
  S3_FORCE_PATH_STYLE: "true",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "dev-local-secret-changeme-32bytes!!",
  AUTH_URL: process.env.AUTH_URL_DEV ?? "http://localhost:3000",
  NEXT_PUBLIC_APP_URL: process.env.AUTH_URL_DEV ?? "http://localhost:3000",
  AUTH_TRUST_HOST: "true",
  PLUGIN_JWT_SECRET: process.env.PLUGIN_JWT_SECRET ?? "dev-plugin-signing-key",
  PLUGIN_JWT_ISSUER: process.env.PLUGIN_JWT_ISSUER ?? "forge",
  PLUGIN_JWT_AUDIENCE: process.env.PLUGIN_JWT_AUDIENCE ?? "forge-plugins",
};

function runStep(step: LocalCiStep, pnpm: { command: string; prefix: string[] }): void {
  const startedAt = Date.now();
  console.log(`\n[ci:local] ${step.label}\n[ci:local] $ ${formatStep(step)}`);
  const result = spawnSync(pnpm.command, [...pnpm.prefix, ...step.args], {
    cwd: root,
    env: { ...process.env, ...localCiEnv, ...step.env },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${step.label} failed with exit ${result.status ?? "unknown"}.`);
  }
  console.log(
    `[ci:local] ${step.label} passed in ${Math.round((Date.now() - startedAt) / 1000)}s.`,
  );
}

async function main(): Promise<void> {
  const options = parseLocalCiOptions(process.argv.slice(2));
  assertSafeLocalEnvironment(process.env);
  const needsE2e = options.mode !== "quality";
  const preferredE2ePort = Number(process.env.E2E_PORT ?? 3200);
  if (needsE2e) buildPortCandidates(preferredE2ePort, 1);

  if (options.dryRun) {
    const plan = buildLocalCiPlan(options, preferredE2ePort);
    console.log(
      `[ci:local] mode=${options.mode}${needsE2e ? ` preferredE2ePort=${preferredE2ePort}` : ""}${options.reuseE2eBuild ? " reuseBuild=true" : ""}`,
    );
    for (const step of plan) console.log(`[ci:local] ${step.label}: ${formatStep(step)}`);
    return;
  }

  const pnpm = resolvePnpm();
  console.log(`[ci:local] mode=${options.mode}${options.reuseE2eBuild ? " reuseBuild=true" : ""}`);
  const quality = buildLocalCiPlan(options).filter(
    (candidate) => candidate.label !== "Playwright E2E",
  );
  for (const step of quality) {
    runStep(step, pnpm);
  }
  if (!needsE2e) return;

  const lockPath = join(tmpdir(), "forge-e2e.lock");
  const releaseLock = await acquireDirectoryLock(lockPath, {
    onWait: (owner) => {
      const detail = owner ? ` (PID ${owner.pid} on ${owner.host})` : "";
      console.log(`[ci:local] Waiting for another Forge E2E run${detail}…`);
    },
  });
  try {
    const e2ePort = await findAvailablePort(preferredE2ePort);
    const e2e = buildLocalCiPlan(options, e2ePort).find(
      (candidate) => candidate.label === "Playwright E2E",
    );
    if (!e2e) throw new Error("The local CI plan did not contain its expected E2E step.");
    console.log(`[ci:local] Acquired E2E lock; using port ${e2ePort}.`);
    runStep(e2e, pnpm);
  } finally {
    await releaseLock();
  }
}

main().catch((error) => {
  console.error(`[ci:local] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
