/**
 * Repo identity + GitHub endpoints. Kept in a **Node-free** module (no
 * `node:fs`/`node:path`) so client components — e.g. the live star badge in
 * `components/github-stars.tsx` — can import these without dragging the
 * build-time file reads in `lib/releases.ts` into the browser bundle.
 */
export const REPO_OWNER = "Codename-11";
export const REPO_NAME = "Forge";
export const REPO_URL = "https://github.com/Codename-11/forge";
/** GitHub REST endpoint for the repo — used by the live star-count badge. */
export const GITHUB_API_REPO = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
