import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Persistent auth state for the Forge CLI.
 *
 * Lives at ~/.config/forge/auth.json with mode 600. The single file holds
 * everything the CLI needs to talk to a Forge instance: server URL, the
 * bearer token (a Forge ApiKey, ideally an AGENT-kind one with
 * linkedAgentId set), and the workspace slug used to scope tRPC calls.
 *
 * The daemon side persists its registered Runtime.id separately in
 * daemon.json (see daemon.ts) so a reboot dedupes against the same row
 * rather than spawning a fresh Runtime per restart.
 */

export const AuthFileSchema = z.object({
  url: z.string().url(),
  token: z.string().min(1),
  workspaceSlug: z.string().min(1),
});

export type AuthFile = z.infer<typeof AuthFileSchema>;

export function configDir(): string {
  return path.join(os.homedir(), ".config", "forge");
}

export function authPath(): string {
  return path.join(configDir(), "auth.json");
}

export async function readAuth(): Promise<AuthFile | null> {
  try {
    const raw = await fs.readFile(authPath(), "utf8");
    const parsed = AuthFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function writeAuth(auth: AuthFile): Promise<void> {
  const dir = configDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = authPath();
  // Write with explicit mode in the open call so the file is never world-
  // readable even momentarily — chmod-after-write leaves a one-tick window.
  const handle = await fs.open(file, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(auth, null, 2) + "\n", "utf8");
  } finally {
    await handle.close();
  }
  // Re-assert mode in case umask masked the create flag.
  await fs.chmod(file, 0o600);
}

export async function requireAuth(): Promise<AuthFile> {
  const a = await readAuth();
  if (!a) {
    throw new Error(
      "Not logged in. Run `forge login --url <url> --workspace <slug> --token <token>` first.",
    );
  }
  return a;
}
