/**
 * Real release data for the landing site, sourced from the repo at BUILD TIME.
 *
 * The landing lives inside the Forge repo, so at build we read the canonical
 * version from `../package.json` and the curated changelog from
 * `../CHANGELOG.md` (the same file the app's "What's New" rail reads). This
 * keeps the site accurate on every rebuild without hand-maintained copy.
 *
 * The repo is public, so the live star count is fetched client-side at runtime
 * (see `components/github-stars.tsx`, which hits `GITHUB_API_REPO`). Version and
 * changelog stay build-time-from-repo — they only change on a release.
 *
 * Everything degrades to a baked-in real fallback if the repo files aren't
 * found (e.g. the landing built in isolation), so the build never breaks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Release = {
  v: string;
  date: string;
  tag: "patch" | "minor" | "major";
  title: string;
  bullets: string[];
};

// Repo identity / GitHub endpoints live in a Node-free module so the client
// star badge can import them without pulling this file's build-time fs reads.
export { REPO_URL, REPO_OWNER, REPO_NAME, GITHUB_API_REPO } from "./repo";

// ── repo file access (build-time only) ──────────────────────────────────────
function repoFile(name: string): string | null {
  for (const base of [join(process.cwd(), ".."), process.cwd(), join(process.cwd(), "..", "..")]) {
    try {
      return readFileSync(join(base, name), "utf8");
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function tagFor(v: string): Release["tag"] {
  const [maj, min, pat] = v.replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  if ((pat ?? 0) > 0) return "patch";
  if ((min ?? 0) > 0) return "minor";
  return maj >= 1 ? "major" : "minor";
}

// ── changelog parser ────────────────────────────────────────────────────────
// Headings look like:  ## [2026-06-09] — v0.7.0 · Chat runtime controls
function parseChangelog(md: string): Release[] {
  const out: Release[] = [];
  let cur: Release | null = null;
  for (const line of md.split("\n")) {
    const h = line.match(/^##\s+\[(\d{4}-\d{2}-\d{2})\]\s*[—-]\s*(v\d+\.\d+\.\d+)\s*·?\s*(.*)$/);
    if (h) {
      if (cur) out.push(cur);
      const [, date, v, title] = h;
      cur = { v, date: fmtDate(date), tag: tagFor(v), title: title.trim() || v, bullets: [] };
      continue;
    }
    if (line.startsWith("## ")) {
      // Unreleased / other section — close the current release.
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    if (cur && cur.bullets.length < 6) {
      const b = line.match(/^\s*-\s+(.+)$/);
      if (b) {
        const bold = b[1].match(/^\*\*(.+?)\*\*/);
        const text = (bold ? bold[1] : b[1].replace(/\*\*/g, "")).trim().replace(/[.:]\s*$/, "");
        if (text) cur.bullets.push(text);
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ── baked fallback (real values, used only if repo files are unavailable) ────
const FALLBACK: Release[] = [
  { v: "v0.7.0", date: "Jun 9, 2026", tag: "minor", title: "Chat runtime controls", bullets: ["Runtime model and mode controls", "Conversation-level YOLO overrides", "Workspace default issue assignee"] },
  { v: "v0.6.0", date: "Jun 9, 2026", tag: "minor", title: "GitHub support and sprint planning", bullets: ["Shared GitHub Apps for runtime git auth", "Per-project repositories", "Sprint planning"] },
  { v: "v0.5.1", date: "Jun 6, 2026", tag: "patch", title: "Android PWA install and push", bullets: ["Installable Android PWA", "Web push notifications"] },
  { v: "v0.5.0", date: "Jun 6, 2026", tag: "minor", title: "Agent runroom views", bullets: ["Agent runroom", "Live run streaming"] },
  { v: "v0.4.2", date: "Jun 3, 2026", tag: "patch", title: "Build version reporting", bullets: ["Build identity in Settings → About"] },
];

// ── resolved data (computed once at module load = build time) ────────────────
const changelog = repoFile("CHANGELOG.md");
const parsed = changelog ? parseChangelog(changelog) : [];
const all = parsed.length ? parsed : FALLBACK;

function pkgVersion(): string {
  const raw = repoFile("package.json");
  if (raw) {
    try {
      const v = JSON.parse(raw).version;
      if (typeof v === "string" && v) return v;
    } catch {
      /* fall through */
    }
  }
  return (all[0]?.v ?? "v0.7.0").replace(/^v/, "");
}

/** Canonical version, e.g. "0.7.0". */
export const SITE_VERSION = pkgVersion();
/** "v0.7.0" */
export const VERSION_LABEL = `v${SITE_VERSION}`;
/** "v0.7" — major.minor, for the compact nav badge. */
export const VERSION_SHORT = `v${SITE_VERSION.split(".").slice(0, 2).join(".")}`;
/** Most recent release (for the hero / footer "latest" lines). */
export const LATEST_RELEASE: Release = all[0] ?? FALLBACK[0];

/** Latest 3 — landing changelog preview. */
export const RELEASES: Release[] = all.slice(0, 3);
/** Up to 10 — the full /releases page. */
export const RELEASES_ALL: Release[] = all.slice(0, 10);
