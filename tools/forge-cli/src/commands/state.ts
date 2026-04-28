import { promises as fs } from "node:fs";
import path from "node:path";
import { configDir } from "../auth.js";

/**
 * Read-only view of the daemon state file (written by daemon.ts).
 * Lives here so commands like `whoami` and `runtimes list` can show
 * registration info without importing the daemon module (and pulling in
 * its side-effecting imports like `eventsource`).
 */

export interface DaemonState {
  runtimeId: string;
  url: string;
  workspaceSlug: string;
  hostname: string;
}

export function statePath(): string {
  return path.join(configDir(), "daemon.json");
}

export async function readState(): Promise<DaemonState | null> {
  try {
    const raw = await fs.readFile(statePath(), "utf8");
    return JSON.parse(raw) as DaemonState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
