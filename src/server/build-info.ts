import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";

let packageVersionCache: string | null | undefined;

export type ForgeBuildIdentity = {
  version: string;
  gitSha: string | null;
  buildTime: string | null;
};

export async function readPackageVersion(): Promise<string> {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  if (packageVersionCache !== undefined) return packageVersionCache ?? "1.0.0";
  try {
    const raw = await fs.readFile(path.join(process.cwd(), "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    packageVersionCache = typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    packageVersionCache = null;
  }
  return packageVersionCache ?? "1.0.0";
}

export async function forgeBuildIdentity(): Promise<ForgeBuildIdentity> {
  return {
    version: await readPackageVersion(),
    gitSha: process.env.FORGE_GIT_SHA || null,
    buildTime: process.env.FORGE_BUILD_TIME || null,
  };
}

export async function mcpServerInfo(): Promise<
  ForgeBuildIdentity & { name: "forge"; title: "Forge" }
> {
  return {
    name: "forge",
    title: "Forge",
    ...(await forgeBuildIdentity()),
  };
}

export function _resetBuildInfoCacheForTests(): void {
  packageVersionCache = undefined;
}
