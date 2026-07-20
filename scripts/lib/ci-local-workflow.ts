import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { hostname } from "node:os";

export type LocalCiMode = "quality" | "full" | "e2e-only";

export type LocalCiOptions = {
  mode: LocalCiMode;
  dryRun: boolean;
  reuseE2eBuild: boolean;
};

export type LocalCiStep = {
  label: string;
  args: string[];
  env?: Record<string, string>;
};

export function parseLocalCiOptions(argv: string[]): LocalCiOptions {
  let mode: LocalCiMode = "full";
  let modeWasSet = false;
  let dryRun = false;
  let reuseE2eBuild = false;

  for (const value of argv.filter((arg) => arg !== "--")) {
    const requestedMode =
      value === "--quality"
        ? "quality"
        : value === "--full"
          ? "full"
          : value === "--e2e-only"
            ? "e2e-only"
            : undefined;
    if (requestedMode) {
      if (modeWasSet && mode !== requestedMode) {
        throw new Error("Choose exactly one of --quality, --full, or --e2e-only.");
      }
      mode = requestedMode;
      modeWasSet = true;
    } else if (value === "--dry-run") {
      dryRun = true;
    } else if (value === "--reuse-e2e-build") {
      reuseE2eBuild = true;
    } else {
      throw new Error(`Unknown local CI option: ${value}`);
    }
  }

  return { mode, dryRun, reuseE2eBuild };
}

export function buildLocalCiPlan(options: LocalCiOptions, e2ePort = 3200): LocalCiStep[] {
  const quality: LocalCiStep[] = [
    { label: "Ensure local services", args: ["dev:services"] },
    { label: "Generate Prisma client", args: ["prisma:generate"] },
    { label: "Lint", args: ["lint"] },
    { label: "Typecheck", args: ["typecheck"] },
    { label: "Unit and integration tests", args: ["test", "--no-file-parallelism"] },
  ];
  const e2e: LocalCiStep = {
    label: "Playwright E2E",
    args: ["exec", "playwright", "test", "--workers=1"],
    env: {
      E2E_PORT: String(e2ePort),
      PLAYWRIGHT_BASE_URL: `http://localhost:${e2ePort}`,
      E2E_FORCE_FRESH_SERVER: "1",
      E2E_RESET_DB: "1",
      E2E_FORCE_BUILD: options.reuseE2eBuild ? "0" : "1",
    },
  };

  if (options.mode === "quality") return quality;
  if (options.mode === "e2e-only") return [e2e];
  return [...quality, e2e];
}

export function buildPortCandidates(preferred: number, count = 100): number[] {
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65_535) {
    throw new Error(`Invalid preferred E2E port: ${preferred}`);
  }
  return Array.from({ length: count }, (_, index) => preferred + index).filter(
    (port) => port <= 65_535,
  );
}

async function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export async function findAvailablePort(preferred = 3200): Promise<number> {
  for (const port of buildPortCandidates(preferred)) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No available E2E port found from ${preferred} through ${preferred + 99}.`);
}

type LockOwner = { pid: number; host: string; acquiredAt: string };

export async function acquireDirectoryLock(
  lockPath: string,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    staleMs?: number;
    onWait?: (owner?: LockOwner) => void;
  } = {},
): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const pollMs = options.pollMs ?? 1_000;
  const staleMs = options.staleMs ?? 12 * 60 * 60_000;
  const startedAt = Date.now();
  let announcedWait = false;

  while (true) {
    try {
      await mkdir(lockPath);
      const owner: LockOwner = {
        pid: process.pid,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
      };
      await writeFile(`${lockPath}/owner.json`, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let owner: LockOwner | undefined;
    try {
      owner = JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8")) as LockOwner;
    } catch {
      // A contender can observe the directory before owner.json is written.
    }

    let lockAge: number;
    try {
      lockAge = Date.now() - (await stat(lockPath)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (lockAge > staleMs) {
      try {
        await rm(lockPath, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    if (!announcedWait) {
      options.onWait?.(owner);
      announcedWait = true;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      const detail = owner ? ` held by PID ${owner.pid} on ${owner.host}` : "";
      throw new Error(`Timed out waiting for local E2E lock ${lockPath}${detail}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
