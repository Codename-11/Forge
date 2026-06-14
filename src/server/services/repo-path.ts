/**
 * Derive a safe, relative clone path from a git remote URL — the last path
 * segment (the repo name), minus a trailing `.git`, sanitized to the same
 * charset `RuntimeRepo.path` allows. Used so a per-project repo materializes
 * at a predictable directory under the runtime's workspace root.
 *
 *   https://github.com/acme/forge.git   → "forge"
 *   git@github.com:acme/forge.git       → "forge"
 *   https://example.com/x/y/repo        → "repo"
 *
 * Returns "" if nothing usable can be derived (caller should skip it).
 */
export function deriveRepoPath(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  // Take the segment after the last `/` or `:` (scp-style ssh).
  const tail = trimmed.split(/[/:]/).pop() ?? "";
  const name = tail.replace(/\.git$/i, "");
  // Keep only the safe charset; collapse anything else to nothing.
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "");
  return safe;
}
