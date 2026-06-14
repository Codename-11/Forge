import "server-only";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { router, protectedProcedure } from "@/server/trpc";
import { forgeBuildIdentity } from "@/server/build-info";

/**
 * System-wide read-only data — currently just the parsed CHANGELOG.md
 * for the dashboard's "What's New" rail. Stays workspace-procedure-
 * scoped so the proc requires authentication, even though the data
 * isn't tenant-specific (the changelog is the same for every
 * workspace).
 *
 * Caching: we keep a process-memory cache keyed off the file's mtime
 * so each container reads the file once per boot (and re-reads if it
 * changes on disk, e.g. a hot-reload during dev). No DB column.
 */

interface ChangelogItem {
  type: "added" | "changed" | "fixed" | "removed";
  text: string;
}

interface ChangelogEntry {
  version: string;
  date: string | null;
  /** Original `## [version] — heading-tail` so the page can show
   *  the full release name as a heading. */
  heading: string;
  items: ChangelogItem[];
  /** Raw markdown body for `whats-new/page.tsx` to render. */
  raw: string;
}

interface CachedChangelog {
  mtimeMs: number;
  entries: ChangelogEntry[];
  rawBody: string;
}

let _cache: CachedChangelog | null = null;
function changelogPath(): string {
  return path.join(process.cwd(), "CHANGELOG.md");
}

async function readChangelog(): Promise<CachedChangelog> {
  const file = changelogPath();
  let stat: { mtimeMs: number };
  try {
    stat = await fs.stat(file);
  } catch {
    // File missing — return empty payload but cache it so we don't
    // hammer the FS on every request.
    const empty: CachedChangelog = { mtimeMs: 0, entries: [], rawBody: "" };
    _cache = empty;
    return empty;
  }
  if (_cache && _cache.mtimeMs === stat.mtimeMs) return _cache;
  const raw = await fs.readFile(file, "utf8");
  const entries = parseChangelog(raw);
  _cache = { mtimeMs: stat.mtimeMs, entries, rawBody: raw };
  return _cache;
}

/**
 * Best-effort Keep-a-Changelog parser. Recognizes `## [version] —
 * tail` headings (with `—` or `-` separators) and `### Added` /
 * `### Changed` / `### Fixed` / `### Removed` subheadings whose
 * bullets become items. Unknown subsections are ignored. The full
 * raw section is preserved on the entry for the whats-new page to
 * render with markdown.
 */
function parseChangelog(raw: string): ChangelogEntry[] {
  const lines = raw.split(/\r?\n/);
  const entries: ChangelogEntry[] = [];
  let cur: ChangelogEntry | null = null;
  let curRaw: string[] = [];
  let curSubtype: ChangelogItem["type"] | null = null;

  const flush = () => {
    if (cur) {
      cur.raw = curRaw.join("\n").trim();
      entries.push(cur);
    }
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim();
      const bracketMatch = heading.match(/^\[([^\]]+)\](?:\s+[—-]\s+(.+))?$/);
      const plainMatch = bracketMatch ? null : heading.match(/^(.+?)(?:\s+[—-]\s+(.+))?$/);
      const version = (bracketMatch?.[1] ?? plainMatch?.[1])?.trim();
      if (!version) continue;
      flush();
      const tail = (bracketMatch?.[2] ?? plainMatch?.[2])?.trim() ?? "";
      // Heuristic: a leading ISO date in version (e.g. `2026-05-04`)
      // counts as the date; otherwise keep null.
      const dateMatch = version.match(/^\d{4}-\d{2}-\d{2}$/);
      cur = {
        version,
        date: dateMatch ? version : null,
        heading: tail ? `${version} — ${tail}` : version,
        items: [],
        raw: "",
      };
      curRaw = [];
      curSubtype = null;
      continue;
    }

    if (!cur) continue;
    curRaw.push(line);

    const subMatch = line.match(/^###\s+(Added|Changed|Fixed|Removed)\b/i);
    if (subMatch) {
      curSubtype = subMatch[1].toLowerCase() as ChangelogItem["type"];
      continue;
    }

    const bulletMatch = line.match(/^\s*-\s+(.+?)\s*$/);
    if (bulletMatch && curSubtype) {
      // First-line text only; if the bullet wraps to subsequent
      // lines we'll lose the wrap detail — that's fine for the rail
      // (the whats-new page renders the raw body anyway).
      const text = bulletMatch[1]
        // Strip simple emphasis so the rail stays compact.
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1");
      cur.items.push({ type: curSubtype, text });
    }
  }

  flush();
  // Drop the "Unreleased" section from the structured entries: it's not a
  // shipped release, so it shouldn't head the What's New rail or be counted
  // as the latest version (buildInfo.release already filters by date). Its
  // content still appears in the full raw body on the /whats-new page.
  return entries.filter((e) => e.version.toLowerCase() !== "unreleased");
}

export const systemRouter = router({
  changelog: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(20).default(5),
        })
        .default({ limit: 5 }),
    )
    .query(async ({ input }) => {
      const cache = await readChangelog();
      return {
        entries: cache.entries.slice(0, input.limit),
        total: cache.entries.length,
      };
    }),

  /** Full changelog body for the `/whats-new` page renderer. */
  changelogFull: protectedProcedure.query(async () => {
    const cache = await readChangelog();
    return { rawBody: cache.rawBody, entries: cache.entries };
  }),

  /**
   * Build identity — the precise "what's running" anchor for support + "is my
   * fix live?". `gitSha` + `buildTime` are baked at `docker compose build`
   * (deploy ritual); `release` is the latest curated CHANGELOG date (the
   * human-facing version); `version` is the coarse package.json major.
   */
  buildInfo: protectedProcedure.query(async () => {
    const cache = await readChangelog();
    const build = await forgeBuildIdentity();
    return {
      ...build,
      release: cache.entries.find((e) => e.date)?.version ?? null,
    };
  }),
});

/** Test helper — drops the in-process cache. Not exported via tRPC. */
export function _resetChangelogCache(): void {
  _cache = null;
}
