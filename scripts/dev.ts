import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { config as loadEnv } from "dotenv";
import {
  LOCAL_DATABASE_URL,
  formatLocalTarget,
  validateLocalTarget,
} from "./lib/local-data-target";
import {
  LOCAL_DEV,
  assertSafeLocalEnvironment,
  decidePrismaActions,
  parseWindowsPnpmEntry,
  parseDevOptions,
  servicesToStart,
  shouldSeedBase,
  type DevOptions,
  type ServiceState,
} from "./lib/dev-workflow";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = resolve(root, "docker", "docker-compose.yml");
loadEnv({ path: resolve(root, ".env.local"), override: false, quiet: true });

let options: DevOptions;
try {
  options = parseDevOptions(process.argv.slice(2));
  assertSafeLocalEnvironment(process.env);
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const env = {
  ...process.env,
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
  ADMIN_EMAIL: process.env.ADMIN_EMAIL ?? "owner@forge.local",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? "forge-dev",
  ADMIN_NAME: process.env.ADMIN_NAME ?? "Forge Owner",
  ADMIN_HANDLE: process.env.ADMIN_HANDLE ?? "forge",
  PLUGIN_JWT_SECRET: process.env.PLUGIN_JWT_SECRET ?? "dev-plugin-signing-key",
  PLUGIN_JWT_ISSUER: process.env.PLUGIN_JWT_ISSUER ?? "forge",
  PLUGIN_JWT_AUDIENCE: process.env.PLUGIN_JWT_AUDIENCE ?? "forge-plugins",
};

function resolvePnpm(): { command: string; prefix: string[] } {
  if (process.platform !== "win32") return { command: "pnpm", prefix: [] };
  const located = spawnSync("where.exe", ["pnpm.cmd"], { encoding: "utf8", shell: false });
  const wrapper = located.stdout?.split(/\r?\n/).find(Boolean);
  if (!wrapper) throw new Error("pnpm.cmd was not found on PATH");
  const contents = readFileSync(wrapper, "utf8");
  const entry = parseWindowsPnpmEntry(contents);
  if (!entry) throw new Error(`Could not resolve the pnpm JavaScript entry from ${wrapper}`);
  return { command: process.execPath, prefix: [resolve(dirname(wrapper), entry)] };
}

const pnpm = resolvePnpm();

function run(command: string, args: string[], capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.status !== 0)
    throw new Error(
      capture ? result.stderr || result.stdout : `${command} failed with exit ${result.status}`,
    );
  return result.stdout ?? "";
}

function runPnpm(args: string[], capture = false) {
  return run(pnpm.command, [...pnpm.prefix, ...args], capture);
}

function docker(args: string[], capture = false) {
  return run("docker", args, capture);
}

function inspectService(name: keyof typeof LOCAL_DEV.containers): ServiceState {
  const result = spawnSync(
    "docker",
    ["inspect", "--format", "{{json .State}}", LOCAL_DEV.containers[name]],
    { encoding: "utf8", shell: false },
  );
  if (result.status !== 0) return { exists: false, running: false, healthy: false };
  const state = JSON.parse(result.stdout) as { Running?: boolean; Health?: { Status?: string } };
  return {
    exists: true,
    running: Boolean(state.Running),
    healthy: state.Health?.Status === "healthy",
  };
}

async function ensureServices(startMissing: boolean) {
  const states = {
    postgres: inspectService("postgres"),
    redis: inspectService("redis"),
    minio: inspectService("minio"),
  };
  const needed = servicesToStart(states);
  if (needed.length > 0 && !startMissing)
    throw new Error(`Local services are not ready (${needed.join(", ")}); run pnpm dev:services`);
  if (needed.length > 0) {
    console.log(`[dev] Starting missing/stopped local services: ${needed.join(", ")}`);
    docker(["compose", "-f", composeFile, "up", "-d", ...needed]);
    console.log(`[dev] Started local services: ${needed.join(", ")}`);
  } else {
    console.log("[dev] Local services already running; preserved containers and volumes.");
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const current = [inspectService("postgres"), inspectService("redis"), inspectService("minio")];
    if (current.every((state) => state.running && state.healthy)) {
      console.log("[dev] Postgres, Redis, and MinIO are healthy.");
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  throw new Error(
    "Local services did not become healthy within 90s. Run `docker compose -f docker/docker-compose.yml ps` and inspect unhealthy container logs.",
  );
}

function clientNeedsGenerate(): boolean {
  try {
    const require = createRequire(import.meta.url);
    const clientEntry = require.resolve("@prisma/client");
    const generatedClient = resolve(
      dirname(clientEntry),
      "..",
      "..",
      ".prisma",
      "client",
      "index.d.ts",
    );
    return (
      statSync(resolve(root, "prisma", "schema.prisma")).mtimeMs > statSync(generatedClient).mtimeMs
    );
  } catch {
    return true;
  }
}

function reconcileSchema() {
  const status = spawnSync(pnpm.command, [...pnpm.prefix, "exec", "prisma", "migrate", "status"], {
    cwd: root,
    env,
    encoding: "utf8",
    shell: false,
  });
  const combined = `${status.stdout ?? ""}\n${status.stderr ?? ""}`;
  const actions = decidePrismaActions({
    migrationsCurrent: status.status === 0 && combined.includes("Database schema is up to date"),
    clientCurrent: !clientNeedsGenerate(),
  });
  if (actions.deploy) {
    console.log("[dev] Pending LOCAL Prisma migrations detected; applying them now.");
    runPnpm(["exec", "prisma", "migrate", "deploy"]);
    console.log("[dev] Applied pending LOCAL Prisma migrations.");
  } else console.log("[dev] Local database schema already current; skipped migrate deploy.");
  if (actions.generate) {
    console.log("[dev] Prisma schema/client drift detected; generating the local client.");
    runPnpm(["exec", "prisma", "generate"]);
    console.log("[dev] Generated the local Prisma client.");
  } else console.log("[dev] Prisma client already current; skipped generate.");
}

function workspaceCount(): number {
  const output = docker(
    [
      "exec",
      LOCAL_DEV.containers.postgres,
      "psql",
      "-U",
      "forge",
      "-d",
      "forge",
      "-tAc",
      'SELECT count(*) FROM "Workspace";',
    ],
    true,
  );
  return Number(output.trim());
}

function seedBaseIfEmpty() {
  const count = workspaceCount();
  if (shouldSeedBase(count)) {
    console.log("[dev] Local database is empty; seeding the stable base fixture.");
    runPnpm(["exec", "tsx", "prisma/seed.ts"]);
    console.log("[dev] Seeded the stable base fixture.");
  } else console.log(`[dev] Local database contains ${count} workspace(s); skipped base seed.`);
}

async function confirm(message: string, phrase: string) {
  if (options.yes) return;
  if (!process.stdin.isTTY)
    throw new Error(
      `Confirmation requires a terminal; rerun interactively or pass --yes. Expected phrase: ${phrase}`,
    );
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`${message}\nType '${phrase}' to continue: `);
  prompt.close();
  if (answer !== phrase) throw new Error("Canceled; local data was not changed.");
}

async function resetLocal() {
  console.log(
    `[dev] DESTRUCTIVE target: ${formatLocalTarget(validateLocalTarget(LOCAL_DATABASE_URL))}`,
  );
  await confirm("This drops and recreates the LOCAL public schema.", "reset local forge");
  docker([
    "exec",
    LOCAL_DEV.containers.postgres,
    "psql",
    "-U",
    "forge",
    "-d",
    "forge",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
  ]);
  console.log(
    "[dev] Reset local database schema; containers, volumes, and Turbopack cache were preserved.",
  );
}

async function refreshLocal() {
  const host = process.env.FORGE_PROD_SSH_HOST ?? "docker-server.local";
  const remoteEnv = process.env.FORGE_PROD_ENV_FILE ?? "/home/bailey/docker/forge/.env";
  const remoteContainer = process.env.FORGE_PROD_DB_CONTAINER ?? "forge-postgres";
  if (remoteContainer.startsWith("forge-dev-"))
    throw new Error("Production source container cannot be a local development container");
  console.log(
    `[dev:refresh] READ-ONLY source: ssh://${host} container=${remoteContainer} database=forge`,
  );
  console.log(
    `[dev:refresh] DESTRUCTIVE target: ${formatLocalTarget(validateLocalTarget(LOCAL_DATABASE_URL))}`,
  );
  console.log(
    "[dev:refresh] MinIO object bytes are not copied; only attachment metadata is present.",
  );
  if (options.dryRun) {
    console.log(
      "[dev:refresh] DRY RUN — would start/verify local services, stream pg_dump directly into local psql, then apply local migrations. No service or database was changed.",
    );
    return;
  }
  await ensureServices(true);
  await confirm(
    "This replaces the LOCAL forge database from a read-only production dump.",
    "replace local forge",
  );
  const remote = `set -eu; test -f '${remoteEnv}'; set -a; . '${remoteEnv}'; set +a; exec docker exec -e PGPASSWORD=\"$POSTGRES_PASSWORD\" '${remoteContainer}' pg_dump -U forge -d forge --no-owner --no-acl --clean --if-exists`;
  await new Promise<void>((resolvePipe, reject) => {
    const source = spawn("ssh", [host, remote], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "inherit"],
      shell: false,
    });
    const target = spawn(
      "docker",
      [
        "exec",
        "-i",
        "-e",
        "PGPASSWORD=forge",
        LOCAL_DEV.containers.postgres,
        "psql",
        "-U",
        "forge",
        "-d",
        "forge",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { cwd: root, env, stdio: ["pipe", "inherit", "inherit"], shell: false },
    );
    source.stdout.pipe(target.stdin);
    let sourceCode: number | null = null;
    let targetCode: number | null = null;
    const finish = () => {
      if (sourceCode === null || targetCode === null) return;
      if (sourceCode === 0 && targetCode === 0) resolvePipe();
      else
        reject(
          new Error(
            `Refresh stream failed (ssh=${sourceCode}, local psql=${targetCode}). Local data may be partial; rerun pnpm dev:refresh or pnpm dev:reset.`,
          ),
        );
    };
    source.on("error", reject);
    target.on("error", reject);
    source.on("close", (code) => {
      sourceCode = code;
      finish();
    });
    target.on("close", (code) => {
      targetCode = code;
      finish();
    });
  });
  reconcileSchema();
  console.log(
    "[dev:refresh] Refreshed the fixed local database. Run pnpm dev:app for the fastest restart.",
  );
}

function printEndpoints() {
  console.log("[dev] Selected local endpoints:");
  console.log("      app      http://localhost:3000");
  console.log("      postgres localhost:55432 database=forge user=forge");
  console.log("      redis    localhost:56379");
  console.log("      minio    http://localhost:59000 (console :59001)");
  console.log(`      login    ${env.ADMIN_EMAIL} / ${env.ADMIN_PASSWORD}`);
}

function dryRunLocal() {
  const states = {
    postgres: inspectService("postgres"),
    redis: inspectService("redis"),
    minio: inspectService("minio"),
  };
  const needed = servicesToStart(states);
  console.log(
    needed.length > 0
      ? `[dev] DRY RUN — would start local services: ${needed.join(", ")}`
      : "[dev] DRY RUN — all local services are already running.",
  );
  if (states.postgres.healthy) {
    const status = spawnSync(
      pnpm.command,
      [...pnpm.prefix, "exec", "prisma", "migrate", "status"],
      { cwd: root, env, encoding: "utf8", shell: false },
    );
    const migrationsCurrent = `${status.stdout ?? ""}\n${status.stderr ?? ""}`.includes(
      "Database schema is up to date",
    );
    const actions = decidePrismaActions({
      migrationsCurrent: status.status === 0 && migrationsCurrent,
      clientCurrent: !clientNeedsGenerate(),
    });
    console.log(
      `[dev] DRY RUN — migrate deploy: ${actions.deploy ? "needed" : "skip"}; prisma generate: ${actions.generate ? "needed" : "skip"}.`,
    );
    if (!actions.deploy)
      console.log(
        `[dev] DRY RUN — base seed: ${shouldSeedBase(workspaceCount()) ? "needed" : "skip"}.`,
      );
  } else {
    console.log("[dev] DRY RUN — schema and seed decisions require healthy local Postgres.");
  }
  printEndpoints();
  console.log("[dev] DRY RUN — would launch host-native next dev --turbo. Nothing was changed.");
}

function launchApp() {
  printEndpoints();
  console.log("[dev] Launching host-native next dev --turbo; preserving .next Turbopack cache.");
  runPnpm(["exec", "next", "dev", "--turbo"]);
}

async function main() {
  if (options.mode === "refresh") return refreshLocal();
  if (options.dryRun) return dryRunLocal();
  await ensureServices(options.mode !== "app");
  if (options.mode === "services") {
    printEndpoints();
    return;
  }
  if (options.fresh) await resetLocal();
  if (options.mode !== "app") {
    reconcileSchema();
    seedBaseIfEmpty();
  }
  if (options.mode === "scenario") {
    runPnpm([
      "exec",
      "tsx",
      "scripts/seed-scenarios.ts",
      "--scenarios",
      options.scenario!,
      "--scale",
      String(options.scale),
    ]);
  }
  launchApp();
}

main().catch((error) => {
  console.error(`[dev] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
